#!/usr/bin/env python3
"""Unit tests for the vault catalog's cutoff breakdown (injector/build_vault_catalog.py). No network."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_vault_catalog as bvc  # noqa: E402

ONE = 10**18
VAL = "0x" + "11" * 20


def policy(address, stage, reason="", treatment="issue"):
    return {"address": address, "migration_stage": stage, "stage_reason": reason, "issuance_treatment": treatment}


def stage_row(**atto):
    columns = ("initial", "exchange_manual", "next_stage", "manual_review", "not_issued", "qualified_deferred",
               "uncompiled_deferred")
    row = {f"{c}_assets_atto": str(atto.get(c, 0)) for c in columns}
    row["base_vault_assets_atto"] = str(sum(atto.values()))
    return row


class FakeInputs:
    def __init__(self, delegations, policy_rows, routing=None):
        self.delegations = [(VAL, d, a) for d, a in delegations]
        self.policy = {p["address"]: p for p in policy_rows}
        self.routing = routing or {}


def addr(n):
    return "0x" + f"{n:040x}"


class BreakdownTest(unittest.TestCase):
    def setUp(self):
        self.inputs = FakeInputs(
            [(addr(1), 5000 * ONE), (addr(2), 2000 * ONE), (addr(3), 300 * ONE), (addr(4), 900 * ONE),
             (addr(5), 7000 * ONE), (addr(6), 4000 * ONE), (addr(7), 0), (addr(8), 1500 * ONE)],
            [policy(addr(1), "initial", "wallet activity within 6 months"),
             policy(addr(2), "deferred", "wallet activity predates initial window"),
             policy(addr(4), "deferred", "below 1,000 ONE after incident deductions"),
             policy(addr(5), "next_stage", "reviewed contract allocation reserved for next stage"),
             policy(addr(6), "", "reviewed contract allocation retained in 2050 premint reserve", "not_issued"),
             policy(addr(8), "deferred", "no indexed wallet activity")],
            {(VAL, addr(8)): {"issuance_treatment": "not_issued", "migration_stage": "deferred",
                              "amount_atto": str(1000 * ONE)}},
        )

    def test_groups_each_positive_delegation_by_stage(self):
        got = bvc.merged(bvc.cutoff_breakdown(self.inputs)[VAL])
        self.assertEqual(got["initial"], {"count": 1, "atto": str(5000 * ONE)})
        # addr(2), plus the 500 ONE of addr(8) the routing exception leaves issued
        self.assertEqual(got["inactive"], {"count": 2, "atto": str(2500 * ONE)})
        # addr(3) is not in the policy (under 1,000 ONE in total); addr(4) fell under it after deductions
        self.assertEqual(got["below_threshold"], {"count": 2, "atto": str(1200 * ONE)})
        self.assertEqual(got["next_stage"], {"count": 1, "atto": str(7000 * ONE)})
        self.assertEqual(got["not_issued"], {"count": 1, "atto": str(5000 * ONE)})
        self.assertEqual(sum(v["count"] for v in got.values()), 7)

    def test_matches_the_stage_file_or_stops(self):
        breakdown = bvc.cutoff_breakdown(self.inputs)
        good = stage_row(initial=5000 * ONE, next_stage=7000 * ONE, not_issued=5000 * ONE,
                         qualified_deferred=3400 * ONE, uncompiled_deferred=300 * ONE)
        bvc.check_against_stages(breakdown, {VAL: good})
        bad = dict(good, initial_assets_atto=str(4999 * ONE))
        with self.assertRaises(SystemExit):
            bvc.check_against_stages(breakdown, {VAL: bad})

    def test_portal_approved_inactive_stake_is_confirmed(self):
        breakdown = bvc.cutoff_breakdown(self.inputs, {(VAL, addr(2))})
        got = bvc.merged(breakdown[VAL])
        self.assertEqual(got["confirmed"], {"count": 1, "atto": str(2000 * ONE)})
        self.assertEqual(got["inactive"], {"count": 1, "atto": str(500 * ONE)})
        bvc.check_against_stages(breakdown, {VAL: stage_row(initial=5000 * ONE, next_stage=7000 * ONE, not_issued=5000 * ONE,
                                                           qualified_deferred=3400 * ONE, uncompiled_deferred=300 * ONE)})
        with self.assertRaises(SystemExit):
            bvc.cutoff_breakdown(self.inputs, {(VAL, addr(1))})  # initial stage, not inactive
        with self.assertRaises(SystemExit):
            bvc.cutoff_breakdown(self.inputs, {(VAL, addr(99))})  # no delegation at the cutoff

    def test_exchange_and_manual_review_routes(self):
        inputs = FakeInputs([(addr(1), 10 * ONE), (addr(2), 20 * ONE)], [], {
            (VAL, addr(1)): {"issuance_treatment": "manual_from_reserve", "migration_stage": "exchange_manual",
                             "amount_atto": str(10 * ONE)},
            (VAL, addr(2)): {"issuance_treatment": "issue", "migration_stage": "manual_review",
                             "amount_atto": str(20 * ONE)},
        })
        got = bvc.merged(bvc.cutoff_breakdown(inputs)[VAL])
        self.assertEqual(got["exchange"], {"count": 1, "atto": str(10 * ONE)})
        self.assertEqual(got["manual_review"], {"count": 1, "atto": str(20 * ONE)})

    def test_commission_rate_text(self):
        self.assertEqual(bvc.rate_text("0.100000000000000000"), "0.1")
        self.assertEqual(bvc.rate_text("0"), "0")
        with self.assertRaises(SystemExit):
            bvc.rate_text("1.5")


if __name__ == "__main__":
    unittest.main()
