#!/usr/bin/env python3
"""Unit tests for chain-deliveries.py with a fake RPC. No network."""

import csv
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("chain_deliveries", HERE / "chain-deliveries.py")
mod = importlib.util.module_from_spec(spec)
sys.modules["chain_deliveries"] = mod
spec.loader.exec_module(mod)

ONE = 10**18
TOKEN = "0xff74317e948695297acb79cb2de06111f5cc16b3"
RESERVE = "0xf868743be6bbda38929c03616234684e6d3ded20"
VAULT = "0xb75b9f48cf1e66e89727364c4df1d90fd84f6ba8"
VALIDATOR = "0x63e7e9bb58aa72739a7cec06f6ea9fe73eb7a598"
FAKE_VAULT = "0x" + "99" * 20
ALICE = "0x" + "aa" * 20
BOB = "0x" + "bb" * 20
HEAD = 26_266_000

CATALOG = {"chain_id": 1, "token": TOKEN, "reserve": RESERVE, "start_block": 26_172_162,
           "vaults": [{"vault": VAULT, "validator": VALIDATOR}]}


def log(address, kind_topic, to, amount, block, index=0):
    return {"address": address, "topics": [kind_topic, mod.topic(RESERVE), mod.topic(to)],
            "data": "0x" + format(amount, "064x"), "blockNumber": hex(block),
            "transactionHash": "0x" + format(block, "064x"), "logIndex": hex(index)}


class FakeRpc:
    """Answers eth_getLogs from a list of logs, refusing ranges wider than `max_span`."""

    def __init__(self, logs, max_span=None, chain_id=1):
        self.logs = logs
        self.max_span = max_span
        self.chain_id = chain_id
        self.calls = []

    def __call__(self, method, params):
        self.calls.append((method, params))
        if method == "eth_chainId":
            return hex(self.chain_id)
        if method == "eth_blockNumber":
            return hex(HEAD)
        q = params[0]
        start, end = int(q["fromBlock"], 16), int(q["toBlock"], 16)
        if self.max_span is not None and end - start > self.max_span:
            raise mod.RpcError("eth_getLogs: block range too large")
        topics = q["topics"]
        return [
            l for l in self.logs
            if start <= int(l["blockNumber"], 16) <= end
            and l["topics"][0] == topics[0] and l["topics"][1] == topics[1] and l["topics"][2] in topics[2]
            and ("address" not in q or l["address"] == q["address"])
        ]


class ReadTests(unittest.TestCase):
    def test_reads_transfers_and_catalog_vault_deposits_only(self):
        logs = [
            log(TOKEN, mod.TRANSFER_TOPIC, ALICE, 1000 * ONE, 26_229_140),
            log("0x" + "77" * 20, mod.TRANSFER_TOPIC, ALICE, 5 * ONE, 26_229_141),  # another token
            log(VAULT, mod.DEPOSIT_TOPIC, ALICE, 600 * ONE, 26_237_506, 2),
            log(FAKE_VAULT, mod.DEPOSIT_TOPIC, ALICE, 9 * ONE, 26_237_507),
            log(TOKEN, mod.TRANSFER_TOPIC, "0x" + "cc" * 20, 1 * ONE, 26_229_142),  # not asked for
        ]
        rows, ignored = mod.read_payments(FakeRpc(logs), mod.Catalog(CATALOG), [ALICE, BOB], HEAD)
        self.assertEqual(ignored, 1)
        self.assertEqual(
            [(r["kind"], r["address"], r["validator_address"], r["vault_address"], int(r["amount_atto"]), r["block"]) for r in rows],
            [("wallet", ALICE, "", "", 1000 * ONE, "26229140"), ("vault", ALICE, VALIDATOR, VAULT, 600 * ONE, "26237506")],
        )

    def test_splits_ranges_the_endpoint_refuses(self):
        logs = [log(TOKEN, mod.TRANSFER_TOPIC, ALICE, ONE, 25_940_000), log(TOKEN, mod.TRANSFER_TOPIC, ALICE, ONE, 26_260_000)]
        rpc = FakeRpc(logs, max_span=50_000)
        rows, _ = mod.read_payments(rpc, mod.Catalog(CATALOG), [ALICE], HEAD)
        self.assertEqual(len(rows), 2)
        self.assertGreater(len(rpc.calls), 4)

    def test_batches_addresses(self):
        rpc = FakeRpc([])
        addresses = ["0x" + format(i, "040x") for i in range(250)]
        mod.read_payments(rpc, mod.Catalog(CATALOG), addresses, HEAD)
        self.assertEqual(len(rpc.calls), 6)  # 3 groups, a transfer and a deposit query each
        self.assertTrue(all(len(params[0]["topics"][2]) <= mod.ADDRESSES_PER_CALL for _, params in rpc.calls))


class MainTests(unittest.TestCase):
    def run_main(self, tmp, rpc):
        catalog = Path(tmp) / "catalog.json"
        catalog.write_text(json.dumps(CATALOG))
        confirmations = Path(tmp) / "confirmations.csv"
        confirmations.write_text(f"id,address\n1,{ALICE}\n")
        out = Path(tmp) / "deliveries.csv"
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = mod.main(["--confirmations", str(confirmations), "--catalog", str(catalog), "--out", str(out)], call=rpc)
        return code, stdout.getvalue(), stderr.getvalue(), out

    def test_writes_rows_and_prints_the_block(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, stdout, _, out = self.run_main(tmp, FakeRpc([log(TOKEN, mod.TRANSFER_TOPIC, ALICE, ONE, 26_229_140)]))
            with out.open(newline="") as handle:
                rows = list(csv.DictReader(handle))
        self.assertEqual(code, 0)
        self.assertEqual(stdout, f"{HEAD} fixture\n")
        self.assertEqual([r["kind"] for r in rows], ["wallet"])

    def test_refuses_another_chain(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, _, stderr, out = self.run_main(tmp, FakeRpc([], chain_id=11155111))
            self.assertFalse(out.exists())
        self.assertEqual(code, 1)
        self.assertIn("chain 11155111", stderr)


if __name__ == "__main__":
    unittest.main()
