#!/usr/bin/env python3
"""Proof files and the contract list for the /bridge page.

    python3 injector/build_bridge_proofs.py build \\
        --claims-dir ~/git/harmony-migration/bridge-claims/runs/<run> \\
        --deploy-record ~/git/harmony-migration/bridge-claims/runs/<run>/deploy-<time>/deployments.json \\
        --allocations-dir ~/git/harmony-migration/artifacts/<allocation run>/<allocations>
    python3 injector/build_bridge_proofs.py verify-published

`build` reads a BridgeClaims run (harmony-migration `bridge-claims/`) and refuses it unless:

- every file of the run's published index (`SHA256SUMS` in the public claims bucket, or
  `--published-index`) hashes the same locally;
- each manifest agrees with `summary.json`, and its list and tree with the manifest;
- every row of `claims.csv` is well formed, rows are numbered in order and sorted by account and
  token, and each asset's rows add up to its total;
- the tree rebuilt from the rows has the manifest's root, level sizes, and tree-file SHA-256, and
  gives the proofs in `samples.json`;
- the deployment record shows each contract deployed at its manifest address, with the runtime
  code and immutables the deploy script expected;
- the allocation run's `summary.json` is the one the claim run was built from, and the snapshot
  plan and bridge state beside it are the ones that summary records. Every asset's pools are in
  the plan, each with a snapshot block that is the bridge state's block for its chain and label.

It then writes

- `frontend/src/bridge/deployments.json`: each contract's chain, address, root, row count, list
  hash, runtime code hash, and assets with the pools and snapshot each asset's rows come from,
  plus every chain's cutoff, pre-rollback, and escrow-read blocks. The page trusts only this file;
  it holds no address-level data and is committed;
- `injector/out/bridge-proofs/<run>/proofs/`: one `<prefix>.json` per address prefix (the first
  `--prefix-digits` hex digits after 0x) with every row of every address under that prefix and the
  row's proof, an empty one for a prefix without addresses, plus `index.json`, `README.md`, and
  `SHA256SUMS`. `frontend/deploy/publish-bridge-proofs.sh` uploads the folder next to the run.

`verify-published` downloads `SHA256SUMS`, `index.json`, `README.md` and a sample of proof files from
the public bucket without credentials and compares them with the local build.

Keccak-256 comes from pycryptodome (the injector's dependency); without it a pure-Python version
is used, which is correct but takes several minutes for the full lists.
"""

from __future__ import annotations

import argparse
import bisect
import csv
import gzip
import hashlib
import json
import os
import random
import shutil
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO / "injector" / "out" / "bridge-proofs"
DEFAULT_DEPLOYMENTS = REPO / "frontend" / "src" / "bridge" / "deployments.json"
PUBLIC_BASE = "https://storage.googleapis.com/harmony-bridge-claims"

PROOFS_FORMAT = "bridge-proofs/v1"
DEPLOYMENTS_FORMAT = "bridge-deployments/v1"
CHAIN_ORDER = ("ethereum", "bsc", "arbitrum", "base", "linea")
NATIVE = "0x" + "0" * 40
CSV_HEADER = ["index", "account", "token", "symbol", "amount_raw", "amount", "pools"]
HEX = set("0123456789abcdef")


class BuildError(Exception):
    pass


# --------------------------------------------------------------------------------------- keccak

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_MASK = (1 << 64) - 1


def _keccak_f(a):
    for rc in _RC:
        c = [a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20] for x in range(5)]
        d = [c[(x - 1) % 5] ^ (((c[(x + 1) % 5] << 1) | (c[(x + 1) % 5] >> 63)) & _MASK) for x in range(5)]
        a = [a[i] ^ d[i % 5] for i in range(25)]
        b = [0] * 25
        for x in range(5):
            for y in range(5):
                r, v = _ROT[x][y], a[x + 5 * y]
                b[y + 5 * ((2 * x + 3 * y) % 5)] = ((v << r) | (v >> (64 - r))) & _MASK if r else v
        a = [b[i] ^ ((~b[(i + 1) % 5 + 5 * (i // 5)]) & b[(i + 2) % 5 + 5 * (i // 5)]) for i in range(25)]
        a[0] ^= rc
    return a


def _keccak256_pure(data: bytes) -> bytes:
    rate = 136
    padded = bytearray(data)
    padded.append(0x01)
    while len(padded) % rate:
        padded.append(0)
    padded[-1] |= 0x80
    state = [0] * 25
    for offset in range(0, len(padded), rate):
        for i in range(rate // 8):
            state[i] ^= int.from_bytes(padded[offset + 8 * i:offset + 8 * i + 8], "little")
        state = _keccak_f(state)
    return b"".join(state[i].to_bytes(8, "little") for i in range(4))


try:
    from Crypto.Hash import keccak as _pycryptodome_keccak

    def keccak256(data: bytes) -> bytes:
        return _pycryptodome_keccak.new(digest_bits=256, data=data).digest()

    KECCAK_BACKEND = "pycryptodome"
except ImportError:  # pragma: no cover - depends on the environment
    keccak256 = _keccak256_pure
    KECCAK_BACKEND = "pure-python"


# ----------------------------------------------------------------------------------- the tree

def _word(value: int) -> bytes:
    return value.to_bytes(32, "big")


def leaf(index: int, account: str, token: str, amount: int) -> bytes:
    """keccak256(keccak256(abi.encode(uint256 index, address account, address token, uint256 amount)))."""
    encoded = _word(index) + _word(int(account, 16)) + _word(int(token, 16)) + _word(amount)
    return keccak256(keccak256(encoded))


def hash_pair(a: bytes, b: bytes) -> bytes:
    return keccak256(a + b) if a < b else keccak256(b + a)


def tree_levels(leaves: list[bytes]) -> list[list[bytes]]:
    """Every level, leaves first, root last; an unpaired last node is carried up unchanged."""
    if not leaves:
        raise BuildError("no leaves")
    levels = [list(leaves)]
    while len(levels[-1]) > 1:
        prev = levels[-1]
        nxt = [hash_pair(prev[i], prev[i + 1]) for i in range(0, len(prev) - 1, 2)]
        if len(prev) % 2:
            nxt.append(prev[-1])
        levels.append(nxt)
    return levels


def tree_proof(levels: list[list[bytes]], index: int) -> list[bytes]:
    """The sibling at every level that has one."""
    proof = []
    for level in levels[:-1]:
        sibling = index ^ 1
        if sibling < len(level):
            proof.append(level[sibling])
        index >>= 1
    return proof


def tree_verify(proof: list[bytes], root: bytes, leaf_node: bytes) -> bool:
    node = leaf_node
    for sibling in proof:
        node = hash_pair(node, sibling)
    return node == root


def tree_sha256(levels: list[list[bytes]]) -> str:
    """SHA-256 of the tree written as `tree.txt` is: one 0x-prefixed node per line, leaves first."""
    digest = hashlib.sha256()
    for level in levels:
        digest.update("".join("0x" + node.hex() + "\n" for node in level).encode("ascii"))
    return digest.hexdigest()


def checksum_address(address: str) -> str:
    body = address[2:].lower()
    digest = keccak256(body.encode("ascii")).hex()
    return "0x" + "".join(c.upper() if int(digest[i], 16) >= 8 else c for i, c in enumerate(body))


def hex0x(data: bytes) -> str:
    return "0x" + data.hex()


# -------------------------------------------------------------------------------------- inputs

def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(url: str, timeout: int = 60, headers: dict | None = None) -> tuple[bytes, dict]:
    """The body, decoded when the server sent it gzip-encoded, and the response headers."""
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read()
        got = {k.lower(): v for k, v in response.headers.items()}
    if got.get("content-encoding", "").lower() == "gzip":
        body = gzip.decompress(body)
    return body, got


def parse_index(text: str, source: str) -> dict[str, str]:
    """`shasum -a 256` output: `<sha256>  <path>` per line."""
    entries = {}
    for n, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        digest, _, path = line.partition("  ")
        if len(digest) != 64 or not set(digest) <= HEX or not path or path in entries:
            raise BuildError(f"{source}:{n}: not a SHA256SUMS line")
        entries[path] = digest
    return entries


def load_published_index(source: str) -> tuple[dict[str, str], str]:
    if source.startswith("https://"):
        body, _ = fetch(source)
    else:
        body = Path(source).read_bytes()
    return parse_index(body.decode("utf-8"), source), hashlib.sha256(body).hexdigest()


def is_address(value: str) -> bool:
    return isinstance(value, str) and len(value) == 42 and value.startswith("0x") and set(value[2:]) <= HEX


def is_hash(value: str) -> bool:
    return isinstance(value, str) and len(value) == 66 and value.startswith("0x") and set(value[2:]) <= HEX


def lower(value) -> str | None:
    return value.lower() if isinstance(value, str) else value


def plain_int(text: str, what: str) -> int:
    if not text.isdigit() or (len(text) > 1 and text[0] == "0"):
        raise BuildError(f"{what}: {text!r} is not a plain decimal integer")
    return int(text)


class Contract:
    """One BridgeClaims contract: its manifest, rows, and rebuilt tree."""

    def __init__(self, label: str, manifest: dict, manifest_sha256: str):
        self.label = label
        self.manifest = manifest
        self.manifest_sha256 = manifest_sha256
        self.chain_id = manifest["chain_id"]
        self.address = manifest["deployment"]["address"].lower()
        self.root = bytes.fromhex(manifest["root"][2:])
        self.claim_count = manifest["claim_count"]
        self.accounts: list[str] = []
        self.tokens: list[str] = []
        self.amounts: list[int] = []
        self.assets: list[dict] = []
        self.levels: list[list[bytes]] = []
        self.runtime_keccak256: str | None = None
        self.deploy: dict = {}

    def range_of(self, prefix: str) -> range:
        """Rows whose account starts with 0x<prefix>; rows are sorted by account."""
        start = bisect.bisect_left(self.accounts, "0x" + prefix)
        end = bisect.bisect_left(self.accounts, "0x" + prefix + "g")
        return range(start, end)


def check_published(run_dir: Path, index: dict[str, str], labels: list[str]) -> None:
    required = {"summary.json"} | {f"{label}/{name}" for label in labels for name in ("manifest.json", "claims.csv", "tree.txt", "samples.json")}
    missing = sorted(required - set(index))
    if missing:
        raise BuildError(f"the published index does not list {', '.join(missing)}")
    for path, digest in sorted(index.items()):
        local = run_dir / path
        if not local.is_file():
            raise BuildError(f"{path} is in the published index but not in {run_dir}")
        if sha256_file(local) != digest:
            raise BuildError(f"{path} differs from the published index")


def load_contract(run_dir: Path, entry: dict, index: dict[str, str]) -> Contract:
    label = entry["label"]
    manifest_path = run_dir / label / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    contract = Contract(label, manifest, sha256_file(manifest_path))
    deployment = manifest.get("deployment") or {}
    constructor = deployment.get("constructor") or {}

    expected = {
        "label": (manifest.get("label"), label),
        "chain": (manifest.get("chain"), entry.get("chain")),
        "chain_id": (manifest.get("chain_id"), entry.get("chain_id")),
        "funder": (lower(manifest.get("funder")), lower(entry.get("funder"))),
        "root": (lower(manifest.get("root")), lower(entry.get("root"))),
        "claim_count": (manifest.get("claim_count"), entry.get("claim_count")),
        "list_sha256": (manifest.get("list_sha256"), entry.get("list_sha256")),
        "address": (lower(deployment.get("address")), lower(entry.get("address"))),
        "status": (deployment.get("status"), entry.get("status")),
        "constructor funder": (lower(constructor.get("funder")), lower(manifest.get("funder"))),
        "constructor chainId": (constructor.get("chainId"), manifest.get("chain_id")),
        "constructor root": (lower(constructor.get("root")), lower(manifest.get("root"))),
        "constructor claimCount": (constructor.get("claimCount"), manifest.get("claim_count")),
        "constructor listHash": (lower(constructor.get("listHash")), "0x" + str(manifest.get("list_sha256"))),
        "constructor wrappedNative": (lower(constructor.get("wrappedNative")), lower(manifest.get("wrapped_native")) or NATIVE),
        "list file hash": (manifest.get("list_sha256"), index.get(f"{label}/claims.csv")),
        "tree file hash": (manifest.get("tree_sha256"), index.get(f"{label}/tree.txt")),
    }
    for field, (got, want) in expected.items():
        if got != want:
            raise BuildError(f"{label}: manifest {field} is {got!r}, expected {want!r}")
    if entry.get("status") != "ready":
        raise BuildError(f"{label}: status {entry.get('status')!r}, not ready")
    if not is_address(contract.address) or not is_hash(manifest["root"]) or contract.claim_count <= 0:
        raise BuildError(f"{label}: bad address, root, or row count in the manifest")

    assets = {}
    for asset in manifest["assets"]:
        token = asset["token"].lower()
        if not is_address(token) or token in assets:
            raise BuildError(f"{label}: bad or repeated asset {asset['token']}")
        if not isinstance(asset.get("decimals"), int) or not 0 <= asset["decimals"] <= 36:
            raise BuildError(f"{label}: bad decimals for {asset['symbol']}")
        pools = asset.get("pools")
        if not isinstance(pools, list) or not pools or not all(isinstance(p, str) and p for p in pools):
            raise BuildError(f"{label}: no pools for {asset['symbol']}")
        assets[token] = {"symbol": asset["symbol"], "decimals": asset["decimals"], "pools": pools, "rows": 0, "total": 0,
                         "want_rows": asset["rows"], "want_total": plain_int(asset["total_raw"], f"{label} {asset['symbol']} total")}
    if (NATIVE in assets) != bool(manifest.get("wrapped_native")):
        raise BuildError(f"{label}: native rows and the wrapped native coin disagree")

    with (run_dir / label / "claims.csv").open(newline="", encoding="utf-8") as source:
        reader = csv.reader(source)
        if next(reader, None) != CSV_HEADER:
            raise BuildError(f"{label}/claims.csv: header is not {','.join(CSV_HEADER)}")
        previous = ("", "")
        for n, row in enumerate(reader):
            where = f"{label}/claims.csv row {n}"
            if len(row) != len(CSV_HEADER):
                raise BuildError(f"{where}: {len(row)} columns")
            index_text, account, token, symbol, amount_raw = row[:5]
            if plain_int(index_text, where) != n:
                raise BuildError(f"{where}: index {index_text}, expected {n}")
            if not is_address(account) or not is_address(token):
                raise BuildError(f"{where}: account and token must be lower-case 0x addresses")
            if (account, token) <= previous:
                raise BuildError(f"{where}: rows are not sorted by account and token")
            previous = (account, token)
            asset = assets.get(token)
            if asset is None:
                raise BuildError(f"{where}: token {token} is not one of the manifest's assets")
            if symbol != asset["symbol"]:
                raise BuildError(f"{where}: symbol {symbol!r}, the manifest says {asset['symbol']!r}")
            amount = plain_int(amount_raw, where)
            if amount == 0:
                raise BuildError(f"{where}: zero amount")
            asset["rows"] += 1
            asset["total"] += amount
            contract.accounts.append(account)
            contract.tokens.append(token)
            contract.amounts.append(amount)
    if len(contract.accounts) != contract.claim_count:
        raise BuildError(f"{label}: {len(contract.accounts)} rows, the manifest says {contract.claim_count}")
    for token, asset in assets.items():
        if (asset["rows"], asset["total"]) != (asset["want_rows"], asset["want_total"]):
            raise BuildError(f"{label} {asset['symbol']}: {asset['rows']} rows totalling {asset['total']}, "
                             f"the manifest says {asset['want_rows']} totalling {asset['want_total']}")
    contract.assets = [{"token": token, "symbol": a["symbol"], "decimals": a["decimals"], "pools": a["pools"]} for token, a in assets.items()]

    leaves = [leaf(i, a, t, v) for i, (a, t, v) in enumerate(zip(contract.accounts, contract.tokens, contract.amounts))]
    contract.levels = tree_levels(leaves)
    if [len(level) for level in contract.levels] != manifest["level_sizes"]:
        raise BuildError(f"{label}: rebuilt tree level sizes differ from the manifest")
    if contract.levels[-1][0] != contract.root:
        raise BuildError(f"{label}: the root rebuilt from claims.csv is {hex0x(contract.levels[-1][0])}, the manifest says {manifest['root']}")
    if tree_sha256(contract.levels) != manifest["tree_sha256"]:
        raise BuildError(f"{label}: the rebuilt tree does not hash to the manifest's tree_sha256")

    samples = json.loads((run_dir / label / "samples.json").read_text(encoding="utf-8"))
    if lower(samples.get("root")) != lower(manifest["root"]) or not samples.get("rows"):
        raise BuildError(f"{label}/samples.json: wrong root or no rows")
    for sample in samples["rows"]:
        i = sample["index"]
        row = (contract.accounts[i], contract.tokens[i], str(contract.amounts[i]))
        if row != (sample["account"].lower(), sample["token"].lower(), sample["amount_raw"]):
            raise BuildError(f"{label}/samples.json: row {i} differs from claims.csv")
        if [hex0x(node) for node in tree_proof(contract.levels, i)] != [p.lower() for p in sample["proof"]]:
            raise BuildError(f"{label}/samples.json: proof of row {i} differs from the rebuilt tree")
    return contract


def check_deploy_record(contracts: list[Contract], record: dict) -> None:
    by_chain = {}
    for entry in record.get("deployments", []):
        if entry.get("chain") in by_chain:
            raise BuildError(f"the deployment record lists {entry.get('chain')} twice")
        by_chain[entry.get("chain")] = entry
    for contract in contracts:
        chain = contract.manifest["chain"]
        entry = by_chain.get(chain)
        if entry is None:
            raise BuildError(f"the deployment record has no {chain} deployment")
        verification = entry.get("explorer_verification") or {}
        checks = {
            "chain id": entry.get("chain_id") == contract.chain_id,
            "address": lower(entry.get("address")) == contract.address,
            "status": entry.get("status") == "0x1",
            "ok": entry.get("ok") is True,
            "runtime code": entry.get("runtime_matches_build") is True,
            "immutables": entry.get("immutables_match_manifest") is True,
            "manifest": entry.get("manifest_sha256") == contract.manifest_sha256,
            "explorer constructor arguments": verification.get("constructor_args_match") is True,
            "runtime hash": is_hash(entry.get("runtime_keccak256", "")),
            "transaction": is_hash(entry.get("tx_hash", "")) and isinstance(entry.get("block"), int),
        }
        failed = [name for name, ok in checks.items() if not ok]
        if failed:
            raise BuildError(f"{chain}: the deployment record fails {', '.join(failed)}")
        contract.runtime_keccak256 = entry["runtime_keccak256"].lower()
        contract.deploy = {"tx": entry["tx_hash"].lower(), "block": entry["block"]}


def load_snapshots(alloc_dir: Path, claim_summary: dict, contracts: list[Contract]) -> dict:
    """Every chain's snapshot blocks, and the holder chain and snapshot of each asset's pools.

    The allocation summary must be the one the claim run records, and the snapshot plan and bridge
    state beside it the ones that summary records; each pool's snapshot block must be the bridge
    state's block for the pool's holder chain and label."""
    summary_path = alloc_dir / "summary.json"
    if sha256_file(summary_path) != (claim_summary.get("inputs") or {}).get("summary.json"):
        raise BuildError(f"{summary_path} is not the allocation summary the claim run was built from")
    inputs = json.loads(summary_path.read_text(encoding="utf-8")).get("inputs") or {}
    bound = {}
    for name, key in (("snapshot-plan.json", "plan_sha256"), ("bridge-state.json", "state_sha256")):
        path = alloc_dir.parent / name
        if not path.is_file() or sha256_file(path) != inputs.get(key):
            raise BuildError(f"{path} is not the {name} the allocation summary records ({key})")
        bound[name] = json.loads(path.read_text(encoding="utf-8"))
    plan, state = bound["snapshot-plan.json"], bound["bridge-state.json"]

    blocks: dict[str, dict] = {}
    for chain, labels in sorted(state.get("blocks", {}).items()):
        blocks[chain] = {}
        for label, block in sorted(labels.items()):
            if not isinstance(block.get("number"), int) or not isinstance(block.get("timestamp_utc"), str):
                raise BuildError(f"bridge-state.json: bad {chain} {label} block")
            blocks[chain][label] = {"number": block["number"], "time": block["timestamp_utc"]}
    for need in ("cutoff", "rollback"):
        if need not in blocks.get("harmony", {}):
            raise BuildError(f"bridge-state.json has no Harmony {need} block")

    for contract in contracts:
        for asset in contract.assets:
            resolved = []
            for pool_id in asset["pools"]:
                pool = plan.get("pools", {}).get(pool_id)
                if not pool or pool.get("status") != "planned":
                    raise BuildError(f"{contract.label} {asset['symbol']}: pool {pool_id} is not planned in the snapshot plan")
                chain, label, block = pool.get("claimant_chain"), pool.get("snapshot_label"), pool.get("snapshot_block") or {}
                want = blocks.get(chain, {}).get(label)
                if want is None or (block.get("number"), block.get("timestamp_utc")) != (want["number"], want["time"]):
                    raise BuildError(f"{contract.label} {asset['symbol']}: pool {pool_id}'s snapshot block is not the bridge state's {chain} {label} block")
                resolved.append({"id": pool_id, "holders": chain, "snapshot": label})
            asset["pools"] = resolved

    orphaned = {}
    for chain, exposure in sorted(plan.get("exposure", {}).items()):
        count = exposure.get("orphaned_one_deliveries")
        if not isinstance(count, int) or count < 0:
            raise BuildError(f"snapshot-plan.json: bad orphaned ONE deliveries for {chain}")
        if count:
            orphaned[chain] = count
    return {"blocks": blocks, "orphaned_one_deliveries": orphaned}


def load_run(run_dir: Path, published_index: str, deploy_record: Path, alloc_dir: Path) -> tuple[dict, list[Contract], str]:
    summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
    entries = summary.get("contracts") or []
    labels = [e["label"] for e in entries]
    if len(set(labels)) != len(labels) or not labels:
        raise BuildError("summary.json lists no contracts, or one twice")
    index, index_sha256 = load_published_index(published_index)
    check_published(run_dir, index, labels)
    rank = {label: i for i, label in enumerate(CHAIN_ORDER)}
    entries.sort(key=lambda e: (rank.get(e["label"], len(rank)), e["label"]))
    contracts = []
    for entry in entries:
        started = time.monotonic()
        contracts.append(load_contract(run_dir, entry, index))
        print(f"{entry['label']}: {contracts[-1].claim_count:,} rows, root and samples check "
              f"({time.monotonic() - started:.1f}s)", file=sys.stderr)
    check_deploy_record(contracts, json.loads(deploy_record.read_text(encoding="utf-8")))
    snapshots = load_snapshots(alloc_dir, summary, contracts)
    return snapshots, contracts, index_sha256


# ------------------------------------------------------------------------------------- outputs

def deployments_document(run: str, published_url: str, index_sha256: str, prefix_digits: int, snapshots: dict,
                         contracts: list[Contract]) -> dict:
    return {
        "format": DEPLOYMENTS_FORMAT,
        "run": run,
        "published_url": published_url,
        "published_index_sha256": index_sha256,
        "proof_prefix_digits": prefix_digits,
        "snapshots": snapshots,
        "contracts": [
            {
                "label": c.label,
                "chain_id": c.chain_id,
                "address": checksum_address(c.address),
                "funder": checksum_address(c.manifest["funder"]),
                "wrapped_native": checksum_address(c.manifest["wrapped_native"]) if c.manifest.get("wrapped_native") else None,
                "root": c.manifest["root"].lower(),
                "claim_count": c.claim_count,
                "list_sha256": c.manifest["list_sha256"],
                "manifest_sha256": c.manifest_sha256,
                "runtime_keccak256": c.runtime_keccak256,
                "deploy_tx": c.deploy["tx"],
                "deploy_block": c.deploy["block"],
                "assets": [
                    {"token": checksum_address(a["token"]), "symbol": a["symbol"], "decimals": a["decimals"], "pools": a["pools"]}
                    for a in c.assets
                ],
            }
            for c in contracts
        ],
    }


PROOFS_README = """# Bridge claim proofs

Run `{run}`. Every row of the five claim lists in `../<chain>/claims.csv`, with its Merkle proof,
grouped by payee. `<prefix>.json` holds every payee whose address starts with `0x<prefix>`
({digits} lower-case hex digits); a prefix without payees has a file with no accounts.

```json
{{"format": "{format}", "run": "{run}", "prefix": "<prefix>",
 "accounts": {{"0x<address>": {{"<chain>": [{{"index": 0, "token": "0x…", "amount": "<raw units>", "proof": ["0x…"]}}]}}}}}}
```

Chains are `ethereum`, `bsc`, `arbitrum`, `base`, and `linea`. Token `0x0000000000000000000000000000000000000000`
is the native coin. A row's leaf is
`keccak256(keccak256(abi.encode(uint256 index, address account, address token, uint256 amount)))`; hashing
it with each proof node in turn, smaller value first, gives the chain's `root` in `index.json` and on
the contract (`verify(index, account, token, amount, proof)`). The rows are those of `claims.csv`; the
proofs are those of `tree.txt`.

Check the files with `shasum -a 256 -c SHA256SUMS`.
"""


def shard(run: str, prefix: str, contracts: list[Contract]) -> dict:
    accounts: dict[str, dict[str, list]] = {}
    for contract in contracts:
        for i in contract.range_of(prefix):
            rows = accounts.setdefault(contract.accounts[i], {}).setdefault(contract.label, [])
            rows.append({
                "index": i,
                "token": contract.tokens[i],
                "amount": str(contract.amounts[i]),
                "proof": [hex0x(node) for node in tree_proof(contract.levels, i)],
            })
    return {"format": PROOFS_FORMAT, "run": run, "prefix": prefix, "accounts": {a: accounts[a] for a in sorted(accounts)}}


def write_proofs(out_dir: Path, run: str, index_sha256: str, prefix_digits: int, contracts: list[Contract]) -> Path:
    target = out_dir / run / "proofs"
    staging = out_dir / run / f".proofs-{os.getpid()}"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    sums: dict[str, str] = {}
    accounts = rows = 0

    def put(name: str, body: bytes) -> None:
        (staging / name).write_bytes(body)
        sums[name] = hashlib.sha256(body).hexdigest()

    for p in range(16 ** prefix_digits):
        prefix = f"{p:0{prefix_digits}x}"
        doc = shard(run, prefix, contracts)
        accounts += len(doc["accounts"])
        rows += sum(len(r) for chains in doc["accounts"].values() for r in chains.values())
        put(f"{prefix}.json", json.dumps(doc, separators=(",", ":")).encode("ascii"))
    if rows != sum(c.claim_count for c in contracts):
        raise BuildError(f"the proof files hold {rows} rows, the lists {sum(c.claim_count for c in contracts)}")
    index = {
        "format": PROOFS_FORMAT,
        "run": run,
        "prefix_digits": prefix_digits,
        "files": 16 ** prefix_digits,
        "accounts": accounts,
        "rows": rows,
        "published_index_sha256": index_sha256,
        "contracts": [
            {"label": c.label, "chain_id": c.chain_id, "address": c.address, "root": c.manifest["root"].lower(),
             "claim_count": c.claim_count, "list_sha256": c.manifest["list_sha256"]}
            for c in contracts
        ],
    }
    put("index.json", (json.dumps(index, indent=1) + "\n").encode("ascii"))
    put("README.md", PROOFS_README.format(run=run, digits=prefix_digits, format=PROOFS_FORMAT).encode("utf-8"))
    (staging / "SHA256SUMS").write_text("".join(f"{sums[name]}  {name}\n" for name in sorted(sums)), encoding="ascii")

    old = out_dir / run / f".proofs-old-{os.getpid()}"
    if target.exists():
        target.rename(old)
    staging.rename(target)
    if old.exists():
        shutil.rmtree(old)
    print(f"wrote {16 ** prefix_digits:,} proof files ({accounts:,} payees, {rows:,} rows) to {target}", file=sys.stderr)
    return target


def build(args: argparse.Namespace) -> None:
    run_dir = args.claims_dir.expanduser().resolve()
    run = run_dir.name
    published_url = f"{args.public_base.rstrip('/')}/{run}"
    print(f"keccak: {KECCAK_BACKEND}", file=sys.stderr)
    snapshots, contracts, index_sha256 = load_run(run_dir, args.published_index or f"{published_url}/SHA256SUMS",
                                                  args.deploy_record.expanduser(), args.allocations_dir.expanduser().resolve())
    document = deployments_document(run, published_url, index_sha256, args.prefix_digits, snapshots, contracts)
    write_proofs(args.out, run, index_sha256, args.prefix_digits, contracts)
    args.deployments.parent.mkdir(parents=True, exist_ok=True)
    args.deployments.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.deployments}", file=sys.stderr)


def verify_published(args: argparse.Namespace) -> None:
    deployments = json.loads(args.deployments.read_text(encoding="utf-8"))
    run = deployments["run"]
    local = args.out / run / "proofs"
    base = (args.base_url or f"{deployments['published_url']}/proofs").rstrip("/")
    sums_body = (local / "SHA256SUMS").read_bytes()
    sums = parse_index(sums_body.decode("ascii"), str(local / "SHA256SUMS"))
    remote_sums, headers = fetch(f"{base}/SHA256SUMS", headers={"Origin": args.origin})
    if remote_sums != sums_body:
        raise BuildError(f"{base}/SHA256SUMS differs from {local / 'SHA256SUMS'}")
    if headers.get("access-control-allow-origin") not in ("*", args.origin):
        raise BuildError(f"{base} does not allow reads from {args.origin} (CORS)")
    names = [n for n in sums if not n.endswith(".json") or n == "index.json"]
    shards = sorted(n for n in sums if n not in names)
    names += random.SystemRandom().sample(shards, min(args.samples, len(shards)))
    for name in names:
        body, _ = fetch(f"{base}/{name}")
        if hashlib.sha256(body).hexdigest() != sums[name]:
            raise BuildError(f"{base}/{name} differs from the local build")
    print(f"{base}: SHA256SUMS, CORS, and {len(names)} files match the local build", file=sys.stderr)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build", help="check a claim run and write the proof files and deployments.json")
    b.add_argument("--claims-dir", type=Path, required=True, help="harmony-migration bridge-claims/runs/<run>")
    b.add_argument("--deploy-record", type=Path, required=True, help="the run's deploy-<time>/deployments.json")
    b.add_argument("--allocations-dir", type=Path, required=True,
                   help="the allocation run's output the claim run was built from (its summary.json), with "
                        "snapshot-plan.json and bridge-state.json in the folder above")
    b.add_argument("--published-index", help="SHA256SUMS URL or file (default: the run's index in the public bucket)")
    b.add_argument("--public-base", default=PUBLIC_BASE, help=f"public bucket URL (default {PUBLIC_BASE})")
    b.add_argument("--prefix-digits", type=int, default=4, choices=(1, 2, 3, 4), help="hex digits per proof file name (default 4)")
    b.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"output root (default {DEFAULT_OUT.relative_to(REPO)})")
    b.add_argument("--deployments", type=Path, default=DEFAULT_DEPLOYMENTS, help=f"contract list for the page (default {DEFAULT_DEPLOYMENTS.relative_to(REPO)})")
    v = sub.add_parser("verify-published", help="compare the public proof files with the local build")
    v.add_argument("--out", type=Path, default=DEFAULT_OUT)
    v.add_argument("--deployments", type=Path, default=DEFAULT_DEPLOYMENTS)
    v.add_argument("--base-url", help="proofs folder URL (default: published_url/proofs from deployments.json)")
    v.add_argument("--origin", default="https://migrate.country", help="Origin sent to check CORS")
    v.add_argument("--samples", type=int, default=64, help="random proof files to download (default 64)")
    args = parser.parse_args(argv)
    try:
        build(args) if args.command == "build" else verify_published(args)
    except (BuildError, OSError, ValueError, KeyError) as error:
        raise SystemExit(f"error: {error}")


if __name__ == "__main__":
    main()
