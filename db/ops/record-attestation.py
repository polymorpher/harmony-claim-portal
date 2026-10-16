#!/usr/bin/env python3
"""Plan attestation rows for confirm.confirmations; db/ops/record-attestation.sh applies them.

An attestation stands in for a signature when the holder of a candidate wallet
confirmed its activity to us outside the site, for example an exchange that
holds the key. The row records who attested and the SHA-256 of their statement;
the statement itself stays with the operator. Reads the CSV extracts that
db/ops/owner-db.sh writes and writes the rows to insert to --plan-out. No
database code.

Refuses an address that is not a candidate in the loaded set, is not in the
loaded ledger or not deferred there, or already confirmed under that set.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import review_tracks as rt  # noqa: E402


def _load_report_module():
    spec = importlib.util.spec_from_file_location("confirmed_wallets", HERE / "confirmed-wallets.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["confirmed_wallets"] = module
    spec.loader.exec_module(module)
    return module


cw = _load_report_module()

PLAN_COLUMNS = [
    "address", "data_version", "policy_version", "stage_reason", "attested_by", "evidence_sha256", "message",
    "wallet_allocation_atto", "vault_shares_allocation_atto",
]
ATTESTED_BY = re.compile(r"^[^\x00-\x1f\x7f]{1,80}$")
MAX_NOTE = 500

# bech32 (BIP-173), as in injector/inject_claims.py.
_B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _bech32_polymod(values: List[int]) -> int:
    gen = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    chk = 1
    for v in values:
        b = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ v
        for i in range(5):
            chk ^= gen[i] if ((b >> i) & 1) else 0
    return chk


def bech32_to_hex(addr: str) -> str:
    pos = addr.rfind("1")
    hrp, data_part = addr[:pos], addr[pos + 1:]
    if hrp != "one" or len(data_part) < 7:
        raise ValueError
    data = [_B32.find(c) for c in data_part]
    if -1 in data:
        raise ValueError
    if _bech32_polymod([ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp] + data) != 1:
        raise ValueError
    acc = bits = 0
    out = bytearray()
    for v in data[:-6]:
        acc = (acc << 5) | v
        bits += 5
        while bits >= 8:
            bits -= 8
            out.append((acc >> bits) & 0xFF)
    if len(out) != 20:
        raise ValueError
    return "0x" + out.hex()


def normalize_address(value: str) -> str:
    text = value.strip().lower()
    if rt.ADDRESS.match(text):
        return text
    if text.startswith("one1"):
        try:
            return bech32_to_hex(text)
        except ValueError:
            pass
    raise rt.ReviewError(f"--address {value!r} is not a 0x or one1 address")


def read_addresses(values: List[str]) -> List[str]:
    if not values:
        raise rt.ReviewError("give at least one --address")
    out: List[str] = []
    for value in values:
        address = normalize_address(value)
        if address in out:
            raise rt.ReviewError(f"--address {value!r} is given twice")
        out.append(address)
    return out


def check_args(args: argparse.Namespace) -> None:
    args.addresses = read_addresses(args.address)
    args.attested_by = args.attested_by.strip()
    if not ATTESTED_BY.match(args.attested_by):
        raise rt.ReviewError("--attested-by must be 1 to 80 characters on one line, e.g. crypto.com")
    if not args.evidence.is_file():
        raise rt.ReviewError(f"--evidence {args.evidence}: no such file")
    args.evidence_sha256 = hashlib.sha256(args.evidence.read_bytes()).hexdigest()
    args.note = args.note.strip()
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in args.note):
        raise rt.ReviewError("--note must be one line of text")
    if len(args.note) > MAX_NOTE:
        raise rt.ReviewError(f"--note is longer than {MAX_NOTE} characters")


def attestation_message(address: str, candidate: Dict[str, str], args: argparse.Namespace) -> str:
    lines = [
        "migrate.country confirmation without a wallet signature",
        f"Address: {address}",
        f"Attested by: {args.attested_by}",
        f"Evidence SHA-256: {args.evidence_sha256}",
    ]
    if args.note:
        lines.append(f"Note: {args.note}")
    lines += [
        f"Cutoff: {candidate['cutoff_utc']}",
        f"Policy version: {candidate['policy_version']}",
        f"Data version: {candidate['data_version']}",
    ]
    return "\n".join(lines)


def plan(args: argparse.Namespace, candidates: List[Dict[str, str]],
         confirmations: List[Dict[str, str]]) -> tuple[List[Dict[str, str]], List[str], List[str]]:
    by_address = {(r.get("address") or "").strip().lower(): r for r in candidates}
    current: Dict[str, Dict[str, str]] = {}
    for row in confirmations:
        if cw.pg_bool(row.get("still_candidate")):
            current[(row.get("address") or "").strip().lower()] = row

    rows: List[Dict[str, str]] = []
    problems: List[str] = []
    table: List[str] = []
    for address in args.addresses:
        c = by_address.get(address)
        if c is None:
            problems.append(f"{address}: missing from the candidate extract")
            continue
        if not cw.pg_bool(c.get("is_candidate")):
            problems.append(f"{address}: not a confirmation candidate in the loaded set")
            continue
        if not cw.pg_bool(c.get("in_ledger")):
            problems.append(f"{address}: not in the loaded ledger")
            continue
        if c.get("migration_stage") != "deferred":
            problems.append(f"{address}: the loaded ledger has it at stage {c.get('migration_stage') or 'none'}, "
                            "not deferred")
            continue
        existing = current.get(address)
        if existing is not None:
            problems.append(f"{address}: already confirmed under {existing['data_version']} / "
                            f"{existing['policy_version']} (confirmation {existing['id']}, "
                            f"{existing.get('signature_scheme') or 'personal_sign'})")
            continue
        wallet = cw.to_int(c.get("migration_wallet_allocation_atto"))
        vault = cw.to_int(c.get("migration_staked_to_vault_atto"))
        rows.append({
            "address": address,
            "data_version": c["data_version"],
            "policy_version": c["policy_version"],
            "stage_reason": c["stage_reason"],
            "attested_by": args.attested_by,
            "evidence_sha256": args.evidence_sha256,
            "message": attestation_message(address, c, args),
            "wallet_allocation_atto": str(wallet),
            "vault_shares_allocation_atto": str(vault),
        })
        table.append(f"  {address}  {cw.REASON_SHORT.get(c['stage_reason'], c['stage_reason']):<19}  "
                     f"{cw.format_one(wallet):>22}  {cw.format_one(vault):>22}")
    if problems:
        return [], problems, []

    versions = sorted({f"{r['data_version']} / {r['policy_version']}" for r in rows})
    wallet_total = sum(int(r["wallet_allocation_atto"]) for r in rows)
    vault_total = sum(int(r["vault_shares_allocation_atto"]) for r in rows)
    lines = [
        "Record attestations (confirmations without a wallet signature)",
        f"  attested by   {args.attested_by}",
        f"  evidence      {args.evidence.name}, sha256 {args.evidence_sha256}",
        f"  note          {args.note or 'none'}",
        f"  candidate set {', '.join(versions)}",
        f"  to record     {len(rows):,} wallet{'s' if len(rows) != 1 else ''}: wallet {cw.format_one(wallet_total)} ONE"
        f" + vault shares {cw.format_one(vault_total)} ONE",
        "",
        f"  {'address':<42}  {'reason':<19}  {'wallet ONE':>22}  {'vault shares ONE':>22}",
        *table,
    ]
    return rows, [], lines


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--address", action="append", default=[], help="0x or one1 address (repeatable)")
    parser.add_argument("--attested-by", required=True, help="who confirmed the activity, e.g. crypto.com")
    parser.add_argument("--evidence", required=True, type=Path,
                        help="their statement (e-mail export, PDF, ...); only its SHA-256 is stored")
    parser.add_argument("--note", default="", help="one line stored in the row's message")
    parser.add_argument("--candidates", type=Path, help="attest-candidates.csv from owner_db_candidates")
    parser.add_argument("--confirmations", type=Path, help="confirmations.csv from owner_db_extract")
    parser.add_argument("--plan-out", type=Path, help="CSV of the rows to insert")
    parser.add_argument("--meta-out", type=Path, help="'<planned rows>'")
    parser.add_argument("--check-only", action="store_true",
                        help="check the arguments, print the addresses as 0x, then stop; needs no extracts")
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    try:
        check_args(args)
        if args.check_only:
            sys.stdout.write("".join(f"{a}\n" for a in args.addresses))
            return 0
        missing = [f"--{n.replace('_', '-')}" for n in ("candidates", "confirmations", "plan_out", "meta_out")
                   if getattr(args, n) is None]
        if missing:
            raise rt.ReviewError(f"missing {', '.join(missing)}")
        rows, problems, lines = plan(args, cw.read_rows(str(args.candidates)), cw.read_rows(str(args.confirmations)))
    except rt.ReviewError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if problems:
        print(f"error: nothing planned; fix these first ({len(problems)}):", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 2
    with args.plan_out.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=PLAN_COLUMNS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    args.meta_out.write_text(f"{len(rows)}\n", encoding="utf-8")
    sys.stdout.write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
