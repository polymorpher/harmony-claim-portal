#!/usr/bin/env python3
"""Unit tests for confirmation candidate selection. No database and no claim data."""

import csv
import json
import tempfile
import unittest
from pathlib import Path

from importlib.machinery import SourceFileLoader

HERE = Path(__file__).resolve().parent
loader = SourceFileLoader("load_candidates", str(HERE / "load-candidates.py"))
mod = loader.load_module()


def row(**kwargs):
    base = {
        "address": "0x" + "11" * 20,
        "account_classification": "wallet",
        "routing_category": "automatic_policy",
        "migration_stage": "deferred",
        "issuance_treatment": "issue",
        "stage_reason": "wallet activity predates initial window",
        "migration_allocation_atto": "1000",
    }
    base.update(kwargs)
    return base


class SelectTests(unittest.TestCase):
    def test_keeps_deferred_wallets_and_drops_the_rest(self):
        exchange = "0x" + "22" * 20
        chosen, counts = mod.select_candidates(
            [
                row(),
                row(address="0x" + "33" * 20, account_classification="validator_wallet",
                    stage_reason="no indexed wallet activity"),
                row(address=exchange),
                row(address="0x" + "44" * 20, migration_stage="initial",
                    stage_reason="wallet activity within 6 months"),
                row(address="0x" + "55" * 20, account_classification="genuine_contract"),
                row(address="0x" + "66" * 20, routing_category="exchange_or_manual"),
                row(address="0x" + "77" * 20, migration_allocation_atto="0"),
            ],
            {exchange},
            "2026-09-17",
            "migration-policy-20260917",
            "2026-09-10T14:00:00Z",
        )
        self.assertEqual([item["address"] for item in chosen], ["0x" + "11" * 20, "0x" + "33" * 20])
        self.assertEqual(chosen[1]["account_category"], "validator_account")
        self.assertEqual(counts["excluded_exchange"], 1)
        self.assertEqual(counts["excluded_stage"], 1)
        self.assertEqual(counts["excluded_classification"], 1)
        self.assertEqual(counts["excluded_routing"], 1)
        self.assertEqual(counts["excluded_zero_allocation"], 1)

    def test_migration_repo_requires_exchange_audits(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "exchanges").mkdir()
            (repo / "exchanges" / "exchange-policy.json").write_text(json.dumps({"exchanges": []}))
            with self.assertRaises(SystemExit):
                mod.load_exchange_addresses(repo)

    def test_writes_a_header_even_when_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "out.csv"
            mod.write_candidates(path, [])
            with path.open() as handle:
                self.assertEqual(
                    next(csv.reader(handle)),
                    ["address", "account_category", "stage_reason", "data_version", "policy_version", "cutoff_time_utc"],
                )


if __name__ == "__main__":
    unittest.main()
