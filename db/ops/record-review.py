#!/usr/bin/env python3
"""Plan review rows for confirm.reviews; db/ops/record-review.sh applies them.

Reads the CSV extracts that db/ops/owner-db.sh writes and, for --sent, a
safe-batch or vault-batch run directory from harmony-migration/airdrop. Writes
the rows to insert to --plan-out and prints what they are. No database code.

  --approve / --reject    one decision row per confirmation
  --sent wallet|vault     what a run paid: wallet:<run> or vault:<run>:<validator> rows, status included
  --unsent wallet|vault   undo the marks of one run: the same batch ids, status queued

Any problem stops the whole plan, so a plan is either complete or not written.
review_tracks.py describes how the rows are read back.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

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

SAFE_FORMAT = "safe-direct-transfer/v1"
VAULT_FORMAT = "safe-vault-deposits/v1"
PLAN_COLUMNS = ["action", "confirmation_id", "address", "status", "batch_id", "note", "amount_atto", "amount_one"]
MAX_NOTE = 500
SHOW_ROWS = 25
SHOW_PROBLEMS = 30


class PlanError(Exception):
    def __init__(self, problems: List[str]) -> None:
        super().__init__(f"{len(problems)} problem(s)")
        self.problems = problems


def one(atto: Optional[int]) -> str:
    return "-" if atto is None else cw.format_one(atto)


def plural(n: int, word: str) -> str:
    return f"{n:,} {word}{'' if n == 1 else 's'}"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------- inputs


@dataclass
class Target:
    confirmation_id: str
    address: str
    where: str


@dataclass
class RunItem:
    address: str
    validator: str
    amount: int
    where: str


@dataclass
class Run:
    path: Path
    name: str
    part: str
    manifest_sha: str
    selected: List[int]
    transaction_count: int
    items: List[RunItem]


def read_targets(ids: List[str], csv_paths: List[Path]) -> List[Target]:
    targets = []
    for value in ids:
        text = value.strip()
        if not text.isdigit() or int(text) <= 0:
            raise rt.ReviewError(f"--confirmation-id {value!r} must be a positive integer")
        targets.append(Target(str(int(text)), "", f"--confirmation-id {text}"))
    for path in csv_paths:
        if not path.is_file():
            raise rt.ReviewError(f"--from-csv {path}: no such file")
        with path.open(newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            columns = [c.strip().lower() for c in (reader.fieldnames or [])]
            if "id" not in columns and "address" not in columns:
                raise rt.ReviewError(f"{path}: needs an id column (confirmation id) or an address column")
            for line, raw in enumerate(reader, start=2):
                row = {(k or "").strip().lower(): (v or "").strip() for k, v in raw.items()}
                cid, address = row.get("id", ""), row.get("address", "").lower()
                if not cid and not address:
                    continue
                where = f"{path}:{line}"
                if cid and (not cid.isdigit() or int(cid) <= 0):
                    raise rt.ReviewError(f"{where}: id {cid!r} is not a confirmation id")
                if address and not rt.ADDRESS.match(address):
                    raise rt.ReviewError(f"{where}: address {address!r} is not a 0x address")
                targets.append(Target(str(int(cid)) if cid else "", address, where))
    if not targets:
        raise rt.ReviewError("no confirmations given (--confirmation-id or --from-csv)")
    return targets


def read_list(path: Path, part: str) -> List[RunItem]:
    address_column = "address" if part == "wallet" else "delegator_address"
    need = [address_column, "amount_atto"] + ([] if part == "wallet" else ["validator_address"])
    items = []
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        missing = [c for c in need if c not in (reader.fieldnames or [])]
        if missing:
            raise rt.ReviewError(f"{path}: missing column(s) {', '.join(missing)}")
        for line, row in enumerate(reader, start=2):
            where = f"{path}:{line}"
            address = (row[address_column] or "").strip().lower()
            validator = (row.get("validator_address") or "").strip().lower() if part == "vault" else ""
            amount = (row["amount_atto"] or "").strip()
            if not rt.ADDRESS.match(address) or (part == "vault" and not rt.ADDRESS.match(validator)):
                raise rt.ReviewError(f"{where}: not a 0x address")
            if not amount.isdigit():
                raise rt.ReviewError(f"{where}: amount_atto {amount!r} is not a whole number")
            items.append(RunItem(address, validator, int(amount), where))
    return items


def load_run(path: Path, part: str, transactions: List[int]) -> Run:
    path = path.expanduser().resolve()
    if not path.is_dir():
        raise rt.ReviewError(f"--from-run {path}: not a directory")
    name = rt.check_name(path.name, "run directory name")
    manifest_path = path / "manifest.json"
    if not manifest_path.is_file():
        raise rt.ReviewError(f"{path}: no manifest.json; is this a safe-batch or vault-batch run directory?")
    raw = manifest_path.read_bytes()
    try:
        manifest = json.loads(raw)
    except ValueError as exc:
        raise rt.ReviewError(f"{manifest_path}: not JSON ({exc})") from None
    fmt = manifest.get("format")
    kinds = {SAFE_FORMAT: "a safe-batch run", VAULT_FORMAT: "a vault-batch run"}
    wanted = SAFE_FORMAT if part == "wallet" else VAULT_FORMAT
    if fmt != wanted:
        raise rt.ReviewError(f"{path} is {kinds.get(fmt, f'format {fmt!r}')}; --sent {part} needs {kinds[wanted]}")

    entries = manifest.get("transactions") or []
    by_index = {int(e["index"]): e for e in entries}
    lists: List[Tuple[Path, Optional[str]]] = []
    if transactions:
        if len(set(transactions)) != len(transactions):
            raise rt.ReviewError("a --transaction is given twice")
        for index in sorted(transactions):
            entry = by_index.get(index)
            if entry is None:
                raise rt.ReviewError(f"--transaction {index}: the run has transactions 1 to {len(entries)}")
            folder = path / entry["folder"]
            if part == "wallet":
                lists.append((folder / "recipients.csv", entry.get("recipients_sha256")))
            elif entry.get("kind") != "fund":
                raise rt.ReviewError(f"--transaction {index} deploys vaults and moves no ONE; give the fund transactions")
            else:
                lists.append((folder / "deposits.csv", entry.get("list_sha256")))
    elif part == "wallet":
        lists.append((path / "recipients.csv", manifest.get("recipients_sha256")))
    else:
        if manifest.get("phase") == "deploy":
            raise rt.ReviewError(f"{path} only deploys vaults (--phase deploy); mark the run that funds them")
        lists.append((path / "deposits.csv", (manifest.get("file_sha256") or {}).get("deposits.csv")))

    items: List[RunItem] = []
    for file, expected in lists:
        if not file.is_file():
            raise rt.ReviewError(f"{file}: missing")
        # safe-batch and vault-batch write these hashes with a 0x prefix.
        expected = (expected or "").lower()
        expected = expected[2:] if expected.startswith("0x") else expected
        if not expected or sha256_file(file) != expected:
            raise rt.ReviewError(f"{file}: SHA-256 differs from manifest.json; the run was changed after it was built")
        items.extend(read_list(file, part))
    return Run(path, name, part, hashlib.sha256(raw).hexdigest(), sorted(transactions), len(entries), items)


# ---------------------------------------------------------------- planning


@dataclass
class PlanRow:
    action: str
    confirmation_id: str
    address: str
    status: str
    batch_id: str
    note: str
    amount: Optional[int]

    def csv_row(self) -> Dict[str, str]:
        return {
            "action": self.action,
            "confirmation_id": self.confirmation_id,
            "address": self.address,
            "status": self.status,
            "batch_id": self.batch_id,
            "note": self.note,
            "amount_atto": "" if self.amount is None else str(self.amount),
            "amount_one": "" if self.amount is None else cw.atto_to_one(self.amount),
        }


class Planner:
    def __init__(self, items: List, state: rt.ReviewState) -> None:
        self.state = state
        self.by_id = {c.id: c for c in items}
        self.by_address: Dict[str, List] = defaultdict(list)
        for c in items:
            self.by_address[c.address].append(c)
        self.rows: List[PlanRow] = []
        self.problems: List[str] = []
        self.warnings: List[str] = []
        self.lines: List[str] = []

    def current(self, address: str):
        """The confirmation under the loaded candidate set; there is at most one per address."""
        live = [c for c in self.by_address.get(address, []) if c.still_candidate]
        return live[-1] if live else None

    def resolve(self, target: Target):
        if target.confirmation_id:
            c = self.by_id.get(target.confirmation_id)
            if c is None:
                self.problems.append(f"{target.where}: confirmation {target.confirmation_id} does not exist")
            elif target.address and target.address != c.address:
                self.problems.append(
                    f"{target.where}: confirmation {c.id} belongs to {c.address}, not {target.address}")
                return None
            return c
        c = self.current(target.address)
        if c is None:
            if self.by_address.get(target.address):
                self.problems.append(f"{target.where}: {target.address} signed only under a superseded candidate set; "
                                     "give its confirmation id")
            else:
                self.problems.append(f"{target.where}: {target.address} has no confirmation")
        return c

    def finish(self) -> None:
        if self.problems:
            raise PlanError(self.problems)

    # ------------------------------------------------------------ decisions

    def plan_decision(self, targets: List[Target], approve: bool, label: str, note: str) -> None:
        wanted = "approved" if approve else "rejected"
        seen: Dict[str, str] = {}
        new = changed = already = 0
        wallet_total = vault_total = 0
        for target in targets:
            c = self.resolve(target)
            if c is None:
                continue
            if c.id in seen:
                self.problems.append(f"{target.where}: confirmation {c.id} is listed twice (also {seen[c.id]})")
                continue
            seen[c.id] = target.where
            if approve:
                if not c.still_candidate:
                    self.problems.append(
                        f"{target.where}: confirmation {c.id} ({c.address}) was signed under "
                        f"{c.data_version} / {c.policy_version}, which is no longer the candidate set")
                if not c.signer_matches:
                    self.problems.append(f"{target.where}: confirmation {c.id}: signer {c.signer} is not {c.address}")
                if not c.in_ledger:
                    self.problems.append(f"{target.where}: {c.address} is not in the loaded ledger")
            decision, _ = self.state.decision_of(c.id)
            if decision == wanted:
                already += 1
                continue
            if decision == "none":
                new += 1
            else:
                changed += 1
            if not approve and (c.wallet_status == "sent" or any(v.status == "sent" for v in c.vaults)):
                self.warnings.append(f"confirmation {c.id} ({c.address}) already has deliveries marked sent")
            wallet_total += c.wallet_allocation
            vault_total += c.vault_allocation
            self.rows.append(PlanRow("approve" if approve else "reject", c.id, c.address,
                                     "queued" if approve else "rejected", label, note,
                                     c.total_allocation if c.in_ledger else None))
        verb = "Approve" if approve else "Reject"
        self.lines += [
            f"{verb} confirmations",
            f"  given         {len(targets):,}",
            f"  to record     {len(self.rows):,} ({new:,} new, {changed:,} changing an earlier decision)",
            f"  already       {already:,} already {wanted} (left out)",
            f"  label         {label or 'none'}",
            f"  amounts       wallet {one(wallet_total)} ONE + vault shares {one(vault_total)} ONE",
        ]

    # ------------------------------------------------------------ sent

    def plan_sent(self, run: Run, note: str) -> None:
        recorded = self.state.run_manifests(run.name)
        if recorded and recorded != {run.manifest_sha}:
            self.problems.append(
                f"run name {run.name} is already recorded from another manifest.json "
                f"({', '.join(sorted(m[:12] for m in recorded))}…); a rebuilt run or a reused name. "
                "Give every batch its own directory name, e.g. a sequence number")
        tracks = self.state.run_tracks(run.name) - {run.part}
        if tracks:
            self.problems.append(f"run name {run.name} is already recorded for the {', '.join(sorted(tracks))} part")

        note_text = rt.manifest_note(run.manifest_sha, note)
        seen: Dict[Tuple[str, str], str] = {}
        already: List[RunItem] = []
        outside: List[RunItem] = []
        superseded: List[RunItem] = []
        for item in run.items:
            key = (item.address, item.validator)
            if key in seen:
                self.problems.append(f"{item.where}: {item.address} is listed twice (also {seen[key]})")
                continue
            seen[key] = item.where
            c = self.current(item.address)
            if c is None:
                (superseded if self.by_address.get(item.address) else outside).append(item)
                continue
            what = "wallet part is" if run.part == "wallet" else f"vault shares with {item.validator} are"
            decision, _ = self.state.decision_of(c.id)
            if decision != "approved":
                self.problems.append(f"{item.where}: confirmation {c.id} ({c.address}) is "
                                     f"{'not reviewed' if decision == 'none' else 'rejected'}; approve it first")
                continue
            if not c.in_ledger:
                self.problems.append(f"{item.where}: {c.address} is not in the loaded ledger")
                continue
            if run.part == "wallet":
                expected = c.wallet_allocation
                prior = self.state.wallet_sent(c.address)
                batch = rt.wallet_batch_id(run.name)
                blocked = c.wallet_destination if c.wallet_status == "blocked" else ""
            else:
                position = next((v for v in c.vaults if v.validator_address == item.validator), None)
                if position is None:
                    self.problems.append(f"{item.where}: {c.address} has no vault shares with {item.validator} "
                                         "in the loaded ledger")
                    continue
                expected = position.expected_shares
                prior = self.state.vault_sent(c.address, item.validator)
                batch = rt.vault_batch_id(run.name, item.validator)
                blocked = position.block_reason if position.status == "blocked" else ""
            if blocked:
                self.problems.append(f"{item.where}: {c.address}: its {what} not deliverable to the wallet itself "
                                     f"({blocked}); a batch must not have paid it")
                continue
            if item.amount != expected:
                self.problems.append(f"{item.where}: the run pays {c.address} {one(item.amount)} ONE; in the ledger "
                                     f"its {what} {one(expected)} ONE")
                continue
            if prior is not None:
                if prior.run == run.name:
                    already.append(item)
                else:
                    self.problems.append(
                        f"{item.where}: {c.address}: its {what} already marked sent by run {prior.run} "
                        f"({cw.display_time(prior.reviewed_at)}); this run would pay twice")
                continue
            self.rows.append(PlanRow("sent", c.id, c.address, "included", batch, note_text, item.amount))

        unit = "recipient" if run.part == "wallet" else "deposit"
        selected = ("all " + str(run.transaction_count)) if not run.selected else \
            f"{', '.join(map(str, run.selected))} of {run.transaction_count}"
        listed = sum(i.amount for i in run.items)
        self.lines += [
            f"Mark the {'wallet part' if run.part == 'wallet' else 'vault shares'} sent by run {run.name}",
            f"  run           {run.path}",
            f"  manifest      sha256 {run.manifest_sha}",
            f"  transactions  {selected}",
            f"  list          {plural(len(run.items), unit)}, {one(listed)} ONE",
            f"  to record     {plural(len(self.rows), unit)} to confirmed wallets, "
            f"{one(sum(r.amount or 0 for r in self.rows))} ONE",
            f"  already       {len(already):,} recorded for this run before (left out)",
            f"  not confirmed {plural(len(outside), unit)}, {one(sum(i.amount for i in outside))} ONE, to addresses "
            "without a confirmation (left out; for example the initial stage)",
        ]
        if superseded:
            self.lines.append(f"  superseded    {plural(len(superseded), unit)} to addresses that signed only under "
                              "an earlier candidate set (left out)")

    # ------------------------------------------------------------ unsent

    def plan_unsent(self, part: str, run_name: str, targets: List[Target], note: str) -> None:
        addresses = None
        if targets:
            addresses = set()
            for target in targets:
                c = self.resolve(target)
                if c is not None:
                    addresses.add(c.address)
        marks = self.state.wallet.items() if part == "wallet" else self.state.vault.items()
        for key, review in sorted(marks, key=lambda kv: kv[1].id):
            address = key if part == "wallet" else key[0]
            if review.status != "included" or review.run != run_name:
                continue
            if addresses is not None and address not in addresses:
                continue
            c = self.by_id.get(review.confirmation_id)
            amount = None
            if c is not None and part == "wallet":
                amount = c.wallet_allocation
            elif c is not None:
                position = next((v for v in c.vaults if v.validator_address == review.validator), None)
                amount = position.expected_shares if position else None
            text = f"undo: {note}"
            self.rows.append(PlanRow("undo", review.confirmation_id, address, "queued", review.batch_id,
                                     rt.manifest_note(review.manifest, text) if review.manifest else text, amount))
        if not self.rows:
            scope = " for these confirmations" if addresses is not None else ""
            self.problems.append(f"nothing is marked sent by run {run_name} for the {part} part{scope}")
        self.lines += [
            f"Undo the {'wallet part' if part == 'wallet' else 'vault shares'} marks of run {run_name}",
            f"  to record     {plural(len(self.rows), 'row')} back to pending, "
            f"{one(sum(r.amount or 0 for r in self.rows))} ONE",
        ]

    # ------------------------------------------------------------ output

    def render(self) -> List[str]:
        out = list(self.lines)
        if self.rows:
            out += ["", f"  {'confirmation':>12}  {'address':<42}  {'amount ONE':>20}  batch id"]
            for row in self.rows[:SHOW_ROWS]:
                out.append(f"  {row.confirmation_id:>12}  {row.address:<42}  {one(row.amount):>20}  "
                           f"{row.batch_id or '-'}")
            if len(self.rows) > SHOW_ROWS:
                out.append(f"  … and {len(self.rows) - SHOW_ROWS:,} more in the plan file")
        out += [f"warning: {w}" for w in self.warnings]
        return out


# ---------------------------------------------------------------- main


def check_note(note: str, required: bool, flag: str) -> str:
    note = note.strip()
    if required and not note:
        raise rt.ReviewError(f"{flag} needs --note with the reason")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in note):
        raise rt.ReviewError("--note must be one line of text")
    if len(note) > MAX_NOTE:
        raise rt.ReviewError(f"--note is longer than {MAX_NOTE} characters")
    return note


def check_args(args: argparse.Namespace) -> None:
    has_targets = bool(args.confirmation_id or args.from_csv)
    if args.approve or args.reject:
        flag = "--approve" if args.approve else "--reject"
        if not has_targets:
            raise rt.ReviewError(f"{flag} needs --confirmation-id or --from-csv")
        if args.from_run or args.transaction or args.run:
            raise rt.ReviewError(f"{flag} takes no --from-run, --transaction or --run")
        if args.label:
            rt.check_name(args.label, "--label")
        args.note = check_note(args.note, args.reject, flag)
    elif args.sent:
        if not args.from_run:
            raise rt.ReviewError("--sent needs --from-run DIR (the safe-batch or vault-batch run directory)")
        if has_targets or args.run or args.label:
            raise rt.ReviewError("--sent takes no --confirmation-id, --from-csv, --run or --label; it reads the run")
        args.note = check_note(args.note, False, "--sent")
    else:
        if not args.run:
            raise rt.ReviewError("--unsent needs --run NAME (the run directory name)")
        rt.check_name(args.run, "--run")
        if args.from_run or args.transaction or args.label:
            raise rt.ReviewError("--unsent takes no --from-run, --transaction or --label")
        args.note = check_note(args.note, True, "--unsent")


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--approve", action="store_true", help="record approval decisions")
    mode.add_argument("--reject", action="store_true", help="record rejections (needs --note)")
    mode.add_argument("--sent", choices=["wallet", "vault"], help="mark what a run paid as sent (needs --from-run)")
    mode.add_argument("--unsent", choices=["wallet", "vault"], help="undo the marks of --run (needs --note)")
    parser.add_argument("--confirmation-id", action="append", default=[], help="a confirmation id (repeatable)")
    parser.add_argument("--from-csv", action="append", default=[], type=Path,
                        help="CSV with an id and/or address column, e.g. a confirmed-wallets export (repeatable)")
    parser.add_argument("--from-run", type=Path, help="safe-batch (wallet) or vault-batch (vault) run directory")
    parser.add_argument("--transaction", action="append", default=[], type=int,
                        help="with --sent: only this Safe transaction of the run, by its index (repeatable)")
    parser.add_argument("--run", default="", help="with --unsent: the run name whose marks to undo")
    parser.add_argument("--label", default="", help="with --approve/--reject: a name for this round, e.g. approved-1")
    parser.add_argument("--note", default="", help="free text stored with each row (one line)")
    parser.add_argument("--confirmations", type=Path)
    parser.add_argument("--vault-shares", type=Path)
    parser.add_argument("--exceptions", type=Path)
    parser.add_argument("--reviews", type=Path)
    parser.add_argument("--plan-out", type=Path, help="CSV of the rows to insert")
    parser.add_argument("--meta-out", type=Path, help="'<planned rows> <review rows read> <max review id>'")
    parser.add_argument("--check-only", action="store_true",
                        help="check the arguments and input files, then stop; needs no extracts")
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    try:
        check_args(args)
        run = load_run(args.from_run, args.sent, args.transaction) if args.sent else None
        targets = read_targets(args.confirmation_id, args.from_csv) if (args.confirmation_id or args.from_csv) else []
        if args.check_only:
            return 0
        missing = [f"--{n.replace('_', '-')}" for n in ("confirmations", "reviews", "plan_out", "meta_out")
                   if getattr(args, n) is None]
        if missing:
            raise rt.ReviewError(f"missing {', '.join(missing)}")
        items = cw.build(cw.read_rows(args.confirmations), cw.read_rows(args.vault_shares),
                         cw.read_rows(args.exceptions))
        state = rt.ReviewState(cw.read_rows(args.reviews))
        cw.apply_reviews(items, state)
        planner = Planner(items, state)
        if args.approve or args.reject:
            planner.plan_decision(targets, args.approve, args.label, args.note)
        elif args.sent:
            planner.plan_sent(run, args.note)
        else:
            planner.plan_unsent(args.unsent, args.run, targets, args.note)
        planner.finish()
    except rt.ReviewError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except PlanError as exc:
        print(f"error: nothing planned; fix these first ({len(exc.problems)}):", file=sys.stderr)
        for problem in exc.problems[:SHOW_PROBLEMS]:
            print(f"  {problem}", file=sys.stderr)
        if len(exc.problems) > SHOW_PROBLEMS:
            print(f"  … and {len(exc.problems) - SHOW_PROBLEMS:,} more", file=sys.stderr)
        return 2

    cw.write_csv(args.plan_out, PLAN_COLUMNS, (row.csv_row() for row in planner.rows))
    args.meta_out.write_text(f"{len(planner.rows)} {state.row_count} {state.max_id}\n", encoding="utf-8")
    sys.stdout.write("\n".join(planner.render()) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
