#!/usr/bin/env python3
"""Read what the reserve Safe paid confirmed wallets on Ethereum, for confirmed-wallets.sh --chain.

For every address in --confirmations: each ERC-20 ONE transfer from the reserve to it, and each
deposit the reserve made for it as delegator into a governor vault of the vault catalog
(injector/build_vault_catalog.py, the file the /vault page loads). Chain id, token, reserve and
vault addresses come from the catalog; deposit events from any other contract are ignored.

The RPC URL is read from ETH_RPC_URL and never printed. Use the paid archive endpoint, not a free
public one: these rows decide which deliveries get marked.

Writes --out with one row per payment (kind wallet|vault, address, validator_address,
vault_address, amount_atto, block, tx_hash, log_index) and prints "<block> <rpc host>" to stdout:
the block everything was read up to.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional
from urllib.parse import urlsplit

TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
# Deposit(address indexed caller, address indexed delegator, uint256 assets) of GovernorDelegator
DEPOSIT_TOPIC = "0x5548c837ab068cf56a2c2479df0882a4922fd203edb7517321831d95078c5f62"
# Block each ONE token was deployed in (frontend/src/vault/catalog.ts ONE_TOKEN_BLOCKS).
TOKEN_BLOCKS = {1: 25_936_466, 11155111: 11_664_601}
ADDRESSES_PER_CALL = 100
MIN_SPAN = 2_000
COLUMNS = ["kind", "address", "validator_address", "vault_address", "amount_atto", "block", "tx_hash", "log_index"]


class RpcError(Exception):
    pass


Call = Callable[[str, list], object]


def http_rpc(url: str, attempts: int = 3) -> Call:
    def call(method: str, params: list) -> object:
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        for attempt in range(attempts):
            request = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
            try:
                with urllib.request.urlopen(request, timeout=120) as response:
                    reply = json.load(response)
            except urllib.error.HTTPError as exc:
                retry = exc.code == 429 or exc.code >= 500
                if retry and attempt + 1 < attempts:
                    time.sleep(2 * (attempt + 1))
                    continue
                try:
                    message = json.loads(exc.read()).get("error", {}).get("message", "")
                except (ValueError, AttributeError):
                    message = ""
                raise RpcError(f"{method}: HTTP {exc.code}{': ' + message if message else ''}") from None
            except (urllib.error.URLError, TimeoutError) as exc:
                if attempt + 1 == attempts:
                    # The URL carries the key; say only which call failed.
                    raise RpcError(f"{method} failed: {getattr(exc, 'reason', exc)}") from None
                time.sleep(2 * (attempt + 1))
                continue
            if "error" in reply:
                raise RpcError(f"{method}: {reply['error'].get('message', reply['error'])}")
            return reply["result"]
        raise RpcError(f"{method} failed")

    return call


def topic(address: str) -> str:
    return "0x" + address.lower()[2:].rjust(64, "0")


def address_of(word: str) -> str:
    return "0x" + word[-40:].lower()


class Catalog:
    def __init__(self, raw: dict) -> None:
        self.chain_id = int(raw["chain_id"])
        self.token = raw["token"].lower()
        self.reserve = raw["reserve"].lower()
        self.start_block = int(raw["start_block"])
        self.vaults: Dict[str, str] = {v["vault"].lower(): v["validator"].lower() for v in raw["vaults"]}

    @classmethod
    def load(cls, path: Path) -> "Catalog":
        return cls(json.loads(path.read_text(encoding="utf-8")))


def get_logs(call: Call, query: dict, start: int, end: int) -> List[dict]:
    """eth_getLogs over [start, end], halving the range while the endpoint refuses it."""
    try:
        return list(call("eth_getLogs", [{**query, "fromBlock": hex(start), "toBlock": hex(end)}]))
    except RpcError:
        if end - start < MIN_SPAN:
            raise
        mid = start + (end - start) // 2
        return get_logs(call, query, start, mid) + get_logs(call, query, mid + 1, end)


def chunks(items: List[str], size: int) -> Iterable[List[str]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def read_payments(call: Call, catalog: Catalog, addresses: List[str], to_block: int) -> tuple:
    """(rows, deposits ignored because they came from a contract outside the catalog)."""
    rows: List[Dict[str, str]] = []
    ignored = 0
    token_from = TOKEN_BLOCKS.get(catalog.chain_id, catalog.start_block)
    for group in chunks(sorted(set(addresses)), ADDRESSES_PER_CALL):
        wanted = [topic(a) for a in group]
        transfers = get_logs(call, {"address": catalog.token, "topics": [TRANSFER_TOPIC, topic(catalog.reserve), wanted]},
                             token_from, to_block)
        for log in transfers:
            rows.append(row("wallet", address_of(log["topics"][2]), "", "", log))
        deposits = get_logs(call, {"topics": [DEPOSIT_TOPIC, topic(catalog.reserve), wanted]}, catalog.start_block, to_block)
        for log in deposits:
            vault = log["address"].lower()
            validator = catalog.vaults.get(vault)
            if validator is None:
                ignored += 1
                continue
            rows.append(row("vault", address_of(log["topics"][2]), validator, vault, log))
    rows.sort(key=lambda r: (int(r["block"]), int(r["log_index"])))
    return rows, ignored


def row(kind: str, address: str, validator: str, vault: str, log: dict) -> Dict[str, str]:
    return {
        "kind": kind,
        "address": address,
        "validator_address": validator,
        "vault_address": vault,
        "amount_atto": str(int(log["data"][:66], 16)),
        "block": str(int(log["blockNumber"], 16)),
        "tx_hash": log["transactionHash"].lower(),
        "log_index": str(int(log["logIndex"], 16)),
    }


def read_addresses(path: Path) -> List[str]:
    with path.open(newline="", encoding="utf-8") as handle:
        return [r["address"].strip().lower() for r in csv.DictReader(handle) if r.get("address", "").strip()]


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--confirmations", required=True, help="CSV with an address column")
    parser.add_argument("--catalog", required=True, help="vault catalog JSON (frontend/public/vault-catalog.json)")
    parser.add_argument("--out", required=True, help="payments CSV to write")
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None, call: Optional[Call] = None) -> int:
    args = parse_args(argv)
    catalog_path = Path(args.catalog)
    if not catalog_path.is_file():
        sys.stderr.write(f"error: no vault catalog at {catalog_path}; build it with injector/build_vault_catalog.py\n")
        return 1
    catalog = Catalog.load(catalog_path)
    host = "fixture"
    if call is None:
        url = os.environ.get("ETH_RPC_URL", "").strip()
        if not url:
            sys.stderr.write("error: ETH_RPC_URL is not set\n")
            return 1
        host = urlsplit(url).hostname or "?"
        call = http_rpc(url)
    try:
        chain_id = int(str(call("eth_chainId", [])), 16)
        if chain_id != catalog.chain_id:
            sys.stderr.write(f"error: the RPC is chain {chain_id}, the vault catalog chain {catalog.chain_id}\n")
            return 1
        to_block = int(str(call("eth_blockNumber", [])), 16)
        addresses = read_addresses(Path(args.confirmations))
        rows, ignored = read_payments(call, catalog, addresses, to_block)
    except RpcError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1
    with Path(args.out).open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    if ignored:
        sys.stderr.write(f"warning: ignored {ignored} deposit event(s) from contracts that are not catalog vaults\n")
    sys.stdout.write(f"{to_block} {host}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
