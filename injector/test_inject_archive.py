#!/usr/bin/env python3
"""Unit tests for the transaction-archive loader (injector/inject_archive.py). No database."""

import csv
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import inject_archive as ia  # noqa: E402

ONE = 10**18
ALICE = "0x" + "11" * 20
BOB = "0x" + "22" * 20
POOL = "0x" + "33" * 20


def h(n):
    return "0x" + format(n, "064x")


HEADERS = {
    "transactions.csv": ["shard", "branch", "kind", "block_number", "block_hash", "timestamp", "tx_index", "tx_hash",
                         "eth_hash", "from", "to", "value_atto", "fee_atto", "status", "to_shard", "method"],
    "internal_transfers.csv": ["shard", "branch", "block_number", "block_hash", "timestamp", "tx_index", "tx_hash",
                               "eth_hash", "trace_address", "type", "from", "to", "value_atto", "effective"],
    "cross_shard.csv": ["branch", "from_shard", "to_shard", "mechanism", "block_number", "block_hash", "timestamp",
                        "tx_index", "tx_hash", "from", "to", "value_atto", "ancestor_reverted", "dest_status",
                        "dest_block_number", "dest_block_hash", "dest_timestamp"],
    "staking.csv": ["shard", "branch", "type", "block_number", "block_hash", "timestamp", "tx_index", "tx_hash",
                    "delegator", "validator", "amount_atto", "status"],
}


def tx(n, block, ts, value=2 * ONE, kind="transfer", shard=0, branch="canonical", to_shard=0, status=1):
    return {"shard": shard, "branch": branch, "kind": kind, "block_number": block, "block_hash": h(9000 + block),
            "timestamp": ts, "tx_index": 0, "tx_hash": h(n), "eth_hash": h(500 + n), "from": ALICE, "to": BOB,
            "value_atto": value, "fee_atto": 21000 * 10**11, "status": status, "to_shard": to_shard, "method": ""}


def write_archive(root, tables, tamper=None, minimum=ONE):
    files = {}
    for name, fields in HEADERS.items():
        path = root / name
        with open(path, "w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
            writer.writeheader()
            writer.writerows(tables.get(name, []))
        files[name] = {"rows": len(tables.get(name, [])),
                       "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    if tamper:
        with open(root / tamper, "a") as handle:
            handle.write("\n")
    manifest = {"schema_version": 1, "kind": "harmony-transaction-archive", "min_value_atto": str(minimum),
                "notes": ["note"], "files": files, "runs": [
                    {"shard": 0, "branch": "canonical", "start": 100, "end": 200,
                     "boundaries": {"start": {"time_utc": "2025-01-01T00:00:00Z"},
                                    "end": {"time_utc": "2026-09-10T00:00:00Z"}}}]}
    (root / "manifest.json").write_text(json.dumps(manifest))


class ReadArchiveTest(unittest.TestCase):
    def tables(self):
        return {
            "transactions.csv": [tx(1, 120, 1735689720), tx(2, 110, 1735689710, kind="xshard_native", to_shard=1),
                                 tx(3, 101, 1735689705, shard=1), tx(4, 130, 1735689730, branch="rolled_back")],
            "internal_transfers.csv": [{"shard": 0, "branch": "canonical", "block_number": 120, "block_hash": h(9120),
                                        "timestamp": 1735689720, "tx_index": 0, "tx_hash": h(1), "eth_hash": h(501),
                                        "trace_address": trace, "type": "call", "from": POOL, "to": ALICE,
                                        "value_atto": 3 * ONE, "effective": 1} for trace in ("0.10", "0.2")],
            "cross_shard.csv": [{"branch": "canonical", "from_shard": 0, "to_shard": 1, "mechanism": "native",
                                 "block_number": 110, "block_hash": h(9110), "timestamp": 1735689710, "tx_index": 0,
                                 "tx_hash": h(2), "from": ALICE, "to": BOB, "value_atto": 2 * ONE,
                                 "ancestor_reverted": 0, "dest_status": "credited", "dest_block_number": 300,
                                 "dest_block_hash": h(300), "dest_timestamp": 1735689712}],
            "staking.csv": [{"shard": 0, "branch": "canonical", "type": "CollectRewards", "block_number": 140,
                             "block_hash": h(9140), "timestamp": 1735689740, "tx_index": 0, "tx_hash": h(5),
                             "delegator": ALICE, "validator": "", "amount_atto": 4 * ONE, "status": 1}],
        }

    def test_orders_records_and_assigns_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_archive(Path(tmp), self.tables())
            rows, meta = ia.read_archive(Path(tmp))
        columns = {name: index for index, name in enumerate(ia.COLUMNS)}
        summary = [(r[columns["id"]], r[columns["record_type"]], r[columns["block_number"]], r[columns["trace_address"]])
                   for r in rows]
        self.assertEqual(summary, [
            (1, "transaction", 101, None), (2, "transaction", 110, None), (3, "cross_shard", 110, None),
            (4, "transaction", 120, None), (5, "internal", 120, "0.2"), (6, "internal", 120, "0.10"),
            (7, "transaction", 130, None), (8, "staking", 140, None)])
        cross = rows[2]
        self.assertEqual(cross[columns["eth_hash"]], bytes.fromhex(h(502)[2:]))
        self.assertEqual(cross[columns["dest_status"]], "credited")
        self.assertIs(rows[6][columns["rolled_back"]], True)
        self.assertIsNone(rows[7][columns["to_addr"]])
        self.assertEqual(meta["row_counts"], {"archive_records": 8, "transaction": 4, "cross_shard": 1,
                                              "internal": 2, "staking": 1})
        self.assertEqual(meta["coverage"][0]["end_block"], 200)
        self.assertEqual(len(rows[0]), len(ia.COLUMNS))

    def test_rejects_tampered_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_archive(Path(tmp), self.tables(), tamper="staking.csv")
            with self.assertRaisesRegex(ia.ArchiveError, "SHA-256"):
                ia.read_archive(Path(tmp))

    def test_rejects_value_below_minimum_and_bad_hash(self):
        tables = self.tables()
        tables["transactions.csv"][0]["value_atto"] = ONE - 1
        with tempfile.TemporaryDirectory() as tmp:
            write_archive(Path(tmp), tables)
            with self.assertRaisesRegex(ia.ArchiveError, "below"):
                ia.read_archive(Path(tmp))
        tables = self.tables()
        tables["transactions.csv"][0]["tx_hash"] = "0x1234"
        with tempfile.TemporaryDirectory() as tmp:
            write_archive(Path(tmp), tables)
            with self.assertRaisesRegex(ia.ArchiveError, "tx hash"):
                ia.read_archive(Path(tmp))


class MethodTest(unittest.TestCase):
    def test_accepts_short_calldata_selectors(self):
        self.assertEqual(ia.method_bytes("0xa9059cbb"), bytes.fromhex("a9059cbb"))
        self.assertEqual(ia.method_bytes("0x31"), b"\x31")
        self.assertIsNone(ia.method_bytes(""))
        for bad in ("0x", "0x123", "0xa9059cbb00", "a9059cbb", "0xzz"):
            with self.assertRaises(ia.ArchiveError):
                ia.method_bytes(bad)


class FixtureTest(unittest.TestCase):
    def test_fixture_rows_match_columns(self):
        rows, meta = ia.fixture_archive()
        self.assertEqual({len(r) for r in rows}, {len(ia.COLUMNS)})
        self.assertEqual([r[0] for r in rows], list(range(1, len(rows) + 1)))
        self.assertTrue(meta["fixture"])
        self.assertEqual(sum(v for k, v in meta["row_counts"].items() if k != "archive_records"), len(rows))


if __name__ == "__main__":
    unittest.main()
