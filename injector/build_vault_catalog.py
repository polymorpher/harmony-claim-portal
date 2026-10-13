#!/usr/bin/env python3
"""Build the catalog the /vault (Governor Vaults) page loads, from a harmony-migration checkout.

One entry per planned governor vault: its CREATE2 address, the validator's
Harmony name and commission at the cutoff, the initial governor, its governor
agreement on governors.country, and totals of the delegations at the cutoff by
migration stage. Only per-vault totals are written, never a delegator list.
Everything else on the page (deployment, size, governor, fee, deposits,
withdrawals, agreement status) is read on-chain.

The totals are pre-publication numbers under harmony-migration's numerical
embargo; the output is git-ignored and published only by deploying it.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import re
import sys
import time
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal, InvalidOperation
from pathlib import Path

csv.field_size_limit(1 << 24)

FORMAT = "vault-catalog/v1"
DEFAULT_OUT = Path(__file__).resolve().parents[1] / "frontend" / "public" / "vault-catalog.json"
DEFAULT_HARMONY_RPC = "https://api.s0.t.hmny.io"
THRESHOLD_ATTO = 1000 * 10**18

RESERVE_SAFE = "0xf868743BE6bbdA38929C03616234684E6D3Ded20"

# Governor agreements (governors.country): MetaLeX CyberAgreementRegistry on Base.
DEFAULT_AGREEMENTS = "https://governors.country/agreements.json"
AGREEMENT_REGISTRY = "0xa9E808B8eCBB60Bb19abF026B5b863215BC4c134"
AGREEMENT_URL = "https://app.metalex.tech/cybersign/8453/{}"
BASE_RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co"]
CHAINS = {
    1: {"token": "0xFf74317E948695297acb79Cb2De06111F5Cc16b3", "reserve": RESERVE_SAFE},
    11155111: {"token": "0x6dF02e9a623f9d11d6c73B1fc2aBfAbb63f11E72", "reserve": RESERVE_SAFE},
}

# Stage of each delegation at the cutoff, as the page groups them. `confirmed` is inactive stake
# whose delegator confirmed on the portal and was approved (from --portal-export).
CATEGORIES = ("initial", "confirmed", "inactive", "below_threshold", "exchange", "next_stage", "not_issued", "manual_review")


def read_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


class Inputs:
    def __init__(self, repo: Path):
        mapping = repo / "results" / "2026-09-11" / "destination-mapping"
        self.paths = {
            "stages": mapping / "validator-vault-stages.csv",
            "governors": mapping / "initial-stage" / "validator-vaults.csv",
            "governor_exceptions": mapping / "validator-governor-exceptions.csv",
            "routing": mapping / "routing-exceptions.csv",
            "policy": repo / "results" / "2026-09-11" / "claim-accounting" / "migration-stage-policy.csv",
            "delegations": repo / "artifacts" / "cutoff-20260910" / "state" / "staked-to-vault-by-delegation-rpc.csv",
        }
        missing = [str(p) for p in self.paths.values() if not p.is_file()]
        if missing:
            raise SystemExit("missing harmony-migration inputs:\n  " + "\n  ".join(missing))
        self.stages = {r["validator_address"].lower(): r for r in read_csv(self.paths["stages"])}
        self.governors = {r["validator_address"].lower(): r["governor_address"] for r in read_csv(self.paths["governors"])}
        self.held = {r["validator_address"].lower() for r in read_csv(self.paths["governor_exceptions"])
                     if r["destination_status"] != "ready"}
        self.routing = {(r["validator_address"].lower(), r["source_address"].lower()): r
                        for r in read_csv(self.paths["routing"]) if r["component"] == "vault_shares"}
        self.policy = {r["address"].lower(): r for r in read_csv(self.paths["policy"])}
        self.delegations = [(r["validator_address"].lower(), r["delegator_address"].lower(), int(r["staked_to_vault_atto"]))
                            for r in read_csv(self.paths["delegations"])]


def policy_category(row: dict | None) -> str:
    """Stage of a delegator's stake from the migration stage policy (absent: under 1,000 ONE in total)."""
    if row is None:
        return "below_threshold_uncompiled"
    if row["issuance_treatment"] == "not_issued" or not row["migration_stage"]:
        return "not_issued"
    stage = row["migration_stage"]
    if stage == "initial":
        return "initial"
    if stage == "next_stage":
        return "next_stage"
    if stage == "deferred":
        return "below_threshold_deferred" if row["stage_reason"].startswith("below") else "inactive"
    raise SystemExit(f"unknown migration stage {stage!r} for {row['address']}")


def read_approved(paths: list[Path]) -> set[tuple[str, str]]:
    """(validator, delegator) vault positions approved on the portal, from confirmed-wallets *-vault-shares.csv exports."""
    approved = set()
    for path in paths:
        for r in read_csv(path):
            if r.get("decision") == "approved" and int(r.get("expected_shares_atto") or 0) > 0:
                approved.add((r["validator_address"].lower(), r["address"].lower()))
    return approved


def cutoff_breakdown(inputs: Inputs, approved: set[tuple[str, str]] = frozenset()) -> dict[str, dict[str, list[int]]]:
    """validator -> category -> [delegators, atto] over the positive delegations at the cutoff.

    A routing exception that does not issue part of a delegation splits the amount: the excepted
    part is not issued and the rest follows the policy; the delegator is counted where the rest goes.
    Approved portal positions move from inactive to confirmed.
    """
    out: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    seen = set()
    for validator, delegator, amount in inputs.delegations:
        if amount <= 0:
            continue
        parts: list[tuple[str, int]] = []
        route = inputs.routing.get((validator, delegator))
        if route and route["issuance_treatment"] == "not_issued":
            excepted = min(amount, int(route["amount_atto"]))
            parts.append(("not_issued", excepted))
            if amount > excepted:
                parts.append((policy_category(inputs.policy.get(delegator)), amount - excepted))
        elif route and route["migration_stage"] == "exchange_manual":
            parts.append(("exchange", amount))
        elif route and route["migration_stage"] == "manual_review":
            parts.append(("manual_review", amount))
        else:
            parts.append((policy_category(inputs.policy.get(delegator)), amount))
        if (validator, delegator) in approved:
            if [c for c, _ in parts] != ["inactive"]:
                raise SystemExit(f"portal-approved position {delegator} at {validator} is not inactive stake at the cutoff")
            parts = [("confirmed", amount)]
            seen.add((validator, delegator))
        for category, part in parts:
            out[validator][category][1] += part
        out[validator][parts[-1][0]][0] += 1
    if approved - seen:
        raise SystemExit(f"{len(approved - seen)} portal-approved positions have no delegation at the cutoff, "
                         f"e.g. {sorted(approved - seen)[0]}")
    return out


def check_against_stages(breakdown: dict, stages: dict) -> None:
    """The per-stage sums must equal harmony-migration's validator-vault-stages.csv exactly."""
    columns = {
        "initial_assets_atto": ("initial",),
        "exchange_manual_assets_atto": ("exchange",),
        "next_stage_assets_atto": ("next_stage",),
        "manual_review_assets_atto": ("manual_review",),
        "not_issued_assets_atto": ("not_issued",),
        "qualified_deferred_assets_atto": ("inactive", "confirmed", "below_threshold_deferred"),
        "uncompiled_deferred_assets_atto": ("below_threshold_uncompiled",),
    }
    errors = []
    for validator in set(stages) | set(breakdown):
        row, got = stages.get(validator), breakdown.get(validator, {})
        if row is None:
            errors.append(f"{validator}: delegations but no stage row")
            continue
        for column, categories in columns.items():
            ours = sum(got.get(c, [0, 0])[1] for c in categories)
            if ours != int(row[column] or 0):
                errors.append(f"{validator}: {column} {ours} != {row[column]}")
        if sum(v[1] for v in got.values()) != int(row["base_vault_assets_atto"] or 0):
            errors.append(f"{validator}: total {sum(v[1] for v in got.values())} != base {row['base_vault_assets_atto']}")
    if errors:
        raise SystemExit("cutoff breakdown does not match validator-vault-stages.csv:\n  " + "\n  ".join(sorted(errors)[:20]))


def merged(categories: dict[str, list[int]]) -> dict[str, dict[str, object]]:
    totals = {c: [0, 0] for c in CATEGORIES}
    for category, (count, atto) in categories.items():
        key = "below_threshold" if category.startswith("below_threshold") else category
        totals[key][0] += count
        totals[key][1] += atto
    return {c: {"count": n, "atto": str(a)} for c, (n, a) in totals.items()}


def harmony_validators(vb, url: str, validators: list[str]) -> tuple[dict[str, dict], int]:
    """validator -> {name, rate, delegations, stake} from Harmony at the cutoff block, and the cutoff time."""
    rpc = vb.harmony_rpc(url)
    cutoff_time = int(rpc.call("hmyv2_getBlockByNumber", [vb.HARMONY_CUTOFF_BLOCK, {"fullTx": False}])["timestamp"])

    def fetch(group: list[str]) -> list:
        calls = [("hmyv2_getValidatorInformationByBlockNumber", [v, vb.HARMONY_CUTOFF_BLOCK]) for v in group]
        for attempt in range(6):
            try:
                return rpc.batch(calls)
            except RuntimeError:
                if attempt == 5:
                    raise
                time.sleep(2 * (attempt + 1))
        return []

    groups = [validators[i:i + 4] for i in range(0, len(validators), 4)]
    out = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        for group, results in zip(groups, pool.map(fetch, groups)):
            for validator, info in zip(group, results):
                inner = info.get("validator") or {}
                if vb.common.from_one1(inner.get("address", ""), checksum=False) != validator:
                    raise SystemExit(f"Harmony RPC answered for {inner.get('address')} instead of {validator}")
                amounts = [int(d["amount"]) for d in inner.get("delegations") or [] if int(d["amount"]) > 0]
                out[validator] = {"name": inner.get("name", ""), "rate": str(inner.get("rate", "")),
                                  "delegations": len(amounts), "stake": sum(amounts)}
    return out, cutoff_time


def rate_text(rate: str) -> str:
    try:
        value = Decimal(rate)
    except InvalidOperation:
        raise SystemExit(f"Harmony returned commission rate {rate!r}") from None
    if not Decimal(0) <= value <= Decimal(1):
        raise SystemExit(f"Harmony returned commission rate {rate!r}")
    return format(value.normalize(), "f")


def load_agreements(source: str) -> tuple[dict[str, str], dict]:
    """validator address -> governor agreement id, from governors.country's agreements.json (URL or file)."""
    if re.match(r"https?://", source):
        req = urllib.request.Request(source, headers={"User-Agent": "harmony-claim-portal"})
        raw = urllib.request.urlopen(req, timeout=60).read()
    else:
        raw = Path(source).expanduser().read_bytes()
    payload = json.loads(raw)
    items = payload if isinstance(payload, list) else payload.get("primary", []) + payload.get("secondary", [])
    out = {}
    for item in items:
        aid = str(item.get("agreementId", "")).lower()
        if not re.fullmatch(r"0x[0-9a-f]{64}", aid):
            raise SystemExit(f"agreement for {item.get('address')} has a bad agreementId {aid!r}")
        if item.get("url") and item["url"].lower() != AGREEMENT_URL.format(aid).lower():
            raise SystemExit(f"agreement {aid} links to {item['url']}, not the cyberSign page for its id")
        out[str(item["address"]).lower()] = aid
    return out, {"source": source, "sha256": hashlib.sha256(raw).hexdigest(), "count": len(out)}


def agreements_signed(ids: list[str], rpcs: list[str]) -> dict[str, bool]:
    """agreement id -> signed, reading agreements(bytes32) on Base: the second word is the signature count."""
    out: dict[str, bool] = {}
    for i in range(0, len(ids), 40):
        chunk = ids[i:i + 40]
        body = json.dumps([{"jsonrpc": "2.0", "id": j, "method": "eth_call",
                            "params": [{"to": AGREEMENT_REGISTRY, "data": "0x9e1f68c7" + aid[2:]}, "latest"]}
                           for j, aid in enumerate(chunk)]).encode()
        for url in rpcs:
            try:
                req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "User-Agent": "harmony-claim-portal"})
                results = {r["id"]: r for r in json.loads(urllib.request.urlopen(req, timeout=60).read())}
                if all("result" in results.get(j, {}) for j in range(len(chunk))):
                    break
            except (OSError, ValueError):
                continue
        else:
            raise SystemExit(f"no Base RPC answered for agreements {i}..{i + len(chunk)}")
        for j, aid in enumerate(chunk):
            result = results[j]["result"]
            out[aid] = len(result) >= 130 and int(result[66:130], 16) > 0
    return out


def start_block(repo: Path, chain_id: int) -> int | None:
    """Earliest vault deployment recorded for the chain in harmony-migration's deployment ledgers."""
    airdrop = repo / "airdrop"
    blocks = [int(r["block_number"])
              for path in [*airdrop.glob("vault/deployments-*.csv"), *airdrop.glob("runs/*/deployments-*.csv")]
              for r in read_csv(path)
              if r.get("chain_id") == str(chain_id) and r.get("status") == "deployed" and r.get("block_number")]
    return min(blocks) if blocks else None


def build(args: argparse.Namespace) -> dict:
    repo = Path(args.migration_repo).expanduser().resolve()
    sys.path.insert(0, str(repo / "airdrop" / "tools"))
    import vault_batch as vb  # noqa: E402  (harmony-migration's audited artifact, CREATE2 and Harmony RPC)

    defaults = CHAINS.get(args.chain_id, {})
    token = args.token or defaults.get("token")
    reserve = args.reserve or defaults.get("reserve")
    if not token or not reserve:
        raise SystemExit(f"chain {args.chain_id}: pass --token and --reserve")
    first_block = args.start_block if args.start_block is not None else start_block(repo, args.chain_id)
    if first_block is None:
        raise SystemExit(f"no vault deployment recorded for chain {args.chain_id}; pass --start-block")

    artifact = vb.load_artifact(repo / "airdrop" / "vault" / "GovernorDelegator.json")
    inputs = Inputs(repo)
    exports = [Path(p).expanduser().resolve() for p in args.portal_export]
    if not exports:
        print("warning: no --portal-export; portal-approved delegators are listed as inactive", file=sys.stderr)
    breakdown = cutoff_breakdown(inputs, read_approved(exports))
    check_against_stages(breakdown, inputs.stages)

    validators = sorted(v for v in inputs.stages if v not in inputs.held)
    harmony, cutoff_time = harmony_validators(vb, args.harmony_rpc, validators)
    agreements, agreements_meta = load_agreements(args.governor_agreements)
    signed = agreements_signed(sorted({agreements[v] for v in validators if v in agreements}), BASE_RPCS)

    vaults = []
    for validator in validators:
        h = harmony[validator]
        categories = breakdown.get(validator, {})
        count = sum(n for n, _ in categories.values())
        stake = sum(a for _, a in categories.values())
        if (count, stake) != (h["delegations"], h["stake"]):
            raise SystemExit(f"{validator}: ledger has {count} delegations / {stake} atto, "
                             f"Harmony has {h['delegations']} / {h['stake']} at the cutoff")
        governor = vb.common.to_checksum(inputs.governors.get(validator, validator))
        vaults.append({
            "validator": vb.common.to_checksum(validator),
            "validator_one1": vb.common.to_one1(validator),
            "name": h["name"],
            "governor": governor,
            "vault": vb.vault_address(artifact, token, validator, governor),
            "commission_rate": rate_text(h["rate"]),
            "cutoff": {"delegators": count, "stake_atto": str(stake), **merged(categories)},
            **({"agreement": {"id": agreements[validator], "signed": signed[agreements[validator]]}} if validator in agreements else {}),
        })

    return {
        "format": FORMAT,
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "chain_id": args.chain_id,
        "token": vb.common.to_checksum(token),
        "reserve": vb.common.to_checksum(reserve),
        "factory": vb.FACTORY,
        "creation_code": vb.common.hex0x(artifact.creation),
        "start_block": first_block,
        "harmony_cutoff": {
            "block": vb.HARMONY_CUTOFF_BLOCK,
            "time_utc": dt.datetime.fromtimestamp(cutoff_time, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        "threshold_atto": str(THRESHOLD_ATTO),
        "portal_exports": [{"name": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "time_utc": export_time(p)}
                           for p in exports],
        # `signed` on each vault's agreement is this snapshot; the page reads the registry live and falls back to it.
        "governor_agreements": {**agreements_meta, "chain_id": 8453, "registry": AGREEMENT_REGISTRY,
                                "checked_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")},
        "vaults": vaults,
    }


def export_time(path: Path) -> str:
    """When a confirmed-wallets export was taken: the timestamp in its name, else the file's mtime."""
    m = re.search(r"(\d{8}T\d{6}Z)", path.name)
    when = (dt.datetime.strptime(m.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc) if m
            else dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc))
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--migration-repo", default="~/git/harmony-migration")
    p.add_argument("--chain-id", type=int, default=1, help="1 (default) or 11155111 for the Sepolia rehearsal")
    p.add_argument("--token", help="ONE token on that chain (default: the known token for --chain-id)")
    p.add_argument("--reserve", help="Safe that funds airdrop deposits (default: the reserve Safe)")
    p.add_argument("--start-block", type=int, help="first block to read vault events from "
                                                   "(default: earliest deployment in the migration repo's ledgers)")
    p.add_argument("--portal-export", action="append", default=[], metavar="CSV",
                   help="confirmed-wallets *-vault-shares.csv export (db/ops/confirmed-wallets.sh --decision approved); "
                        "its approved positions are shown as confirmed instead of inactive. Repeatable.")
    p.add_argument("--governor-agreements", default=DEFAULT_AGREEMENTS, metavar="URL_OR_FILE",
                   help="governors.country agreements.json: each validator's governor agreement id")
    p.add_argument("--harmony-rpc", default=DEFAULT_HARMONY_RPC, help="Harmony shard-0 archive RPC")
    p.add_argument("--out", default=str(DEFAULT_OUT))
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    catalog = build(args)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{out}: {len(catalog['vaults'])} vaults on chain {catalog['chain_id']}, events from block {catalog['start_block']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
