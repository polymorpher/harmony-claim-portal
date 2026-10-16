#!/usr/bin/env python3
"""Unit tests for the attestation planner (db/ops/record-attestation.py). No database."""

import contextlib
import csv
import hashlib
import importlib.util
import io
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("record_attestation", HERE / "record-attestation.py")
ra = importlib.util.module_from_spec(spec)
sys.modules["record_attestation"] = ra
spec.loader.exec_module(ra)

ONE = 10**18
WALLET = "0x96d2b2b939a3e70088a25c061f277277c598bbaa"
WALLET_ONE1 = "one1jmft9wfe50nspz9ztsrp7fmjwlze3wa2pu3f0s"
OTHER = "0x" + "bb" * 20
SIGNED = "0x" + "cc" * 20


def candidate(address, wallet=1000, vault=500, **kwargs):
    base = {
        "address": address, "is_candidate": "t", "account_category": "ordinary_eoa",
        "stage_reason": "wallet activity predates initial window", "data_version": "2026-09-17",
        "policy_version": "migration-policy-20260917", "cutoff_utc": "2026-09-10T14:00:00Z", "in_ledger": "t",
        "migration_stage": "deferred", "issuance_treatment": "issue",
        "migration_allocation_atto": str((wallet + vault) * ONE),
        "migration_wallet_allocation_atto": str(wallet * ONE), "migration_staked_to_vault_atto": str(vault * ONE),
    }
    base.update(kwargs)
    return base


def write_rows(path, rows, columns=None):
    columns = columns or (list(rows[0].keys()) if rows else ["address"])
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


class PlannerCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.evidence = self.dir / "statement.eml"
        self.evidence.write_bytes(b"crypto.com: both wallets are ours and active\n")
        self.sha = hashlib.sha256(self.evidence.read_bytes()).hexdigest()

    def tearDown(self):
        self.tmp.cleanup()

    def run_main(self, *flags):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = ra.main(list(flags))
        return code, out.getvalue() + err.getvalue()

    def plan(self, addresses, candidates, confirmations=(), *extra):
        d = self.dir
        write_rows(d / "attest-candidates.csv", list(candidates))
        write_rows(d / "confirmations.csv", list(confirmations),
                   ["id", "address", "data_version", "policy_version", "signature_scheme", "still_candidate"])
        flags = [f for a in addresses for f in ("--address", a)]
        code, text = self.run_main(*flags, "--attested-by", "crypto.com", "--evidence", str(self.evidence),
                                   "--candidates", str(d / "attest-candidates.csv"),
                                   "--confirmations", str(d / "confirmations.csv"),
                                   "--plan-out", str(d / "plan.csv"), "--meta-out", str(d / "meta"), *extra)
        rows = []
        if code == 0:
            with (d / "plan.csv").open(newline="") as handle:
                rows = list(csv.DictReader(handle))
        return code, rows, text


class ArgumentTests(PlannerCase):
    def test_check_only_prints_addresses_as_lowercase_0x(self):
        code, text = self.run_main("--address", WALLET_ONE1, "--address", OTHER.upper().replace("0X", "0x"),
                                   "--attested-by", "crypto.com", "--evidence", str(self.evidence), "--check-only")
        self.assertEqual((code, text), (0, f"{WALLET}\n{OTHER}\n"))

    def test_bad_input_is_refused_before_any_extract(self):
        base = ["--attested-by", "crypto.com", "--evidence", str(self.evidence), "--check-only"]
        for flags, message in [
            (["--address", "one1jmft9wfe50nspz9ztsrp7fmjwlze3wa2pu3f0x"] + base, "not a 0x or one1 address"),
            (["--address", WALLET, "--address", WALLET_ONE1] + base, "is given twice"),
            (base, "at least one --address"),
            (["--address", WALLET, "--attested-by", "a\nb", "--evidence", str(self.evidence), "--check-only"],
             "--attested-by"),
            (["--address", WALLET, "--attested-by", "crypto.com", "--evidence", str(self.dir / "none"),
              "--check-only"], "no such file"),
            (["--address", WALLET, "--note", "two\nlines"] + base, "one line"),
        ]:
            code, text = self.run_main(*flags)
            self.assertEqual(code, 2, flags)
            self.assertIn(message, text)


class PlanTests(PlannerCase):
    def test_plans_one_row_per_wallet_bound_to_its_candidate_set(self):
        code, rows, text = self.plan([WALLET_ONE1, OTHER], [candidate(WALLET, 13_280_231), candidate(OTHER, 2000, 0)],
                                     (), "--note", "ticket 1234")
        self.assertEqual(code, 0, text)
        self.assertEqual([r["address"] for r in rows], [WALLET, OTHER])
        first = rows[0]
        self.assertEqual((first["data_version"], first["policy_version"], first["attested_by"], first["evidence_sha256"]),
                         ("2026-09-17", "migration-policy-20260917", "crypto.com", self.sha))
        self.assertEqual(first["wallet_allocation_atto"], str(13_280_231 * ONE))
        self.assertEqual(first["message"].splitlines(), [
            "migrate.country confirmation without a wallet signature",
            f"Address: {WALLET}",
            "Attested by: crypto.com",
            f"Evidence SHA-256: {self.sha}",
            "Note: ticket 1234",
            "Cutoff: 2026-09-10T14:00:00Z",
            "Policy version: migration-policy-20260917",
            "Data version: 2026-09-17",
        ])
        self.assertEqual((self.dir / "meta").read_text(), "2\n")
        self.assertIn("to record     2 wallets: wallet 13,282,231 ONE + vault shares 500 ONE", text)

    def test_refuses_non_candidates_ledger_problems_and_wallets_already_confirmed(self):
        signed = {"id": "7", "address": SIGNED, "data_version": "2026-09-17",
                  "policy_version": "migration-policy-20260917", "signature_scheme": "personal_sign",
                  "still_candidate": "t"}
        code, rows, text = self.plan(
            [WALLET, OTHER, SIGNED, "0x" + "dd" * 20, "0x" + "ee" * 20],
            [candidate(WALLET, is_candidate="f"), candidate(OTHER, migration_stage="initial"), candidate(SIGNED),
             candidate("0x" + "dd" * 20, in_ledger="f"), candidate("0x" + "ee" * 20)],
            [signed])
        self.assertEqual((code, rows), (2, []))
        self.assertIn(f"{WALLET}: not a confirmation candidate in the loaded set", text)
        self.assertIn(f"{OTHER}: the loaded ledger has it at stage initial, not deferred", text)
        self.assertIn(f"{SIGNED}: already confirmed under 2026-09-17 / migration-policy-20260917 "
                      "(confirmation 7, personal_sign)", text)
        self.assertIn("not in the loaded ledger", text)
        self.assertIn("fix these first (4)", text)
        self.assertFalse((self.dir / "plan.csv").exists())

    def test_a_signature_under_a_superseded_set_does_not_block(self):
        old = {"id": "3", "address": WALLET, "data_version": "2026-09-01", "policy_version": "p0",
               "signature_scheme": "personal_sign", "still_candidate": "f"}
        code, rows, text = self.plan([WALLET], [candidate(WALLET)], [old])
        self.assertEqual(code, 0, text)
        self.assertEqual(len(rows), 1)


if __name__ == "__main__":
    unittest.main()
