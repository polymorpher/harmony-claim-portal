#!/usr/bin/env python3
"""Unit tests for the confirmed-wallets report. No database."""

import csv
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from importlib.machinery import SourceFileLoader

HERE = Path(__file__).resolve().parent
loader = SourceFileLoader("confirmed_wallets", str(HERE / "confirmed-wallets.py"))
mod = loader.load_module()

ONE = 10**18
ALICE = "0x" + "aa" * 20
BOB = "0x" + "bb" * 20
VAL1 = "0x" + "11" * 20
VAL2 = "0x" + "22" * 20
SIG = "0x" + "ab" * 65


def confirmation(**kwargs):
    base = {
        "id": "1",
        "address": ALICE,
        "signer": ALICE,
        "confirmed_at_utc": "2026-09-22T00:13:02Z",
        "data_version": "2026-09-17",
        "policy_version": "migration-policy-20260917",
        "stage_reason": mod.PREDATES,
        "signature": SIG,
        "message": "line one\nline two",
        "still_candidate": "t",
        "in_ledger": "t",
        "account_category": "ordinary_eoa",
        "meets_threshold": "t",
        "stage_policy_applied": "t",
        "migration_stage": "deferred",
        "issuance_treatment": "issue",
        "migration_allocation_atto": str(1500 * ONE),
        "migration_wallet_allocation_atto": str(1000 * ONE),
        "migration_staked_to_vault_atto": str(500 * ONE),
        "liquid_shard0_atto": str(990 * ONE),
        "liquid_shard1_atto": "0",
        "pending_undelegation_atto": "0",
        "unclaimed_staking_reward_atto": str(10 * ONE),
        "pending_cross_shard_atto": "0",
        "wone_balance_atto": "0",
        "wone_airdrop_atto": "0",
        "native_wallet_airdrop_atto": str(1000 * ONE),
        "wallet_airdrop_atto": str(1000 * ONE),
        "staked_to_vault_atto": str(500 * ONE),
        "qualification_total_atto": str(1500 * ONE),
        "total_claim_atto": str(1500 * ONE),
        "last_activity_utc": "2025-10-11T22:10:39Z",
        "last_activity_type": "regular",
        "review_status": "",
        "review_batch_id": "",
        "reviewed_at_utc": "",
    }
    base.update(kwargs)
    return base


def vault(address=ALICE, validator=VAL1, staked=300 * ONE, **kwargs):
    base = {
        "address": address,
        "validator_address": validator,
        "validator_name": "Validator One",
        "staked_to_vault_atto": str(staked),
        "is_self_delegation": "f",
        "priority": "f",
        "governor_status": "ready",
    }
    base.update(kwargs)
    return base


def candidates(**kwargs):
    base = {
        "data_version": "2026-09-17",
        "policy_version": "migration-policy-20260917",
        "cutoff_utc": "2026-09-10T14:00:00Z",
        "candidates": "4",
        "candidates_predates_window": "3",
        "candidates_no_activity": "1",
        "candidates_allocation_atto": str(6000 * ONE),
        "candidates_wallet_allocation_atto": str(5000 * ONE),
        "candidates_staked_to_vault_atto": str(1000 * ONE),
    }
    base.update(kwargs)
    return base


def write(path, rows):
    with path.open("w", newline="") as handle:
        if not rows:
            handle.write("")
            return
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


class AmountTests(unittest.TestCase):
    def test_atto_to_one_is_exact_and_truncates(self):
        self.assertEqual(mod.atto_to_one(100067874087685202988751), "100067.874087685202988751")
        self.assertEqual(mod.atto_to_one(100067874087685202988751, 4), "100067.874")
        self.assertEqual(mod.atto_to_one(0), "0")
        self.assertEqual(mod.atto_to_one(-5 * ONE), "-5")

    def test_format_one_groups_thousands(self):
        self.assertEqual(mod.format_one(100067874087685202988751), "100,067.874")
        self.assertEqual(mod.format_one(1234567 * ONE + 5 * 10**17), "1,234,567.5")
        self.assertEqual(mod.format_one(0), "0")

    def test_percent(self):
        self.assertEqual(mod.percent(1, 4), "25.00%")
        self.assertEqual(mod.percent(1, 0), "n/a")


class BuildTests(unittest.TestCase):
    def test_vault_shares_and_adjustments_follow_the_lookup_api(self):
        items = mod.build(
            [confirmation()],
            [vault(), vault(validator=VAL2, staked=200 * ONE, validator_name="", is_self_delegation="t")],
            [
                {"address": ALICE, "component": "vault_shares", "validator_address": VAL2,
                 "destination_status": "not_issuing", "amount_atto": str(50 * ONE)},
                {"address": ALICE, "component": "wallet_airdrop", "validator_address": "",
                 "destination_status": "hold", "amount_atto": str(7 * ONE)},
            ],
        )
        self.assertEqual(len(items), 1)
        c = items[0]
        self.assertEqual([v.validator_address for v in c.vaults], [VAL1, VAL2])
        self.assertEqual(c.vaults[1].expected_shares, 150 * ONE)
        self.assertTrue(c.vaults[1].is_self)
        self.assertEqual(c.wallet_adjustments.held, 7 * ONE)
        self.assertEqual(c.wallet_net, 1000 * ONE)
        self.assertEqual(c.vault_breakdown_text(), f"{VAL1}=300;{VAL2}=150")
        row = c.csv_row()
        self.assertEqual(row["total_allocation_one"], "1500")
        self.assertEqual(row["vault_count"], "2")
        self.assertEqual(row["signer_matches"], "yes")
        self.assertEqual(list(row.keys()), mod.CSV_COLUMNS)

    def test_signer_mismatch_and_missing_ledger_row(self):
        items = mod.build(
            [confirmation(signer=BOB, in_ledger="f", migration_allocation_atto="", account_category="")],
            [],
            [],
        )
        c = items[0]
        self.assertFalse(c.signer_matches)
        self.assertFalse(c.in_ledger)
        self.assertEqual(c.total_allocation, 0)
        text = "\n".join(mod.render_record(1, c))
        self.assertIn("DOES NOT MATCH ADDRESS", text)
        self.assertIn("not in the loaded ledger", text)
        self.assertIn(SIG, text)


class StatsTests(unittest.TestCase):
    def test_amounts_count_each_wallet_once(self):
        items = mod.build(
            [
                confirmation(),
                confirmation(id="2", data_version="2026-09-01", still_candidate="f",
                             confirmed_at_utc="2026-09-21T10:00:00Z"),
                confirmation(id="3", address=BOB, signer=BOB, stage_reason=mod.NO_ACTIVITY,
                             account_category="validator_account", review_status="queued",
                             review_batch_id="later-1",
                             migration_allocation_atto=str(4500 * ONE),
                             migration_wallet_allocation_atto=str(4500 * ONE),
                             migration_staked_to_vault_atto="0",
                             confirmed_at_utc="2026-09-22T12:00:00Z"),
            ],
            [vault()],
            [],
        )
        stats = mod.Stats(items, [candidates()])
        self.assertEqual(stats.rows, 3)
        self.assertEqual(stats.wallets, 2)
        self.assertEqual(stats.total_allocation, 6000 * ONE)
        self.assertEqual(stats.wallet_allocation, 5500 * ONE)
        self.assertEqual(stats.vault_allocation, 500 * ONE)
        self.assertEqual(stats.still_candidate, 2)
        self.assertEqual(stats.by_reason[mod.PREDATES], 2)
        self.assertEqual(stats.by_category["validator_account"], 1)
        self.assertEqual(stats.review["queued"], 1)
        self.assertEqual(stats.review["none"], 2)
        self.assertEqual(stats.first, "2026-09-21T10:00:00Z")
        self.assertEqual(stats.last, "2026-09-22T12:00:00Z")
        self.assertEqual(stats.candidates, 4)
        text = "\n".join(mod.render_stats(stats))
        self.assertIn("3 from 2 wallets (1 repeat signature", text)
        self.assertIn("wallets 50.00% of 4", text)
        self.assertIn("allocation 100.00% of 6,000 ONE", text)

    def test_empty_report(self):
        stats = mod.Stats([], [])
        text = "\n".join(mod.render_stats(stats))
        self.assertIn("0 from 0 wallets", text)


class EndToEndTests(unittest.TestCase):
    def run_main(self, tmp, *flags):
        conf = Path(tmp) / "confirmations.csv"
        vaults = Path(tmp) / "vaults.csv"
        exc = Path(tmp) / "exceptions.csv"
        cand = Path(tmp) / "candidates.csv"
        write(conf, [confirmation(), confirmation(id="2", address=BOB, signer=BOB)])
        write(vaults, [vault()])
        write(exc, [])
        write(cand, [candidates()])
        out_dir = Path(tmp) / "out"
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = mod.main([
                "--confirmations", str(conf),
                "--vault-shares", str(vaults),
                "--exceptions", str(exc),
                "--candidates", str(cand),
                "--ledger-data-version", "2026-09-17",
                "--source", "postgres://claimapi@localhost:5433/claims",
                "--out-dir", str(out_dir),
                "--generated-at", "2026-09-22T18:30:00Z",
                *flags,
            ])
        self.assertEqual(code, 0)
        return buffer.getvalue(), out_dir

    def test_terminal_report_has_timestamp_records_and_stats(self):
        with tempfile.TemporaryDirectory() as tmp:
            text, out_dir = self.run_main(tmp)
        self.assertIn("generated    2026-09-22 18:30:00 UTC", text)
        self.assertIn("source       postgres://claimapi@localhost:5433/claims", text)
        self.assertIn("ledger       data_version 2026-09-17", text)
        self.assertIn(f"#1   {ALICE}", text)
        self.assertIn("1,500 ONE not in initial airdrop  =  wallet 1,000  +  vault shares 500", text)
        self.assertIn(f"signature     {SIG}", text)
        self.assertIn("Validator One", text)
        self.assertIn("confirmations           2 from 2 wallets", text)
        self.assertFalse(out_dir.exists())

    def test_csv_flag_writes_timestamped_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            text, out_dir = self.run_main(tmp, "--csv")
            main = out_dir / "confirmed-wallets-20260922T183000Z.csv"
            vaults = out_dir / "confirmed-wallets-20260922T183000Z-vault-shares.csv"
            self.assertTrue(main.exists(), text)
            self.assertTrue(vaults.exists(), text)
            with main.open(newline="") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["signature"], SIG)
            self.assertEqual(rows[0]["message"], "line one\nline two")
            self.assertEqual(rows[0]["vault_shares_breakdown"], f"{VAL1}=300")
            with vaults.open(newline="") as handle:
                vault_rows = list(csv.DictReader(handle))
            self.assertEqual(len(vault_rows), 1)
            self.assertEqual(vault_rows[0]["staked_one"], "300")
        self.assertIn("confirmed-wallets-20260922T183000Z.csv", text)
        self.assertIn("2 rows, sha256 ", text)

    def test_compact_mode_is_one_line_per_confirmation(self):
        with tempfile.TemporaryDirectory() as tmp:
            text, _ = self.run_main(tmp, "--compact")
        lines = [line for line in text.splitlines() if line.startswith("     1  ") or line.startswith("     2  ")]
        self.assertEqual(len(lines), 2)
        self.assertNotIn(f"signature     {SIG}", text)


if __name__ == "__main__":
    unittest.main()
