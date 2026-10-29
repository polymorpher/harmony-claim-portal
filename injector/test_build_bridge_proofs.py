#!/usr/bin/env python3
"""Unit tests for the bridge claim proof files (injector/build_bridge_proofs.py). No network."""

import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_bridge_proofs as bbp  # noqa: E402

# harmony-migration bridge-claims/test/fixtures/claim-tree.json, which TreeFixture.t.sol pays in full.
FIXTURE = json.loads((bbp.REPO / "frontend" / "src" / "bridge" / "testdata" / "claim-tree.json").read_text())

FUNDER = "0x" + "f0" * 20
WETH = "0x" + "e0" * 20
TOKEN_A = "0x" + "a1" * 20
TOKEN_B = "0x" + "b2" * 20


def addr(n):
    return "0x" + f"{n:040x}"


class KeccakTest(unittest.TestCase):
    def test_known_vectors(self):
        self.assertEqual(bbp._keccak256_pure(b"").hex(), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
        self.assertEqual(bbp._keccak256_pure(b"abc").hex(), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45")

    def test_pure_matches_backend_across_block_boundaries(self):
        for n in (0, 1, 31, 32, 64, 128, 135, 136, 137, 271, 272, 300):
            data = bytes((i * 7 + n) % 256 for i in range(n))
            self.assertEqual(bbp._keccak256_pure(data), bbp.keccak256(data), n)

    def test_checksum_address(self):
        self.assertEqual(bbp.checksum_address("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"), "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")


class TreeTest(unittest.TestCase):
    def test_matches_the_contract_fixture(self):
        rows = list(zip(FIXTURE["accounts"], FIXTURE["row_tokens"], (int(a) for a in FIXTURE["amounts"])))
        leaves = [bbp.leaf(i, a, t, v) for i, (a, t, v) in enumerate(rows)]
        self.assertEqual([bbp.hex0x(x) for x in leaves], FIXTURE["leaves"])
        levels = bbp.tree_levels(leaves)
        self.assertEqual(bbp.hex0x(levels[-1][0]), FIXTURE["root"])
        for i, leaf in enumerate(leaves):
            proof = bbp.tree_proof(levels, i)
            self.assertEqual([bbp.hex0x(x) for x in proof], FIXTURE["proofs"][i])
            self.assertTrue(bbp.tree_verify(proof, levels[-1][0], leaf))
        self.assertFalse(bbp.tree_verify(bbp.tree_proof(levels, 0), levels[-1][0], leaves[1]))


SNAPSHOT_BLOCKS = {
    "harmony": {"cutoff": (100, "2026-09-10T14:00:00Z"), "rollback": (90, "2026-08-11T23:25:37Z")},
    "ethereum": {"cutoff": (2000, "2026-09-10T13:59:59Z"), "rollback": (1900, "2026-08-11T23:25:35Z"), "state": (2100, "2026-10-19T09:25:47Z")},
    "bsc": {"rollback": (5000, "2026-08-11T23:25:37Z")},
    "base": {"cutoff": (700, "2026-09-10T13:59:59Z"), "state": (800, "2026-10-19T09:26:01Z")},
}
# pool -> (holder chain, snapshot label); DAI on Ethereum stands in for ONE, whose holders are on two chains.
POOLS = {"base-usdc": ("harmony", "cutoff"), "ethereum-eth": ("harmony", "cutoff"),
         "bsc-dai": ("bsc", "rollback"), "ethereum-dai": ("ethereum", "rollback")}


def write_allocations(root: Path, alloc_mutate=None) -> Path:
    """An allocation run in `root/alloc`: snapshot plan and bridge state, and `allocations/summary.json` recording them."""
    alloc = root / "alloc"
    (alloc / "allocations").mkdir(parents=True, exist_ok=True)
    block = lambda n, t: {"number": n, "timestamp_utc": t, "hash": "0x" + "00" * 32}
    state = {"blocks": {c: {label: block(*b) for label, b in labels.items()} for c, labels in SNAPSHOT_BLOCKS.items()}}
    plan = {
        "pools": {pid: {"claimant_chain": c, "snapshot_label": label, "snapshot_block": block(*SNAPSHOT_BLOCKS[c][label]), "status": "planned"}
                  for pid, (c, label) in POOLS.items()},
        "exposure": {"bsc": {"orphaned_one_deliveries": 3}, "ethereum": {"orphaned_one_deliveries": 0}},
    }
    docs = {"snapshot-plan.json": plan, "bridge-state.json": state}
    if alloc_mutate:
        alloc_mutate(docs)
    for name, doc in docs.items():
        (alloc / name).write_text(json.dumps(doc))
    digest = lambda name: hashlib.sha256((alloc / name).read_bytes()).hexdigest()
    summary = {"inputs": {"plan_sha256": digest("snapshot-plan.json"), "state_sha256": digest("bridge-state.json")}}
    (alloc / "allocations" / "summary.json").write_text(json.dumps(summary))
    return alloc / "allocations"


def write_run(root: Path, lists: dict, mutate=None, alloc_mutate=None):
    """A consistent claim run in `root/<run>`: summary, manifests, lists, trees, samples, index, deploy
    record, and the allocation run it was built from.

    `lists` maps a label to (chain_id, wrapped_native, assets, rows), assets as (token, symbol, decimals,
    pools) and rows as (account, token, amount) in list order. `mutate(files)` may change any file's
    text before the index is written; `alloc_mutate(docs)` the snapshot plan and bridge state."""
    run = root / "bridge-allocations-test"
    allocations = write_allocations(root, alloc_mutate)
    files: dict[str, str] = {}
    summary = {"schema_version": 1, "contracts": [],
               "inputs": {"summary.json": hashlib.sha256((allocations / "summary.json").read_bytes()).hexdigest()}}
    deployments = {"schema_version": 1, "deployments": []}
    for n, (label, (chain_id, wrapped, assets, rows)) in enumerate(lists.items()):
        lines = [",".join(bbp.CSV_HEADER)]
        symbols = {t: s for t, s, _, _ in assets}
        for i, (account, token, amount) in enumerate(rows):
            lines.append(f"{i},{account},{token},{symbols.get(token, 'X')},{amount},{amount},{label}-pool")
        claims = "\n".join(lines) + "\n"
        leaves = [bbp.leaf(i, a, t, v) for i, (a, t, v) in enumerate(rows)]
        levels = bbp.tree_levels(leaves)
        tree = "".join("0x" + node.hex() + "\n" for level in levels for node in level)
        root_hex = bbp.hex0x(levels[-1][0])
        list_sha = hashlib.sha256(claims.encode()).hexdigest()
        address = addr(0xC0 + n)
        manifest = {
            "label": label, "chain": label, "chain_id": chain_id, "funder": FUNDER, "wrapped_native": wrapped,
            "root": root_hex, "claim_count": len(rows), "list_sha256": list_sha,
            "tree_sha256": hashlib.sha256(tree.encode()).hexdigest(), "level_sizes": [len(level) for level in levels],
            "assets": [
                {"token": t, "symbol": s, "decimals": d, "pools": pools, "rows": sum(1 for r in rows if r[1] == t),
                 "total_raw": str(sum(r[2] for r in rows if r[1] == t))}
                for t, s, d, pools in assets
            ],
            "deployment": {
                "address": address, "status": "ready",
                "constructor": {"funder": FUNDER, "wrappedNative": wrapped or bbp.NATIVE, "chainId": chain_id,
                                "root": root_hex, "claimCount": len(rows), "listHash": "0x" + list_sha},
            },
        }
        samples = {"label": label, "root": root_hex, "rows": [
            {"index": 0, "account": rows[0][0], "token": rows[0][1], "amount_raw": str(rows[0][2]),
             "proof": [bbp.hex0x(x) for x in bbp.tree_proof(levels, 0)]}]}
        files[f"{label}/claims.csv"] = claims
        files[f"{label}/tree.txt"] = tree
        files[f"{label}/manifest.json"] = json.dumps(manifest, indent=1)
        files[f"{label}/samples.json"] = json.dumps(samples)
        summary["contracts"].append({"label": label, "chain": label, "chain_id": chain_id, "funder": FUNDER, "root": root_hex,
                                     "claim_count": len(rows), "list_sha256": list_sha, "address": address, "status": "ready"})
    files["summary.json"] = json.dumps(summary)
    if mutate:
        mutate(files)
    for path, text in files.items():
        (run / path).parent.mkdir(parents=True, exist_ok=True)
        (run / path).write_text(text)
    for label in lists:
        manifest_path = run / label / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        deployments["deployments"].append({
            "chain": label, "chain_id": manifest["chain_id"], "address": manifest["deployment"]["address"],
            "tx_hash": "0x" + "ab" * 32, "block": 7, "status": "0x1", "ok": True,
            "runtime_keccak256": "0x" + "cd" * 32, "runtime_matches_build": True, "immutables_match_manifest": True,
            "manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            "explorer_verification": {"constructor_args_match": True},
        })
    index = "".join(f"{hashlib.sha256((run / p).read_bytes()).hexdigest()}  {p}\n" for p in sorted(files))
    (root / "SHA256SUMS").write_text(index)
    (root / "deployments-record.json").write_text(json.dumps(deployments))
    return run


LISTS = {
    "base": (8453, None, [(TOKEN_A, "USDC", 6, ["base-usdc"])], [(addr(0x10), TOKEN_A, 5), (addr(0x20), TOKEN_A, 7)]),
    "ethereum": (1, WETH, [(bbp.NATIVE, "ETH", 18, ["ethereum-eth"]), (TOKEN_B, "DAI", 18, ["bsc-dai", "ethereum-dai"])],
                 [(addr(0x10), bbp.NATIVE, 3), (addr(0x10), TOKEN_B, 11), ("0x" + "1" + "0" * 38 + "1", TOKEN_B, 2), (addr(0x30) + "", TOKEN_B, 1)]),
}


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def build(self, lists=LISTS, mutate=None, record=None, digits=1, alloc_mutate=None, tamper=None):
        run = write_run(self.tmp, self.sorted_lists(lists), mutate, alloc_mutate)
        if record:
            data = json.loads((self.tmp / "deployments-record.json").read_text())
            record(data)
            (self.tmp / "deployments-record.json").write_text(json.dumps(data))
        if tamper:
            tamper(self.tmp)
        out = self.tmp / "out"
        deployments = self.tmp / "deployments.json"
        with contextlib.redirect_stderr(io.StringIO()):
            bbp.main(["build", "--claims-dir", str(run), "--deploy-record", str(self.tmp / "deployments-record.json"),
                      "--allocations-dir", str(self.tmp / "alloc" / "allocations"),
                      "--published-index", str(self.tmp / "SHA256SUMS"), "--out", str(out), "--deployments", str(deployments),
                      "--prefix-digits", str(digits), "--public-base", "https://example.test/claims"])
        return out / run.name / "proofs", json.loads(deployments.read_text())

    @staticmethod
    def sorted_lists(lists):
        return {label: (c, w, a, sorted(rows)) for label, (c, w, a, rows) in lists.items()}

    def refuses(self, pattern, **kwargs):
        with self.assertRaises(SystemExit) as caught:
            self.build(**kwargs)
        self.assertRegex(str(caught.exception), pattern)

    def test_writes_every_prefix_with_verifying_proofs(self):
        proofs, deployments = self.build()
        shards = sorted(p.name for p in proofs.glob("?.json"))
        self.assertEqual(shards, [f"{d:x}.json" for d in range(16)])
        rows = {}
        roots = {c["label"]: bytes.fromhex(c["root"][2:]) for c in deployments["contracts"]}
        for name in shards:
            doc = json.loads((proofs / name).read_text())
            self.assertEqual((doc["format"], doc["run"], doc["prefix"]), ("bridge-proofs/v1", "bridge-allocations-test", name[0]))
            for account, chains in doc["accounts"].items():
                self.assertTrue(account.startswith("0x" + name[0]))
                for label, list_rows in chains.items():
                    for r in list_rows:
                        leaf = bbp.leaf(r["index"], account, r["token"], int(r["amount"]))
                        self.assertTrue(bbp.tree_verify([bytes.fromhex(p[2:]) for p in r["proof"]], roots[label], leaf))
                        rows[(label, r["index"])] = (account, r["token"], int(r["amount"]))
        self.assertEqual(len(rows), 6)
        self.assertEqual(rows[("ethereum", 0)], (addr(0x10), bbp.NATIVE, 3))
        shard0 = json.loads((proofs / "0.json").read_text())
        self.assertEqual(list(shard0["accounts"][addr(0x10)]), ["ethereum", "base"])
        self.assertIn("0x" + "1" + "0" * 38 + "1", json.loads((proofs / "1.json").read_text())["accounts"])

    def test_index_and_checksums(self):
        proofs, deployments = self.build()
        index = json.loads((proofs / "index.json").read_text())
        self.assertEqual((index["files"], index["accounts"], index["rows"]), (16, 4, 6))
        self.assertEqual(index["published_index_sha256"], hashlib.sha256((self.tmp / "SHA256SUMS").read_bytes()).hexdigest())
        sums = bbp.parse_index((proofs / "SHA256SUMS").read_text(), "SHA256SUMS")
        self.assertEqual(set(sums), {f"{d:x}.json" for d in range(16)} | {"index.json", "README.md"})
        for name, digest in sums.items():
            self.assertEqual(hashlib.sha256((proofs / name).read_bytes()).hexdigest(), digest)
        self.assertEqual([c["label"] for c in index["contracts"]], ["ethereum", "base"])

    def test_deployments_for_the_page(self):
        _, deployments = self.build()
        self.assertEqual(deployments["format"], "bridge-deployments/v1")
        self.assertEqual(deployments["published_url"], "https://example.test/claims/bridge-allocations-test")
        self.assertEqual(deployments["proof_prefix_digits"], 1)
        eth, base = deployments["contracts"]
        self.assertEqual((eth["label"], eth["chain_id"], eth["claim_count"]), ("ethereum", 1, 4))
        self.assertEqual(eth["wrapped_native"], bbp.checksum_address(WETH))
        self.assertIsNone(base["wrapped_native"])
        self.assertEqual([a["symbol"] for a in eth["assets"]], ["ETH", "DAI"])
        self.assertEqual(eth["runtime_keccak256"], "0x" + "cd" * 32)
        self.assertEqual((eth["deploy_tx"], eth["deploy_block"]), ("0x" + "ab" * 32, 7))

    def test_rebuild_is_byte_identical(self):
        proofs, _ = self.build()
        first = (proofs / "SHA256SUMS").read_bytes()
        proofs, _ = self.build()
        self.assertEqual((proofs / "SHA256SUMS").read_bytes(), first)
        self.assertFalse([p for p in proofs.parent.iterdir() if p.name.startswith(".proofs")])

    def test_refuses_a_file_that_differs_from_the_published_index(self):
        def append(tmp):
            with (tmp / "bridge-allocations-test" / "base" / "claims.csv").open("a") as f:
                f.write("\n")
        self.refuses("base/claims.csv differs from the published index", tamper=append)

    def test_records_each_assets_snapshot_and_every_chains_blocks(self):
        _, deployments = self.build()
        eth, base = deployments["contracts"]
        self.assertEqual({a["symbol"]: a["pools"] for a in eth["assets"]}, {
            "ETH": [{"id": "ethereum-eth", "holders": "harmony", "snapshot": "cutoff"}],
            "DAI": [{"id": "bsc-dai", "holders": "bsc", "snapshot": "rollback"},
                    {"id": "ethereum-dai", "holders": "ethereum", "snapshot": "rollback"}],
        })
        self.assertEqual(base["assets"][0]["pools"], [{"id": "base-usdc", "holders": "harmony", "snapshot": "cutoff"}])
        blocks = deployments["snapshots"]["blocks"]
        self.assertEqual(blocks["harmony"], {"cutoff": {"number": 100, "time": "2026-09-10T14:00:00Z"},
                                             "rollback": {"number": 90, "time": "2026-08-11T23:25:37Z"}})
        self.assertEqual(blocks["ethereum"]["state"], {"number": 2100, "time": "2026-10-19T09:25:47Z"})
        self.assertEqual(deployments["snapshots"]["orphaned_one_deliveries"], {"bsc": 3})

    def test_refuses_an_allocation_run_the_claim_run_was_not_built_from(self):
        def other_summary(tmp):
            path = tmp / "alloc" / "allocations" / "summary.json"
            path.write_text(path.read_text() + " ")
        self.refuses("not the allocation summary the claim run was built from", tamper=other_summary)

        def other_plan(tmp):
            path = tmp / "alloc" / "snapshot-plan.json"
            path.write_text(path.read_text() + " ")
        self.refuses("not the snapshot-plan.json the allocation summary records", tamper=other_plan)

    def test_refuses_a_pool_whose_block_is_not_the_bridge_states(self):
        def shift(docs):
            docs["snapshot-plan.json"]["pools"]["bsc-dai"]["snapshot_block"]["number"] = 5001
        self.refuses("pool bsc-dai's snapshot block is not the bridge state's bsc rollback block", alloc_mutate=shift)

        def unplanned(docs):
            docs["snapshot-plan.json"]["pools"]["base-usdc"]["status"] = "unsupported"
        self.refuses("pool base-usdc is not planned", alloc_mutate=unplanned)

    def test_refuses_unsorted_rows(self):
        def swap(files):
            lines = files["base/claims.csv"].splitlines()
            lines[1], lines[2] = lines[2].replace("1,", "0,", 1), lines[1].replace("0,", "1,", 1)
            files["base/claims.csv"] = "\n".join(lines) + "\n"
            manifest = json.loads(files["base/manifest.json"])
            manifest["list_sha256"] = hashlib.sha256(files["base/claims.csv"].encode()).hexdigest()
            manifest["deployment"]["constructor"]["listHash"] = "0x" + manifest["list_sha256"]
            files["base/manifest.json"] = json.dumps(manifest)
            summary = json.loads(files["summary.json"])
            summary["contracts"][0]["list_sha256"] = manifest["list_sha256"]
            files["summary.json"] = json.dumps(summary)
        self.refuses("not sorted", mutate=swap)

    def test_refuses_a_root_the_rows_do_not_give(self):
        other = "0x" + "77" * 32

        def reroot(files):
            manifest = json.loads(files["ethereum/manifest.json"])
            manifest["root"] = manifest["deployment"]["constructor"]["root"] = other
            files["ethereum/manifest.json"] = json.dumps(manifest)
            summary = json.loads(files["summary.json"])
            summary["contracts"][1]["root"] = other
            files["summary.json"] = json.dumps(summary)
        self.refuses("root rebuilt from claims.csv", mutate=reroot)

    def test_refuses_a_manifest_that_disagrees_with_the_summary(self):
        def recount(files):
            summary = json.loads(files["summary.json"])
            summary["contracts"][0]["address"] = addr(0xEE)
            files["summary.json"] = json.dumps(summary)
        self.refuses("manifest address", mutate=recount)

    def test_refuses_an_asset_total_the_rows_do_not_add_up_to(self):
        def inflate(files):
            manifest = json.loads(files["base/manifest.json"])
            manifest["assets"][0]["total_raw"] = "13"
            files["base/manifest.json"] = json.dumps(manifest)
        self.refuses("base USDC: 2 rows totalling 12, the manifest says 2 totalling 13", mutate=inflate)

    def test_refuses_a_deployment_record_that_does_not_match(self):
        def move(data):
            data["deployments"][0]["address"] = addr(0xEE)
        self.refuses("fails address", record=move)

        def unchecked(data):
            data["deployments"][1]["runtime_matches_build"] = False
        self.refuses("fails runtime code", record=unchecked)

        def missing(data):
            data["deployments"].pop()
        self.refuses("has no ethereum deployment", record=missing)

    def test_refuses_a_samples_proof_the_tree_does_not_give(self):
        def corrupt(files):
            samples = json.loads(files["ethereum/samples.json"])
            samples["rows"][0]["proof"][0] = "0x" + "00" * 32
            files["ethereum/samples.json"] = json.dumps(samples)
        self.refuses("proof of row 0 differs", mutate=corrupt)


if __name__ == "__main__":
    unittest.main()
