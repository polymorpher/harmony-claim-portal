#!/usr/bin/env python3
"""Unit tests for the confirmed-wallets report. No database."""

import contextlib
import csv
import importlib.util
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("confirmed_wallets", HERE / "confirmed-wallets.py")
mod = importlib.util.module_from_spec(spec)
sys.modules["confirmed_wallets"] = mod
spec.loader.exec_module(mod)

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
        "signature_scheme": "personal_sign",
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
    }
    base.update(kwargs)
    return base


def review(id, confirmation_id, address, status, batch_id="", note="", at="2026-10-07T01:00:00Z"):
    return {"id": str(id), "confirmation_id": str(confirmation_id), "address": address, "status": status,
            "batch_id": batch_id, "note": note, "reviewed_at_utc": at}


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
                             account_category="validator_account",
                             migration_allocation_atto=str(4500 * ONE),
                             migration_wallet_allocation_atto=str(4500 * ONE),
                             migration_staked_to_vault_atto="0",
                             confirmed_at_utc="2026-09-22T12:00:00Z"),
            ],
            [vault()],
            [],
        )
        state = mod.rt.ReviewState([review(1, 3, BOB, "queued", "later-1")])
        mod.apply_reviews(items, state)
        stats = mod.Stats(items, [candidates()], state)
        self.assertEqual(stats.rows, 3)
        self.assertEqual(stats.wallets, 2)
        self.assertEqual(stats.total_allocation, 6000 * ONE)
        self.assertEqual(stats.wallet_allocation, 5500 * ONE)
        self.assertEqual(stats.vault_allocation, 500 * ONE)
        self.assertEqual(stats.still_candidate, 2)
        self.assertEqual(stats.by_reason[mod.PREDATES], 2)
        self.assertEqual(stats.by_category["validator_account"], 1)
        self.assertEqual(stats.decisions["approved"], 1)
        self.assertEqual(stats.decisions["none"], 2)
        self.assertEqual(stats.wallet_count["pending"], 2)
        self.assertEqual(stats.wallet_amount["pending"], 5500 * ONE)
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


class ReviewTrackTests(unittest.TestCase):
    def test_batch_ids_split_into_tracks(self):
        rt = mod.rt
        self.assertEqual(rt.wallet_batch_id("confirmed-wallets-1"), "wallet:confirmed-wallets-1")
        self.assertEqual(rt.vault_batch_id("vaults-pilot-1", VAL1.upper().replace("0X", "0x")),
                         f"vault:vaults-pilot-1:{VAL1}")
        with self.assertRaises(rt.ReviewError):
            rt.wallet_batch_id("runs/x")
        with self.assertRaises(rt.ReviewError):
            rt.wallet_batch_id("a:b")
        rows = [
            review(1, 1, ALICE, "queued", "approved-1"),
            review(2, 1, ALICE, "included", "wallet:confirmed-wallets-1", rt.manifest_note("ab" * 32)),
            review(3, 1, ALICE, "included", f"vault:vaults-pilot-1:{VAL1}"),
            review(4, 1, ALICE, "included", "wallet:bad/run"),
            review(5, 1, ALICE, "rejected", f"vault:vaults-pilot-1:{VAL2}"),
            review(6, 1, ALICE, "queued", ""),
        ]
        state = rt.ReviewState(rows)
        self.assertEqual([r.track for r in state.reviews],
                         ["decision", "wallet", "vault", "unrecognised", "unrecognised", "decision"])
        self.assertEqual(state.decision_of("1")[0], "approved")
        self.assertEqual(state.decision["1"].id, 6)
        self.assertEqual(state.wallet_sent(ALICE).run, "confirmed-wallets-1")
        self.assertEqual(state.vault_sent(ALICE, VAL1).run, "vaults-pilot-1")
        self.assertIsNone(state.vault_sent(ALICE, VAL2))
        self.assertEqual(state.run_manifests("confirmed-wallets-1"), {"ab" * 32})
        self.assertEqual((state.row_count, state.max_id), (6, 6))

    def test_later_rows_win_and_undo_returns_to_pending(self):
        rt = mod.rt
        state = rt.ReviewState([
            review(1, 1, ALICE, "included", "wallet:confirmed-wallets-1"),
            review(2, 1, ALICE, "queued", "wallet:confirmed-wallets-1", "undo: tx 2 failed"),
            review(3, 1, ALICE, "queued", ""),
            review(4, 1, ALICE, "rejected", "", "compromised key"),
        ])
        self.assertIsNone(state.wallet_sent(ALICE))
        self.assertEqual(state.decision_of("1")[0], "rejected")

    def test_sent_state_belongs_to_the_address(self):
        rt = mod.rt
        state = rt.ReviewState([review(1, 1, ALICE, "included", "wallet:confirmed-wallets-1")])
        items = mod.build(
            [confirmation(), confirmation(id="2", data_version="2026-10-01", still_candidate="t")],
            [], [])
        mod.apply_reviews(items, state)
        self.assertEqual([c.wallet_status for c in items], ["sent", "sent"])
        self.assertEqual([c.decision for c in items], ["none", "none"])

    def test_included_without_part_is_an_approval_not_a_delivery(self):
        rt = mod.rt
        state = rt.ReviewState([review(1, 1, ALICE, "included", "later-1")])
        self.assertEqual(state.decision_of("1")[0], "approved")
        self.assertIsNone(state.wallet_sent(ALICE))
        self.assertEqual(state.approvals_stored_as_included(), 1)


class FilterTests(unittest.TestCase):
    def setUp(self):
        self.items = mod.build(
            [
                confirmation(),
                confirmation(id="2", address=BOB, signer=BOB, migration_staked_to_vault_atto="0"),
                confirmation(id="3", address="0x" + "cc" * 20, signer="0x" + "cc" * 20,
                             migration_wallet_allocation_atto="0", wallet_airdrop_atto="0"),
            ],
            [vault(), vault(validator=VAL2, staked=200 * ONE), vault(address="0x" + "cc" * 20, staked=50 * ONE)],
            [],
        )
        self.state = mod.rt.ReviewState([
            review(1, 1, ALICE, "queued", "approved-1"),
            review(2, 2, BOB, "queued", "approved-1"),
            review(3, 1, ALICE, "included", "wallet:confirmed-wallets-1"),
            review(4, 1, ALICE, "included", f"vault:vaults-pilot-1:{VAL1}"),
            review(5, 3, "0x" + "cc" * 20, "rejected", "", "not the holder"),
        ])
        mod.apply_reviews(self.items, self.state)

    def ids(self, **kwargs):
        return [c.id for c in mod.select(self.items, **kwargs)]

    def test_states(self):
        alice, bob, carol = self.items
        self.assertEqual((alice.decision, alice.wallet_status, alice.vault_status), ("approved", "sent", "partial"))
        self.assertEqual((bob.decision, bob.wallet_status, bob.vault_status), ("approved", "pending", "none"))
        self.assertEqual((carol.decision, carol.wallet_status, carol.vault_status), ("rejected", "none", "pending"))
        self.assertEqual(alice.review_text(),
                         "approved (approved-1, 2026-10-07 01:00:00 UTC) | wallet sent by confirmed-wallets-1 | "
                         "vault 1 of 2 sent")
        self.assertIn("rejected (2026-10-07 01:00:00 UTC): not the holder", carol.review_text())
        self.assertIn("wallet nothing to send", carol.review_text())

    def test_filters(self):
        self.assertEqual(self.ids(decision="approved"), ["1", "2"])
        self.assertEqual(self.ids(decision="approved", wallet="pending"), ["2"])
        self.assertEqual(self.ids(wallet="sent"), ["1"])
        self.assertEqual(self.ids(vault="pending"), ["1", "3"])
        self.assertEqual(self.ids(vault="partial"), ["1"])
        self.assertEqual(self.ids(vault="sent"), [])
        self.assertEqual(self.ids(runs=["vaults-pilot-1"]), ["1"])
        self.assertEqual(self.ids(runs=["confirmed-wallets-2"]), [])

    def test_vault_rows_keep_only_positions_still_to_send(self):
        approved = mod.select(self.items, decision="approved", vault="pending")
        rows = mod.vault_rows(approved, "pending")
        self.assertEqual([(v.address, v.validator_address) for v in rows], [(ALICE, VAL2)])
        self.assertEqual(len(mod.vault_rows(approved, None)), 2)
        sent = [v.csv_row() for v in mod.vault_rows(approved, None) if v.status == "sent"]
        self.assertEqual(sent[0]["sent_run"], "vaults-pilot-1")

    def test_stats_split_by_status(self):
        stats = mod.Stats(self.items, [], self.state)
        self.assertEqual(stats.decisions["approved"], 2)
        self.assertEqual(stats.wallet_count["sent"], 1)
        self.assertEqual(stats.wallet_count["none"], 1)
        self.assertEqual(stats.position_count["sent"], 1)
        self.assertEqual(stats.position_amount["pending"], 250 * ONE)
        text = "\n".join(mod.render_stats(stats))
        self.assertIn("decisions               approved 2 | rejected 1", text)
        self.assertIn("wallet part             pending 1 wallet (1,000 ONE) | sent 1 wallet (1,000 ONE) | "
                      "nothing to send 1", text)
        self.assertIn("vault shares            pending 2 positions (250 ONE) | sent 1 position (300 ONE)", text)


class EndToEndTests(unittest.TestCase):
    def run_main(self, tmp, *flags, reviews=None):
        conf = Path(tmp) / "confirmations.csv"
        vaults = Path(tmp) / "vaults.csv"
        exc = Path(tmp) / "exceptions.csv"
        cand = Path(tmp) / "candidates.csv"
        rev = Path(tmp) / "reviews.csv"
        write(conf, [
            confirmation(),
            confirmation(id="2", address=BOB, signer=BOB, signature_scheme="harmony_ledger_tx"),
        ])
        write(vaults, [vault()])
        write(exc, [])
        write(cand, [candidates()])
        write(rev, reviews or [])
        out_dir = Path(tmp) / "out"
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = mod.main([
                "--confirmations", str(conf),
                "--vault-shares", str(vaults),
                "--exceptions", str(exc),
                "--candidates", str(cand),
                "--reviews", str(rev),
                "--ledger-data-version", "2026-09-17",
                "--source", "postgres://claimapi@localhost:5433/claims",
                "--out-dir", str(out_dir),
                "--generated-at", "2026-09-22T18:30:00Z",
                *flags,
            ])
        self.assertEqual(code, 0)
        return buffer.getvalue(), out_dir

    def test_filtered_csv_names_its_filters_and_header_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            text, out_dir = self.run_main(
                tmp, "--csv", "--decision", "approved", "--wallet", "pending",
                reviews=[review(1, 2, BOB, "queued", "approved-1")])
            main = out_dir / "confirmed-wallets-20260922T183000Z-decision-approved-wallet-pending.csv"
            with main.open(newline="") as handle:
                rows = list(csv.DictReader(handle))
        self.assertEqual([r["address"] for r in rows], [BOB])
        self.assertEqual(rows[0]["decision"], "approved")
        self.assertEqual(rows[0]["decision_label"], "approved-1")
        self.assertIn("filters      decision approved, wallet pending (showing 1 of 2 confirmations)", text)
        self.assertIn("id            2", text)

    def test_no_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            text, _ = self.run_main(tmp, "--wallet", "sent")
        self.assertIn("No confirmations match these filters.", text)

    def test_bad_run_name_is_refused(self):
        with self.assertRaises(SystemExit):
            with redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                mod.parse_args(["--confirmations", "x.csv", "--run", "../etc"])

    def test_terminal_report_has_timestamp_records_and_stats(self):
        with tempfile.TemporaryDirectory() as tmp:
            text, out_dir = self.run_main(tmp)
        self.assertIn("generated    2026-09-22 18:30:00 UTC", text)
        self.assertIn("source       postgres://claimapi@localhost:5433/claims", text)
        self.assertIn("ledger       data_version 2026-09-17", text)
        self.assertIn(f"#1   {ALICE}", text)
        self.assertIn("1,500 ONE not in initial airdrop  =  wallet 1,000  +  vault shares 500", text)
        self.assertIn(f"signature     {SIG}", text)
        self.assertIn("signed with   personal_sign", text)
        self.assertIn("signed with   harmony_ledger_tx", text)
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
            self.assertEqual(rows[0]["signature_scheme"], "personal_sign")
            self.assertEqual(rows[1]["signature_scheme"], "harmony_ledger_tx")
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
