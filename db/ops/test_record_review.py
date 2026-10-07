#!/usr/bin/env python3
"""Unit tests for the review planner (db/ops/record-review.py). No database."""

import contextlib
import csv
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("record_review", HERE / "record-review.py")
rr = importlib.util.module_from_spec(spec)
sys.modules["record_review"] = rr
spec.loader.exec_module(rr)
rt = rr.rt

ONE = 10**18
ALICE = "0x" + "aa" * 20
BOB = "0x" + "bb" * 20
CAROL = "0x" + "cc" * 20
OUTSIDER = "0x" + "dd" * 20
VAL1 = "0x" + "11" * 20
VAL2 = "0x" + "22" * 20


def confirmation(id, address, wallet=1000, vault=0, **kwargs):
    base = {
        "id": str(id), "address": address, "signer": address, "confirmed_at_utc": "2026-09-22T00:13:02Z",
        "data_version": "2026-09-17", "policy_version": "migration-policy-20260917",
        "stage_reason": "wallet activity predates initial window", "signature": "0x" + "ab" * 65,
        "signature_scheme": "personal_sign", "message": "m", "still_candidate": "t", "in_ledger": "t",
        "account_category": "ordinary_eoa", "migration_stage": "deferred",
        "migration_allocation_atto": str((wallet + vault) * ONE),
        "migration_wallet_allocation_atto": str(wallet * ONE),
        "migration_staked_to_vault_atto": str(vault * ONE),
        "wallet_airdrop_atto": str(wallet * ONE), "staked_to_vault_atto": str(vault * ONE),
    }
    base.update(kwargs)
    return base


def position(address, validator, staked):
    return {"address": address, "validator_address": validator, "validator_name": "", "staked_to_vault_atto":
            str(staked * ONE), "is_self_delegation": "f", "priority": "f", "governor_status": "ready"}


def review(id, confirmation_id, address, status, batch_id="", note=""):
    return {"id": str(id), "confirmation_id": str(confirmation_id), "address": address, "status": status,
            "batch_id": batch_id, "note": note, "reviewed_at_utc": "2026-10-07T01:00:00Z"}


def write_rows(path, columns, rows):
    """Returns the SHA-256 the way safe-batch and vault-batch record it, with 0x."""
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    return "0x" + hashlib.sha256(path.read_bytes()).hexdigest()


def safe_run(path, recipients, per_tx=None):
    """recipients: [(address, ONE)]; per_tx splits them into Safe transactions."""
    path.mkdir(parents=True)
    rows = [{"address": a, "amount_atto": str(n * ONE), "amount_tokens": str(n)} for a, n in recipients]
    columns = ["address", "amount_atto", "amount_tokens"]
    sha = write_rows(path / "recipients.csv", columns, rows)
    size = per_tx or len(rows)
    entries = []
    for i, start in enumerate(range(0, len(rows), size), start=1):
        folder = path / f"tx-{i:02d}"
        folder.mkdir()
        entries.append({"index": i, "folder": folder.name,
                        "recipients_sha256": write_rows(folder / "recipients.csv", columns, rows[start:start + size])})
    (path / "manifest.json").write_text(json.dumps(
        {"format": rr.SAFE_FORMAT, "recipients_sha256": sha, "transactions": entries}, indent=1))
    return path


def vault_run(path, deposits, phase="all"):
    """deposits: [(validator, delegator, ONE)]; one deploy transaction, then one fund transaction."""
    path.mkdir(parents=True)
    columns = ["validator_address", "vault_address", "delegator_address", "delegator_one1", "amount_atto", "amount_one"]
    rows = [{"validator_address": v, "vault_address": "0x" + "ee" * 20, "delegator_address": d, "delegator_one1": "",
             "amount_atto": str(n * ONE), "amount_one": str(n)} for v, d, n in deposits]
    sha = write_rows(path / "deposits.csv", columns, rows)
    (path / "tx-01-deploy").mkdir()
    deploy_sha = write_rows(path / "tx-01-deploy" / "vaults.csv", ["validator_address"], [{"validator_address": VAL1}])
    (path / "tx-02-fund").mkdir()
    fund_sha = write_rows(path / "tx-02-fund" / "deposits.csv", columns, rows)
    (path / "manifest.json").write_text(json.dumps({
        "format": rr.VAULT_FORMAT, "phase": phase, "file_sha256": {"deposits.csv": sha},
        "transactions": [{"index": 1, "folder": "tx-01-deploy", "kind": "deploy", "list_sha256": deploy_sha},
                         {"index": 2, "folder": "tx-02-fund", "kind": "fund", "list_sha256": fund_sha}]}, indent=1))
    return path


class PlannerCase(unittest.TestCase):
    confirmations = [
        confirmation(1, ALICE, wallet=1000, vault=500),
        confirmation(2, BOB, wallet=2000),
        confirmation(3, CAROL, wallet=300, still_candidate="f", data_version="2026-09-01"),
    ]
    positions = [position(ALICE, VAL1, 300), position(ALICE, VAL2, 200)]

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def plan(self, *flags, reviews=()):
        d = self.dir
        write_rows(d / "confirmations.csv", list(self.confirmations[0].keys()), self.confirmations)
        write_rows(d / "vault-shares.csv", list(self.positions[0].keys()), self.positions)
        write_rows(d / "exceptions.csv", ["address", "component", "validator_address", "destination_status",
                                          "amount_atto"], [])
        write_rows(d / "reviews.csv", ["id", "confirmation_id", "address", "status", "batch_id", "note",
                                       "reviewed_at_utc"], list(reviews))
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = rr.main([
                "--confirmations", str(d / "confirmations.csv"), "--vault-shares", str(d / "vault-shares.csv"),
                "--exceptions", str(d / "exceptions.csv"), "--reviews", str(d / "reviews.csv"),
                "--plan-out", str(d / "plan.csv"), "--meta-out", str(d / "meta"), *flags])
        rows = []
        if code == 0:
            with (d / "plan.csv").open(newline="") as handle:
                rows = list(csv.DictReader(handle))
        return code, rows, out.getvalue() + err.getvalue()


class DecisionTests(PlannerCase):
    def test_approve_from_a_confirmed_wallets_export(self):
        export = self.dir / "approved.csv"
        write_rows(export, ["id", "address", "wallet_allocation_atto"],
                   [{"id": "1", "address": ALICE, "wallet_allocation_atto": "x"},
                    {"id": "", "address": BOB, "wallet_allocation_atto": "x"}])
        code, rows, text = self.plan("--approve", "--from-csv", str(export), "--label", "approved-1",
                                     reviews=[review(7, 2, BOB, "queued")])
        self.assertEqual(code, 0, text)
        self.assertEqual([(r["confirmation_id"], r["status"], r["batch_id"]) for r in rows],
                         [("1", "queued", "approved-1")])
        self.assertIn("1 already approved (left out)", text)
        self.assertEqual((self.dir / "meta").read_text(), "1 1 7\n")

    def test_approve_refuses_mismatch_superseded_and_duplicates(self):
        code, _, text = self.plan("--approve", "--confirmation-id", "3", "--confirmation-id", "9",
                                  "--confirmation-id", "2", "--confirmation-id", "2")
        self.assertEqual(code, 2)
        self.assertIn("no longer the candidate set", text)
        self.assertIn("confirmation 9 does not exist", text)
        self.assertIn("listed twice", text)
        export = self.dir / "wrong.csv"
        write_rows(export, ["id", "address"], [{"id": "1", "address": BOB}])
        code, _, text = self.plan("--approve", "--from-csv", str(export))
        self.assertEqual(code, 2)
        self.assertIn(f"confirmation 1 belongs to {ALICE}, not {BOB}", text)

    def test_reject_needs_a_note_and_changes_an_approval(self):
        code, _, text = self.plan("--reject", "--confirmation-id", "2")
        self.assertEqual(code, 2)
        self.assertIn("--reject needs --note", text)
        code, rows, text = self.plan("--reject", "--confirmation-id", "2", "--note", "not the holder",
                                     reviews=[review(1, 2, BOB, "queued")])
        self.assertEqual(code, 0, text)
        self.assertEqual((rows[0]["status"], rows[0]["note"]), ("rejected", "not the holder"))
        self.assertIn("1 changing an earlier decision", text)


class SentWalletTests(PlannerCase):
    approved = [review(1, 1, ALICE, "queued"), review(2, 2, BOB, "queued")]

    def test_marks_confirmed_recipients_and_leaves_others_out(self):
        run = safe_run(self.dir / "runs" / "confirmed-wallets-1", [(ALICE, 1000), (BOB, 2000), (OUTSIDER, 5)])
        code, rows, text = self.plan("--sent", "wallet", "--from-run", str(run), reviews=self.approved)
        self.assertEqual(code, 0, text)
        sha = hashlib.sha256((run / "manifest.json").read_bytes()).hexdigest()
        self.assertEqual([(r["address"], r["status"], r["batch_id"]) for r in rows],
                         [(ALICE, "included", "wallet:confirmed-wallets-1"), (BOB, "included", "wallet:confirmed-wallets-1")])
        self.assertEqual(rows[0]["note"], f"manifest={sha}")
        self.assertIn("1 recipient, 5 ONE, to addresses without a confirmation", text)

    def test_one_transaction_of_the_run(self):
        run = safe_run(self.dir / "confirmed-wallets-1", [(ALICE, 1000), (BOB, 2000)], per_tx=1)
        code, rows, text = self.plan("--sent", "wallet", "--from-run", str(run), "--transaction", "2",
                                     reviews=self.approved)
        self.assertEqual(code, 0, text)
        self.assertEqual([r["address"] for r in rows], [BOB])
        self.assertIn("transactions  2 of 2", text)

    def test_refuses_unapproved_and_wrong_amounts(self):
        run = safe_run(self.dir / "confirmed-wallets-1", [(ALICE, 999), (BOB, 2000)])
        code, _, text = self.plan("--sent", "wallet", "--from-run", str(run), reviews=self.approved[:1])
        self.assertEqual(code, 2)
        self.assertIn("is not reviewed; approve it first", text)
        self.assertIn(f"the run pays {ALICE} 999 ONE; in the ledger its wallet part is 1,000 ONE", text)

    def test_same_run_again_is_a_no_op_and_another_run_is_a_double_payment(self):
        run = safe_run(self.dir / "confirmed-wallets-1", [(ALICE, 1000)])
        sha = hashlib.sha256((run / "manifest.json").read_bytes()).hexdigest()
        done = self.approved + [review(3, 1, ALICE, "included", "wallet:confirmed-wallets-1", f"manifest={sha}")]
        code, rows, text = self.plan("--sent", "wallet", "--from-run", str(run), reviews=done)
        self.assertEqual((code, rows), (0, []), text)
        self.assertIn("1 recorded for this run before", text)
        other = safe_run(self.dir / "confirmed-wallets-2", [(ALICE, 1000)])
        code, _, text = self.plan("--sent", "wallet", "--from-run", str(other), reviews=done)
        self.assertEqual(code, 2)
        self.assertIn(f"{ALICE}: its wallet part is already marked sent by run confirmed-wallets-1", text)
        self.assertIn("this run would pay twice", text)

    def test_reused_run_name_with_another_manifest_is_refused(self):
        run = safe_run(self.dir / "confirmed-wallets", [(BOB, 2000)])
        old = self.approved + [review(3, 1, ALICE, "included", "wallet:confirmed-wallets", "manifest=" + "0" * 64)]
        code, _, text = self.plan("--sent", "wallet", "--from-run", str(run), reviews=old)
        self.assertEqual(code, 2)
        self.assertIn("run name confirmed-wallets is already recorded from another manifest.json", text)

    def test_edited_list_and_wrong_run_kind_are_refused(self):
        run = safe_run(self.dir / "confirmed-wallets-1", [(ALICE, 1000)])
        with (run / "recipients.csv").open("a") as handle:
            handle.write(f"{BOB},{2000 * ONE},2000\n")
        code, _, text = self.plan("--sent", "wallet", "--from-run", str(run), reviews=self.approved)
        self.assertEqual(code, 2)
        self.assertIn("SHA-256 differs from manifest.json", text)
        vrun = vault_run(self.dir / "vaults-pilot-1", [(VAL1, ALICE, 300)])
        code, _, text = self.plan("--sent", "wallet", "--from-run", str(vrun), reviews=self.approved)
        self.assertEqual(code, 2)
        self.assertIn("is a vault-batch run; --sent wallet needs a safe-batch run", text)


class SentVaultTests(PlannerCase):
    approved = [review(1, 1, ALICE, "queued")]

    def test_one_row_per_validator(self):
        run = vault_run(self.dir / "vaults-pilot-1", [(VAL1, ALICE, 300), (VAL1, OUTSIDER, 70)])
        code, rows, text = self.plan("--sent", "vault", "--from-run", str(run), reviews=self.approved)
        self.assertEqual(code, 0, text)
        self.assertEqual([(r["address"], r["batch_id"], r["amount_one"]) for r in rows],
                         [(ALICE, f"vault:vaults-pilot-1:{VAL1}", "300")])
        self.assertIn("1 deposit, 70 ONE, to addresses without a confirmation", text)

    def test_deploy_transactions_and_unknown_positions(self):
        run = vault_run(self.dir / "vaults-pilot-1", [(VAL1, ALICE, 300)])
        code, _, text = self.plan("--sent", "vault", "--from-run", str(run), "--transaction", "1",
                                  reviews=self.approved)
        self.assertEqual(code, 2)
        self.assertIn("deploys vaults and moves no ONE", text)
        code, rows, _ = self.plan("--sent", "vault", "--from-run", str(run), "--transaction", "2",
                                  reviews=self.approved)
        self.assertEqual(len(rows), 1)
        deploy_only = vault_run(self.dir / "vaults-deploy-1", [(VAL1, ALICE, 300)], phase="deploy")
        code, _, text = self.plan("--sent", "vault", "--from-run", str(deploy_only), reviews=self.approved)
        self.assertEqual(code, 2)
        self.assertIn("only deploys vaults", text)
        stray = vault_run(self.dir / "vaults-3", [("0x" + "33" * 20, ALICE, 300)])
        code, _, text = self.plan("--sent", "vault", "--from-run", str(stray), reviews=self.approved)
        self.assertEqual(code, 2)
        self.assertIn("has no vault shares with 0x3333", text)


class UnsentTests(PlannerCase):
    def test_undo_keeps_the_batch_id_and_manifest(self):
        sha = "ab" * 32
        marks = [review(1, 1, ALICE, "queued"), review(2, 2, BOB, "queued"),
                 review(3, 1, ALICE, "included", "wallet:confirmed-wallets-1", f"manifest={sha}"),
                 review(4, 2, BOB, "included", "wallet:confirmed-wallets-1", f"manifest={sha}")]
        code, rows, text = self.plan("--unsent", "wallet", "--run", "confirmed-wallets-1",
                                     "--confirmation-id", "2", "--note", "tx 2 failed", reviews=marks)
        self.assertEqual(code, 0, text)
        self.assertEqual([(r["address"], r["status"], r["batch_id"], r["note"]) for r in rows],
                         [(BOB, "queued", "wallet:confirmed-wallets-1", f"manifest={sha}; undo: tx 2 failed")])
        code, _, text = self.plan("--unsent", "vault", "--run", "confirmed-wallets-1", "--note", "x", reviews=marks)
        self.assertEqual(code, 2)
        self.assertIn("nothing is marked sent by run confirmed-wallets-1 for the vault part", text)


class ArgumentTests(unittest.TestCase):
    def run_check(self, *flags):
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            code = rr.main(["--check-only", *flags])
        return code, err.getvalue()

    def test_check_only_needs_no_extracts(self):
        self.assertEqual(self.run_check("--approve", "--confirmation-id", "4")[0], 0)

    def test_mode_specific_flags(self):
        self.assertIn("needs --from-run", self.run_check("--sent", "wallet")[1])
        self.assertIn("takes no --confirmation-id", self.run_check("--sent", "wallet", "--from-run", "/tmp",
                                                                   "--confirmation-id", "1")[1])
        self.assertIn("--unsent needs --note", self.run_check("--unsent", "wallet", "--run", "x")[1])
        self.assertIn("one line", self.run_check("--approve", "--confirmation-id", "1", "--note", "a\nb")[1])
        self.assertIn("--label", self.run_check("--approve", "--confirmation-id", "1", "--label", "wallet:x")[1])
        self.assertIn("positive integer", self.run_check("--approve", "--confirmation-id", "0")[1])


if __name__ == "__main__":
    unittest.main()
