#!/usr/bin/env python3
"""Load harmony-migration cutoff claims and routing into the claim portal DB.

See README.md in this directory. Python 3.12+, psycopg 3, pycryptodome.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator

csv.field_size_limit(1 << 24)

EMPTY_CODE_HASH = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
DEFAULT_DSN = "postgres://claimapi@localhost:5433/claims"
DEFAULT_RPC = "https://api.harmony.one"
STAGING = "claims_staging"
ONE = 10**18

CATEGORIES = ("ordinary_eoa", "validator_account", "contract", "excluded")

# Data tables replaced by the swap, in dependency-free order.
DATA_TABLES = (
    "snapshot_meta",
    "accounts",
    "delegations",
    "validator_vaults",
    "routing_exceptions",
    "routing_destinations",
    "exchange_wallets",
)

ACCOUNT_COLUMNS = (
    "secure_key",
    "address",
    "address_resolved",
    "account_category",
    "code_bearing",
    "contract_primary_category",
    "contract_subcategory",
    "contract_identity",
    "contract_treatment",
    "policy_category",
    "liquid_shard0_atto",
    "liquid_shard1_atto",
    "active_staked_or_delegated_atto",
    "pending_undelegation_atto",
    "unclaimed_staking_reward_atto",
    "pending_cross_shard_atto",
    "native_wallet_airdrop_atto",
    "wone_balance_atto",
    "wone_airdrop_atto",
    "wallet_airdrop_atto",
    "staked_to_vault_atto",
    "qualification_total_atto",
    "native_total_claim_atto",
    "total_claim_atto",
    "meets_threshold",
    "nonce_shard0",
    "nonce_shard1",
    "code_hash_shard0",
    "code_hash_shard1",
    "last_activity_time_utc",
    "last_activity_timestamp_unix",
    "last_activity_block",
    "last_activity_shard",
    "last_activity_type",
    "last_activity_tx_hash",
    "last_activity_index",
    "last_activity_detail",
)
DELEGATION_COLUMNS = (
    "validator_address",
    "delegator_address",
    "staked_to_vault_atto",
    "is_self_delegation",
    "priority",
)
VAULT_COLUMNS = (
    "validator_address",
    "vault_assets_atto",
    "priority_staked_to_vault_atto",
    "deferred_staked_to_vault_atto",
    "delegation_rows",
    "governor_destination_id",
    "governor_status",
    "validator_name",
)
EXCEPTION_COLUMNS = (
    "component",
    "source_address",
    "source_category",
    "validator_address",
    "amount_atto",
    "exception_type",
    "route_id",
    "route_priority",
    "destination_id",
    "destination_address",
    "destination_status",
    "reason",
    "evidence",
)
DESTINATION_COLUMNS = ("destination_id", "destination_address", "status", "notes")
EXCHANGE_COLUMNS = (
    "exchange_id",
    "display_name",
    "address",
    "delivery_policy",
    "qualification_status",
    "planned_delivery_status",
    "configured_destination",
    "configured_destination_status",
)


# --------------------------------------------------------------------------- #
# hashing / address helpers
# --------------------------------------------------------------------------- #

def _load_keccak() -> Callable[[bytes], bytes]:
    try:
        from Crypto.Hash import keccak  # type: ignore

        def k(data: bytes) -> bytes:
            h = keccak.new(digest_bits=256)
            h.update(data)
            return h.digest()

        return k
    except ImportError:
        pass
    try:
        import sha3  # type: ignore

        return lambda data: sha3.keccak_256(data).digest()
    except ImportError:
        pass
    try:
        from eth_hash.auto import keccak as eth_keccak  # type: ignore

        return lambda data: eth_keccak(data)
    except ImportError:
        pass
    sys.exit(
        "error: no Keccak-256 implementation found; run `pip install pycryptodome`"
    )


keccak256 = _load_keccak()

HEX40 = re.compile(r"^0x[0-9a-fA-F]{40}$")
HEX64 = re.compile(r"^(0x)?[0-9a-fA-F]{64}$")


def norm_address(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if value == "":
        return None
    if not HEX40.match(value):
        raise ValueError(f"invalid hex address: {value!r}")
    return value.lower()


def norm_secure_key(value: str) -> str:
    value = value.strip().lower()
    if value.startswith("0x"):
        value = value[2:]
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError(f"invalid secure key: {value!r}")
    return value


def secure_key_of(address: str) -> str:
    return keccak256(bytes.fromhex(address[2:])).hex()


def parse_int(value: str, what: str) -> int:
    value = value.strip()
    if value == "":
        return 0
    if not re.fullmatch(r"-?\d+", value):
        raise ValueError(f"{what}: not an integer: {value!r}")
    return int(value)


def parse_bool(value: str) -> bool:
    return value.strip().lower() in ("true", "1", "yes")


def opt(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value if value != "" else None


def opt_int(value: str | None) -> int | None:
    value = opt(value)
    return int(value) if value is not None else None


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# bech32 (BIP-173) for one1... validator addresses returned by the RPC.
_B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _bech32_polymod(values: Iterable[int]) -> int:
    gen = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    chk = 1
    for v in values:
        b = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ v
        for i in range(5):
            chk ^= gen[i] if ((b >> i) & 1) else 0
    return chk


def _bech32_hrp_expand(hrp: str) -> list[int]:
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]


def bech32_to_hex(addr: str) -> str:
    addr = addr.strip().lower()
    pos = addr.rfind("1")
    if pos < 1 or pos + 7 > len(addr):
        raise ValueError(f"invalid bech32: {addr!r}")
    hrp, data_part = addr[:pos], addr[pos + 1 :]
    if hrp != "one":
        raise ValueError(f"unexpected bech32 hrp {hrp!r}")
    data = [_B32.find(c) for c in data_part]
    if -1 in data:
        raise ValueError(f"invalid bech32 charset: {addr!r}")
    if _bech32_polymod(_bech32_hrp_expand(hrp) + data) != 1:
        raise ValueError(f"bad bech32 checksum: {addr!r}")
    payload = data[:-6]
    acc = bits = 0
    out = bytearray()
    for v in payload:
        acc = (acc << 5) | v
        bits += 5
        while bits >= 8:
            bits -= 8
            out.append((acc >> bits) & 0xFF)
    if len(out) != 20:
        raise ValueError(f"bech32 payload is not 20 bytes: {addr!r}")
    return "0x" + out.hex()


# --------------------------------------------------------------------------- #
# data model
# --------------------------------------------------------------------------- #

@dataclass
class Dataset:
    meta: dict[str, Any]
    destinations: list[tuple]
    exceptions: list[tuple]
    exchange_wallets: list[tuple]
    vaults: list[list]  # mutable so validator names can be filled in
    delegations: list[tuple]
    accounts: Callable[[], Iterator[tuple]]  # streaming factory
    inputs: dict[str, str]  # path -> sha256
    expected_accounts: int | None = None
    warnings: list[str] = field(default_factory=list)


class Inputs:
    """Resolves the harmony-migration input files."""

    def __init__(self, repo: Path):
        self.repo = repo
        claims = repo / "artifacts/cutoff-20260910/claims"
        review = repo / "artifacts/contract-review-20260911/out"
        routing = repo / "routing/local"
        self.all_accounts = claims / "all-address-migration-claims-cutoff-metadata.csv"
        self.activity = claims / "migration-claims-at-least-1000-one-metadata-activity.csv"
        self.policy_automatic = review / "policy-automatic.csv"
        self.policy_contract = review / "policy-genuine-contract-review.csv"
        self.policy_excluded = review / "policy-excluded.csv"
        self.validator_policy = review / "validator-policy-accounts.csv"
        self.contract_policy = review / "contract-review-policy.csv"
        self.priority_shares = review / "base-priority-vault-shares.csv"
        self.deferred_shares = review / "base-deferred-vault-shares.csv"
        self.vault_deposits = review / "base-validator-vault-deposits.csv"
        self.routing_exceptions = routing / "generated/routing-exceptions.csv"
        self.governor_exceptions = routing / "generated/validator-governor-exceptions.csv"
        self.destinations = routing / "destinations.csv"
        self.exchange_destinations = routing / "exchange-destinations.csv"
        self.exchange_policy = repo / "exchanges/exchange-policy.json"
        self.exchange_audits = repo / "artifacts/exchange-accounting-20260917/audits"
        self.manifest = repo / "manifests/snapshot-2026-09-10.json"
        self.routing_summary = routing / "generated/routing-summary.json"

    def exchange_audit_paths(self) -> list[Path]:
        if not self.exchange_policy.is_file():
            return []
        policy = json.loads(self.exchange_policy.read_text())
        return [
            self.exchange_audits / f"{row['id']}.csv"
            for row in policy.get("exchanges", [])
        ]

    def required(self, with_activity: bool) -> list[Path]:
        paths = [
            self.all_accounts,
            self.policy_automatic,
            self.policy_contract,
            self.policy_excluded,
            self.validator_policy,
            self.contract_policy,
            self.priority_shares,
            self.deferred_shares,
            self.vault_deposits,
            self.routing_exceptions,
            self.governor_exceptions,
            self.destinations,
            self.exchange_destinations,
            self.exchange_policy,
            *self.exchange_audit_paths(),
            self.manifest,
            self.routing_summary,
        ]
        if with_activity:
            paths.append(self.activity)
        return paths


def read_csv(path: Path) -> Iterator[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            return
        yield from reader


def log(msg: str) -> None:
    print(f"[inject] {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- #
# real dataset
# --------------------------------------------------------------------------- #

def build_real_dataset(
    inputs: Inputs, data_version: str, with_activity: bool, limit: int | None
) -> Dataset:
    missing = [str(p) for p in inputs.required(with_activity) if not p.is_file()]
    if missing:
        sys.exit("error: missing input files:\n  " + "\n  ".join(missing))

    warnings: list[str] = []
    manifest = json.loads(inputs.manifest.read_text())
    routing_summary = json.loads(inputs.routing_summary.read_text())
    threshold = int(manifest["eligibility_1000_one"]["threshold_atto"])

    # --- classification sets -------------------------------------------------
    policy_categories: dict[str, str] = {}
    for path, category in (
        (inputs.policy_automatic, "automatic"),
        (inputs.policy_contract, "contract_review"),
        (inputs.policy_excluded, "excluded"),
    ):
        for row in read_csv(path):
            a = norm_address(row["address"])
            if a:
                previous = policy_categories.setdefault(a, category)
                if previous != category:
                    raise ValueError(
                        f"address {a} appears in policy categories {previous} and {category}"
                    )

    validators: set[str] = set()
    for row in read_csv(inputs.validator_policy):
        a = norm_address(row["address"])
        if a:
            validators.add(a)
    contracts: dict[str, dict[str, str | None]] = {}
    for row in read_csv(inputs.contract_policy):
        a = norm_address(row["address"])
        if a is None:
            continue
        if row["primary_category"] == "validator-account":
            validators.add(a)
        else:
            known_app = (row.get("known_app") or "").strip()
            role = (row.get("known_app_role") or "").strip()
            primary = row["primary_category"].strip()
            if parse_bool(row.get("is_multisig") or "") or primary == "multisig-wallet":
                treatment = "multisig_next_stage"
            elif parse_bool(row.get("is_onewallet") or "") or primary == "onewallet":
                treatment = "onewallet_recovery"
            elif known_app == "Harmony LayerZero bridge (native ONE lock for bridged ONE)" or role.startswith("NativeOFT 'ONE for "):
                treatment = "bridge_later_portal"
            else:
                treatment = None
            contracts[a] = {
                "primary": primary,
                "subcategory": opt(row.get("subcategory")),
                "identity": opt(row.get("identity")),
                "treatment": treatment,
            }
    excluded = {a for a, category in policy_categories.items() if category == "excluded"}
    automatic = {a for a, category in policy_categories.items() if category == "automatic"}
    contract_review = {
        a for a, category in policy_categories.items() if category == "contract_review"
    }
    log(
        f"classification: validators={len(validators)} contracts={len(contracts)} "
        f"excluded={len(excluded)} automatic={len(automatic)} "
        f"contract_review={len(contract_review)}"
    )

    # --- destinations ----------------------------------------------------------
    destinations = []
    destination_ids: set[str] = set()
    destination_records: dict[str, tuple[str | None, str]] = {}
    for path in (inputs.destinations, inputs.exchange_destinations):
        for row in read_csv(path):
            destination_id = row["destination_id"].strip()
            if destination_id in destination_ids:
                raise ValueError(f"duplicate destination_id {destination_id!r}")
            destination_ids.add(destination_id)
            status = row["status"].strip()
            if status not in ("ready", "hold", "not_issuing", "redistributed"):
                raise ValueError(f"unknown destination status {status!r}")
            destination_address = norm_address(row.get("destination_address"))
            destination_records[destination_id] = (destination_address, status)
            destinations.append(
                (
                    destination_id,
                    destination_address,
                    status,
                    (row.get("notes") or "").strip(),
                )
            )

    # --- exchange-controlled wallet UI metadata -------------------------------
    exchange_policy = json.loads(inputs.exchange_policy.read_text())
    exchange_wallets: list[tuple] = []
    seen_exchange_wallets: set[tuple[str, str]] = set()
    for exchange in exchange_policy.get("exchanges", []):
        exchange_id = exchange["id"].strip()
        display_name = exchange["display_name"].strip()
        delivery_policy = exchange["delivery_policy"].strip()
        audit_path = inputs.exchange_audits / f"{exchange_id}.csv"
        for row in read_csv(audit_path):
            address = norm_address(row.get("address_hex"))
            if address is None:
                raise ValueError(f"{audit_path}: exchange row without address_hex")
            key = (exchange_id, address)
            if key in seen_exchange_wallets:
                raise ValueError(f"duplicate exchange wallet {exchange_id}:{address}")
            seen_exchange_wallets.add(key)
            configured_destination = norm_address(row.get("configured_destination"))
            configured_status = (row.get("configured_destination_status") or "hold").strip()
            if delivery_policy == "manual_current_claim":
                destination = destination_records.get(f"exchange-{exchange_id}")
                if destination is None:
                    raise ValueError(f"missing aggregate destination for exchange {exchange_id}")
                configured_destination, configured_status = destination
            exchange_wallets.append(
                (
                    exchange_id,
                    display_name,
                    address,
                    delivery_policy,
                    (row.get("qualification_status") or "unknown").strip(),
                    (row.get("planned_delivery_status") or "unknown").strip(),
                    configured_destination,
                    configured_status,
                )
            )
    log(f"exchange wallets: {len(exchange_wallets)}")

    # --- routing exceptions ----------------------------------------------------
    exceptions = []
    exception_sums: dict[tuple[str, str], int] = defaultdict(int)
    for row in read_csv(inputs.routing_exceptions):
        component = row["component"].strip()
        if component not in ("wallet_airdrop", "vault_shares"):
            raise ValueError(f"unknown component {component!r}")
        source = norm_address(row["source_address"])
        if source is None:
            raise ValueError("routing exception without source address")
        amount = parse_int(row["amount_atto"], "exception amount")
        status = row["destination_status"].strip()
        if status not in ("ready", "hold", "not_issuing", "redistributed"):
            raise ValueError(f"unknown destination_status {status!r}")
        exceptions.append(
            (
                component,
                source,
                row["source_category"].strip(),
                norm_address(row.get("validator_address")),
                amount,
                row["exception_type"].strip(),
                row["route_id"].strip(),
                parse_int(row["route_priority"], "route priority"),
                opt(row.get("destination_id")),
                norm_address(row.get("destination_address")),
                status,
                (row.get("reason") or "").strip(),
                (row.get("evidence") or "").strip(),
            )
        )
        exception_sums[(source, component)] += amount
    exception_sources = {src for src, _ in exception_sums}
    log(f"routing exceptions: {len(exceptions)} rows, {len(exception_sources)} sources")

    governors: dict[str, tuple[str | None, str]] = {}
    for row in read_csv(inputs.governor_exceptions):
        v = norm_address(row["validator_address"])
        if v:
            governors[v] = (opt(row.get("destination_id")), row["destination_status"].strip())

    # --- vaults and delegations --------------------------------------------------
    vaults: list[list] = []
    vault_addresses: set[str] = set()
    for row in read_csv(inputs.vault_deposits):
        v = norm_address(row["validator_address"])
        assert v is not None
        gov = governors.get(v, (None, "ready"))
        vaults.append(
            [
                v,
                parse_int(row["vault_assets_atto"], "vault assets"),
                parse_int(row["priority_staked_to_vault_atto"], "priority staked"),
                parse_int(row["deferred_staked_to_vault_atto"], "deferred staked"),
                parse_int(row["delegation_rows"], "delegation rows"),
                gov[0],
                gov[1],
                None,
            ]
        )
        vault_addresses.add(v)

    delegations = []
    delegation_sums: dict[str, int] = defaultdict(int)
    seen_positions: set[tuple[str, str]] = set()
    for path, priority in ((inputs.priority_shares, True), (inputs.deferred_shares, False)):
        for row in read_csv(path):
            v = norm_address(row["validator_address"])
            d = norm_address(row["delegator_address"])
            assert v is not None and d is not None
            if v not in vault_addresses:
                raise ValueError(f"delegation references unknown validator vault {v}")
            key = (v, d)
            if key in seen_positions:
                raise ValueError(f"duplicate delegation row {v} <- {d}")
            seen_positions.add(key)
            amount = parse_int(row["staked_to_vault_atto"], "delegation amount")
            delegations.append((v, d, amount, parse_bool(row["is_self_delegation"]), priority))
            delegation_sums[d] += amount
    log(f"vaults: {len(vaults)}, delegations: {len(delegations)}")

    # --- activity enrichment ------------------------------------------------------
    activity: dict[str, tuple] = {}
    if with_activity:
        for row in read_csv(inputs.activity):
            if opt(row.get("last_activity_time_utc")) is None:
                continue
            activity[norm_secure_key(row["secure_key"])] = (
                row["last_activity_time_utc"].strip(),
                opt_int(row.get("last_activity_timestamp_unix")),
                opt_int(row.get("last_activity_block")),
                opt_int(row.get("last_activity_shard")),
                opt(row.get("last_activity_type")),
                opt(row.get("last_activity_tx_hash")),
                opt_int(row.get("last_activity_index")),
                opt(row.get("last_activity_detail")),
            )
        log(f"activity rows: {len(activity)}")

    # --- accounts (streamed) ------------------------------------------------------
    stats: dict[str, Any] = {}

    def accounts() -> Iterator[tuple]:
        counts = defaultdict(int)
        seen_keys: set[str] = set()
        component_by_source: dict[str, tuple[int, int]] = {}
        delegation_mismatch = 0
        n = 0
        for row in read_csv(inputs.all_accounts):
            n += 1
            if limit is not None and n > limit:
                break
            secure_key = norm_secure_key(row["secure_key"])
            if secure_key in seen_keys:
                raise ValueError(f"duplicate secure_key {secure_key}")
            seen_keys.add(secure_key)
            resolved = parse_bool(row["address_resolved"])
            address = norm_address(row["address"]) if resolved else None
            if resolved:
                if address is None:
                    raise ValueError(f"row {n}: resolved without address")
                if secure_key_of(address) != secure_key:
                    raise ValueError(f"row {n}: keccak(address) != secure_key for {address}")
            amounts = {
                c: parse_int(row[c], c)
                for c in (
                    "liquid_shard0_atto",
                    "liquid_shard1_atto",
                    "active_staked_or_delegated_atto",
                    "pending_undelegation_atto",
                    "unclaimed_staking_reward_atto",
                    "pending_cross_shard_atto",
                    "native_wallet_airdrop_atto",
                    "wone_balance_atto",
                    "wone_airdrop_atto",
                    "wallet_airdrop_atto",
                    "staked_to_vault_atto",
                    "qualification_total_atto",
                    "native_total_claim_atto",
                    "total_claim_atto",
                )
            }
            if (
                amounts["native_wallet_airdrop_atto"] + amounts["staked_to_vault_atto"]
                != amounts["native_total_claim_atto"]
            ):
                raise ValueError(f"row {n}: native wallet + staked != native total for {address or secure_key}")
            if (
                amounts["native_total_claim_atto"] + amounts["wone_balance_atto"]
                != amounts["qualification_total_atto"]
            ):
                raise ValueError(f"row {n}: native total + WONE != qualification total for {address or secure_key}")
            if (
                amounts["native_wallet_airdrop_atto"] + amounts["wone_airdrop_atto"]
                != amounts["wallet_airdrop_atto"]
            ):
                raise ValueError(f"row {n}: native wallet + WONE airdrop != wallet total for {address or secure_key}")
            if amounts["wallet_airdrop_atto"] + amounts["staked_to_vault_atto"] != amounts["total_claim_atto"]:
                raise ValueError(f"row {n}: wallet + staked != total for {address or secure_key}")
            code0 = opt(row.get("code_hash_shard0"))
            code1 = opt(row.get("code_hash_shard1"))
            code_bearing = any(
                c is not None and c.lower() != EMPTY_CODE_HASH for c in (code0, code1)
            )
            details = contracts.get(address) if address is not None else None
            primary: str | None = None
            subcategory: str | None = None
            identity: str | None = None
            treatment: str | None = None
            policy_category = policy_categories.get(address, "deferred")
            if address in excluded:
                category = "excluded"
            elif address in validators:
                category = "validator_account"
            elif details is not None or address in contract_review:
                category = "contract"
                primary = str(details["primary"]) if details else "unclassified-contract-review"
                subcategory = details["subcategory"] if details else None
                identity = details["identity"] if details else None
                treatment = details["treatment"] if details else None
            elif code_bearing:
                category = "contract"
                primary = "unreviewed-code-bearing"
            else:
                category = "ordinary_eoa"
            meets = amounts["qualification_total_atto"] >= threshold
            categorized_as_priority = policy_category in ("automatic", "contract_review", "excluded")
            if limit is None and resolved and meets != categorized_as_priority:
                raise ValueError(
                    f"row {n}: threshold/category mismatch for {address}: "
                    f"meets={meets} policy={policy_category}"
                )
            counts[category] += 1
            counts[f"policy_{policy_category}"] += 1
            if treatment:
                counts[f"treatment_{treatment}"] += 1
            if meets:
                counts["meets_threshold"] += 1
            if address is not None:
                if address in exception_sources:
                    component_by_source[address] = (
                        amounts["wallet_airdrop_atto"],
                        amounts["staked_to_vault_atto"],
                    )
                staked_sum = delegation_sums.get(address)
                if staked_sum is not None and staked_sum != amounts["staked_to_vault_atto"]:
                    delegation_mismatch += 1
                elif staked_sum is None and amounts["staked_to_vault_atto"] != 0:
                    delegation_mismatch += 1
            act = activity.get(secure_key, (None,) * 8)
            yield (
                secure_key,
                address,
                resolved,
                category,
                code_bearing,
                primary,
                subcategory,
                identity,
                treatment,
                policy_category,
                amounts["liquid_shard0_atto"],
                amounts["liquid_shard1_atto"],
                amounts["active_staked_or_delegated_atto"],
                amounts["pending_undelegation_atto"],
                amounts["unclaimed_staking_reward_atto"],
                amounts["pending_cross_shard_atto"],
                amounts["native_wallet_airdrop_atto"],
                amounts["wone_balance_atto"],
                amounts["wone_airdrop_atto"],
                amounts["wallet_airdrop_atto"],
                amounts["staked_to_vault_atto"],
                amounts["qualification_total_atto"],
                amounts["native_total_claim_atto"],
                amounts["total_claim_atto"],
                meets,
                opt_int(row.get("nonce_shard0")),
                opt_int(row.get("nonce_shard1")),
                code0,
                code1,
                *act,
            )
            if n % 250_000 == 0:
                log(f"  accounts processed: {n}")
        # cross-file checks once the stream is complete
        over = []
        missing_sources = []
        for (source, component), total in exception_sums.items():
            comp = component_by_source.get(source)
            if comp is None:
                missing_sources.append(source)
                continue
            cap = comp[0] if component == "wallet_airdrop" else comp[1]
            if total > cap:
                over.append((source, component, total, cap))
        if limit is None:
            if missing_sources:
                raise ValueError(
                    f"{len(missing_sources)} routing exception sources are absent from the "
                    "all-accounts file"
                )
            if over:
                raise ValueError(
                    f"{len(over)} (source, component) pairs have exception sums above the "
                    "source component"
                )
        if delegation_mismatch:
            warnings.append(
                f"{delegation_mismatch} accounts whose delegation sum differs from staked_to_vault_atto"
            )
        stats.update(counts)
        stats["rows"] = n if limit is None else min(n, limit)

    input_hashes = {
        str(p.relative_to(inputs.repo)): sha256_file(p) for p in inputs.required(with_activity)
    }
    meta = {
        "cutoff": manifest["cutoff"],
        "valuation": manifest.get("valuation", {}),
        "threshold_atto": str(threshold),
        "eligibility": {
            **manifest["eligibility_1000_one"],
            "field": "qualification_total_atto",
        },
        "data_version": data_version,
        "routing": {
            "status": routing_summary.get("status"),
            "pending_policy_decisions": routing_summary.get("pending_policy_decisions", []),
            "contract_review_policy_state": routing_summary.get("contract_review_policy_state"),
        },
        "source_files": input_hashes,
    }
    ds = Dataset(
        meta=meta,
        destinations=destinations,
        exceptions=exceptions,
        exchange_wallets=exchange_wallets,
        vaults=vaults,
        delegations=delegations,
        accounts=accounts,
        inputs=input_hashes,
        warnings=warnings,
    )
    ds.stats = stats  # type: ignore[attr-defined]
    return ds


# --------------------------------------------------------------------------- #
# fixture dataset (synthetic, safe to publish)
# --------------------------------------------------------------------------- #

# Hardhat's public development accounts. Not real Harmony users.
FIX = [
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
    "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
    "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
]
FIX = [a.lower() for a in FIX]


def build_fixture_dataset(data_version: str) -> Dataset:
    threshold = 1000 * ONE
    eoa, small, v1, v2, excl, partial, safe, wone, deferred, deleg = FIX

    def acct(
        address: str | None,
        category: str,
        *,
        liquid0=0,
        liquid1=0,
        staked=0,
        undelegation=0,
        reward=0,
        cross=0,
        wone_balance=0,
        code_bearing=False,
        primary=None,
        subcategory=None,
        identity=None,
        treatment=None,
        policy_category=None,
        secure_key: str | None = None,
        activity: tuple | None = None,
    ) -> tuple:
        native_wallet = liquid0 + liquid1 + undelegation + reward + cross
        native_total = native_wallet + staked
        qualification_total = native_total + wone_balance
        meets = qualification_total >= threshold
        wone_airdrop = wone_balance if meets else 0
        wallet = native_wallet + wone_airdrop
        total = wallet + staked
        if policy_category is None:
            if not meets:
                policy_category = "deferred"
            elif category == "excluded":
                policy_category = "excluded"
            elif category == "contract":
                policy_category = "contract_review"
            else:
                policy_category = "automatic"
        key = secure_key or secure_key_of(address)  # type: ignore[arg-type]
        act = activity or (None,) * 8
        return (
            key,
            address,
            address is not None,
            category,
            code_bearing,
            primary,
            subcategory,
            identity,
            treatment,
            policy_category,
            liquid0,
            liquid1,
            staked,
            undelegation,
            reward,
            cross,
            native_wallet,
            wone_balance,
            wone_airdrop,
            wallet,
            staked,
            qualification_total,
            native_total,
            total,
            meets,
            7,
            0,
            ("0x" + "f1" * 32) if code_bearing else EMPTY_CODE_HASH,
            None,
            *act,
        )

    activity = (
        "2026-09-01T12:00:00Z",
        1788264000,
        93_000_000,
        0,
        "regular",
        "0x" + "ab" * 32,
        3,
        "transfer",
    )
    accounts = [
        acct(eoa, "ordinary_eoa", liquid0=5000 * ONE, liquid1=250 * ONE, undelegation=10 * ONE,
             reward=15 * ONE // 10, staked=2000 * ONE, wone_balance=250 * ONE, activity=activity),
        acct(small, "ordinary_eoa", liquid0=7 * ONE, staked=5 * ONE),
        acct(v1, "validator_account", liquid0=300 * ONE, staked=10_000 * ONE, code_bearing=True),
        acct(v2, "validator_account", liquid0=100 * ONE, staked=20_000 * ONE, code_bearing=True),
        acct(excl, "excluded", liquid0=1000 * ONE, staked=4000 * ONE),
        acct(partial, "ordinary_eoa", liquid0=8000 * ONE, staked=2000 * ONE),
        acct(safe, "contract", liquid0=50_000 * ONE, code_bearing=True, primary="multisig-wallet",
             subcategory="gnosis-safe", identity="2-of-3 fixture Safe",
             treatment="multisig_next_stage"),
        acct(wone, "contract", liquid0=1_000_000 * ONE, code_bearing=True, primary="erc20-token"),
        acct(deferred, "ordinary_eoa", liquid0=500 * ONE),
        acct(deleg, "ordinary_eoa", liquid0=100 * ONE, staked=1500 * ONE),
        acct(None, "ordinary_eoa", liquid0=3 * ONE,
             secure_key=keccak256(b"fixture-unresolved-account").hex()),
    ]

    delegations = [
        (v1, eoa, 2000 * ONE, False, True),
        (v1, small, 5 * ONE, False, False),
        (v1, v1, 10_000 * ONE, True, True),
        (v1, excl, 3000 * ONE, False, True),
        (v1, partial, 2000 * ONE, False, True),
        (v2, v2, 20_000 * ONE, True, True),
        (v2, excl, 1000 * ONE, False, True),
        (v2, deleg, 1500 * ONE, False, True),
    ]
    vaults = [
        [v1, 17_005 * ONE, 17_000 * ONE, 5 * ONE, 5, None, "ready", None],
        [v2, 22_500 * ONE, 22_500 * ONE, 0, 3, None, "hold", None],
    ]
    destinations = [
        ("not-issuing", None, "not_issuing", "terminal non-issuance"),
        ("wone-holder-redistribution", None, "redistributed", "terminal source offset"),
        ("contract-recovery-custody", None, "hold", "segregated recovery custody, address pending"),
        ("treasury", None, "hold", ""),
        ("exchange-okx", eoa, "ready", "synthetic exchange aggregate"),
    ]
    vw = "verified validator wrapper same-address"
    ev = "artifacts/contract-review-20260911/out/validator-policy-accounts.csv"
    exceptions = [
        # validator wrappers: same-address, ready
        ("wallet_airdrop", v1, "validator_account", None, 300 * ONE, "validator_wrapper_same_address",
         "default-v1", 1_000_000, None, v1, "ready", vw, ev),
        ("vault_shares", v1, "validator_account", v1, 10_000 * ONE, "validator_wrapper_same_address",
         "default-v1", 1_000_000, None, v1, "ready", vw, ev),
        ("wallet_airdrop", v2, "validator_account", None, 100 * ONE, "validator_wrapper_same_address",
         "default-v2", 1_000_000, None, v2, "ready", vw, ev),
        ("vault_shares", v2, "validator_account", v2, 20_000 * ONE, "validator_wrapper_same_address",
         "default-v2", 1_000_000, None, v2, "ready", vw, ev),
        # excluded: everything not issued (wallet first, then pro-rata vault)
        ("wallet_airdrop", excl, "excluded", None, 1000 * ONE, "explicit_route",
         "not-issuing-fixture-excl", 100, "not-issuing", None, "not_issuing",
         "not_issuing_blacklisted_extra_mint_recipient", "fixture incident report"),
        ("vault_shares", excl, "excluded", v1, 3000 * ONE, "explicit_route",
         "not-issuing-fixture-excl", 100, "not-issuing", None, "not_issuing",
         "not_issuing_blacklisted_extra_mint_recipient", "fixture incident report"),
        ("vault_shares", excl, "excluded", v2, 1000 * ONE, "explicit_route",
         "not-issuing-fixture-excl", 100, "not-issuing", None, "not_issuing",
         "not_issuing_blacklisted_extra_mint_recipient", "fixture incident report"),
        # ordinary EOA with a partial not-issuing deduction on the wallet only
        ("wallet_airdrop", partial, "ordinary_eoa", None, 5000 * ONE, "explicit_route",
         "not-issuing-fixture-partial", 100, "not-issuing", None, "not_issuing",
         "not_issuing_blacklisted_extra_mint_recipient", "fixture incident report"),
        # Safe multisig: hold pending replacement Safe
        ("wallet_airdrop", safe, "contract_review", None, 50_000 * ONE, "contract_review_hold",
         "default-safe", 1_000_000, None, None, "hold", "contract_review", ""),
        # WONE-like reserve: holder offset + retained reserve + shard residual.
        ("wallet_airdrop", wone, "contract_review", None, 900_000 * ONE, "explicit_route",
         "wone-priority-holder-redistribution", 400, "wone-holder-redistribution", None,
         "redistributed", "wone_priority_holder_redistribution", "fixture WONE accounting"),
        ("wallet_airdrop", wone, "contract_review", None, 90_000 * ONE, "explicit_route",
         "wone-reserve-remainder-not-issued", 401, "not-issuing", None, "not_issuing",
         "wone_reserve_remainder_retained_not_issued", "fixture WONE accounting"),
        ("wallet_airdrop", wone, "contract_review", None, 10_000 * ONE, "explicit_route",
         "contract-custody-fixture-wone", 500, "contract-recovery-custody", None, "hold",
         "non_multisig_contract_recovery_custody", "contract review"),
        # deferred account with an explicit partial route and a deferred hold remainder
        ("wallet_airdrop", deferred, "deferred", None, 200 * ONE, "explicit_route",
         "not-issuing-fixture-deferred", 100, "not-issuing", None, "not_issuing",
         "not_issuing_reported_wallet_theft_perpetrator", "fixture theft report"),
        ("wallet_airdrop", deferred, "deferred", None, 300 * ONE, "deferred_hold",
         "default-deferred", 1_000_000, None, None, "hold", "deferred", ""),
    ]
    exchange_wallets = [
        (
            "gate",
            "Gate",
            deferred,
            "automatic_threshold",
            "below_threshold",
            "below_threshold_not_airdropped",
            None,
            "not_required_same_address",
        ),
        (
            "okx",
            "OKX",
            deleg,
            "manual_current_claim",
            "qualified",
            "manual_exchange_route",
            eoa,
            "ready",
        ),
        (
            "mexc",
            "MEXC",
            "0x5555555555555555555555555555555555555555",
            "manual_current_claim",
            "below_threshold",
            "no_cutoff_claim",
            eoa,
            "ready",
        ),
    ]
    meta = {
        "cutoff": {
            "requested_time_utc": "2026-09-10T14:00:00Z",
            "shard0": {"block": 93_623_067, "timestamp_utc": "2026-09-10T14:00:00Z",
                       "hash": "0x" + "11" * 32, "state_root": "0x" + "22" * 32},
            "shard1": {"block": 95_882_100, "timestamp_utc": "2026-09-10T14:00:00Z",
                       "hash": "0x" + "33" * 32, "state_root": "0x" + "44" * 32},
        },
        "valuation": {"usd_per_one": "0.01", "reference_shard0_block": 93_623_067,
                      "note": "fixture"},
        "threshold_atto": str(threshold),
        "eligibility": {"threshold_atto": str(threshold), "field": "qualification_total_atto",
                        "equality_policy": "include",
                        "selected_comparison": "greater-than-or-equal"},
        "data_version": data_version,
        "routing": {"status": "fixture", "pending_policy_decisions": [],
                    "contract_review_policy_state": None},
        "source_files": {},
        "fixture": True,
    }
    ds = Dataset(
        meta=meta,
        destinations=destinations,
        exceptions=exceptions,
        exchange_wallets=exchange_wallets,
        vaults=vaults,
        delegations=delegations,
        accounts=lambda: iter(accounts),
        inputs={"fixture": "synthetic"},
        expected_accounts=len(accounts),
    )
    ds.stats = {"rows": len(accounts)}  # type: ignore[attr-defined]
    return ds


# --------------------------------------------------------------------------- #
# validator names via RPC
# --------------------------------------------------------------------------- #

def fetch_validator_names(rpc_url: str) -> dict[str, str]:
    names: dict[str, str] = {}
    page = 0
    while True:
        body = json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": "hmyv2_getAllValidatorInformation",
             "params": [page]}
        ).encode()
        req = urllib.request.Request(rpc_url, data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read())
        if "error" in payload:
            raise RuntimeError(f"rpc error: {payload['error']}")
        result = payload.get("result") or []
        if not result:
            break
        for item in result:
            v = item.get("validator") or {}
            addr = v.get("address")
            name = (v.get("name") or "").strip()
            if not addr or not name:
                continue
            hexaddr = bech32_to_hex(addr) if addr.startswith("one1") else norm_address(addr)
            if hexaddr:
                names[hexaddr] = name
        page += 1
        if page > 1000:
            break
    return names


# --------------------------------------------------------------------------- #
# database load
# --------------------------------------------------------------------------- #

def load_reason_texts() -> dict[str, dict[str, str]]:
    path = Path(__file__).resolve().parent.parent / "db/seed/reason_texts.json"
    if not path.is_file():
        return {}
    return json.loads(path.read_text())


def copy_rows(cur, table: str, columns: tuple[str, ...], rows: Iterable[tuple]) -> int:
    cols = ", ".join(columns)
    n = 0
    with cur.copy(f"COPY {STAGING}.{table} ({cols}) FROM STDIN") as cp:
        for row in rows:
            cp.write_row(row)
            n += 1
    return n


def load_into_db(ds: Dataset, dsn: str, data_version: str, started: dt.datetime) -> dict[str, int]:
    import psycopg

    counts: dict[str, int] = {}
    with psycopg.connect(dsn, autocommit=False) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='accounts'")
            if cur.fetchone() is None:
                sys.exit("error: schema not applied; run db/migrations/001_schema.sql first")
            cur.execute(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema='public' AND table_name='exchange_wallets'"
            )
            if cur.fetchone() is None:
                sys.exit("error: WONE policy schema not applied; run db/migrations/002_wone_policy.sql")
            cur.execute(f"DROP SCHEMA IF EXISTS {STAGING} CASCADE")
            cur.execute(f"CREATE SCHEMA {STAGING}")
            for t in DATA_TABLES:
                cur.execute(f"CREATE TABLE {STAGING}.{t} (LIKE public.{t} INCLUDING ALL)")
            conn.commit()

            log("copying destinations, exceptions, exchange wallets, vaults, delegations")
            counts["routing_destinations"] = copy_rows(cur, "routing_destinations", DESTINATION_COLUMNS, ds.destinations)
            counts["routing_exceptions"] = copy_rows(cur, "routing_exceptions", EXCEPTION_COLUMNS, ds.exceptions)
            counts["exchange_wallets"] = copy_rows(cur, "exchange_wallets", EXCHANGE_COLUMNS, ds.exchange_wallets)
            counts["validator_vaults"] = copy_rows(cur, "validator_vaults", VAULT_COLUMNS, (tuple(v) for v in ds.vaults))
            counts["delegations"] = copy_rows(cur, "delegations", DELEGATION_COLUMNS, ds.delegations)
            log("copying accounts")
            counts["accounts"] = copy_rows(cur, "accounts", ACCOUNT_COLUMNS, ds.accounts())
            if ds.expected_accounts is not None and counts["accounts"] != ds.expected_accounts:
                raise RuntimeError("account row count mismatch")

            loaded_at = dt.datetime.now(dt.timezone.utc).isoformat()
            meta_rows = [(k, json.dumps(v)) for k, v in ds.meta.items()]
            meta_rows.append(("loaded_at", json.dumps(loaded_at)))
            meta_rows.append(("row_counts", json.dumps(counts)))
            counts["snapshot_meta"] = copy_rows(cur, "snapshot_meta", ("key", "value"), meta_rows)
            conn.commit()

            log("swapping staging tables into public")
            for t in DATA_TABLES:
                cur.execute(f"DROP TABLE public.{t}")
                cur.execute(f"ALTER TABLE {STAGING}.{t} SET SCHEMA public")
            cur.execute(f"DROP SCHEMA {STAGING}")
            for code, text in load_reason_texts().items():
                cur.execute(
                    "INSERT INTO reason_texts (reason_code, title, user_text) VALUES (%s, %s, %s) "
                    "ON CONFLICT (reason_code) DO UPDATE SET title = EXCLUDED.title, user_text = EXCLUDED.user_text",
                    (code, text["title"], text["user_text"]),
                )
            cur.execute(
                "INSERT INTO load_runs (started_at, finished_at, data_version, inputs, row_counts) "
                "VALUES (%s, now(), %s, %s, %s)",
                (started, data_version, json.dumps(ds.inputs), json.dumps(counts)),
            )
            conn.commit()
            for t in DATA_TABLES:
                cur.execute(f"ANALYZE public.{t}")
            conn.commit()
    return counts


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--migration-repo", default=os.path.expanduser("~/git/harmony-migration"))
    p.add_argument("--dsn", default=os.environ.get("DATABASE_URL", DEFAULT_DSN))
    p.add_argument("--data-version", default=dt.date.today().isoformat())
    p.add_argument("--dry-run", action="store_true", help="parse and verify only")
    p.add_argument("--fixture", action="store_true", help="load synthetic rows")
    p.add_argument("--validator-names", action="store_true", help="fetch validator names via RPC")
    p.add_argument("--rpc-url", default=DEFAULT_RPC)
    p.add_argument("--no-activity", action="store_true", help="skip the activity enrichment file")
    p.add_argument("--limit", type=int, default=None, help="only read the first N account rows")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    started = dt.datetime.now(dt.timezone.utc)
    t0 = time.monotonic()

    if args.fixture:
        ds = build_fixture_dataset(args.data_version)
    else:
        ds = build_real_dataset(
            Inputs(Path(args.migration_repo).expanduser()),
            args.data_version,
            with_activity=not args.no_activity,
            limit=args.limit,
        )

    if args.validator_names:
        log(f"fetching validator names from {args.rpc_url}")
        names = fetch_validator_names(args.rpc_url)
        hit = 0
        for v in ds.vaults:
            name = names.get(v[0])
            if name:
                v[7] = name
                hit += 1
        log(f"validator names: {hit}/{len(ds.vaults)} vaults named")

    if args.dry_run:
        n = 0
        for _ in ds.accounts():
            n += 1
        counts = {
            "accounts": n,
            "delegations": len(ds.delegations),
            "validator_vaults": len(ds.vaults),
            "routing_exceptions": len(ds.exceptions),
            "routing_destinations": len(ds.destinations),
            "exchange_wallets": len(ds.exchange_wallets),
        }
    else:
        counts = load_into_db(ds, args.dsn, args.data_version, started)

    stats = getattr(ds, "stats", {})
    summary = {
        "mode": "dry-run" if args.dry_run else "loaded",
        "fixture": args.fixture,
        "data_version": args.data_version,
        "row_counts": counts,
        "account_categories": {k: v for k, v in stats.items() if k in CATEGORIES},
        "policy_categories": {
            k.removeprefix("policy_"): v
            for k, v in stats.items()
            if k.startswith("policy_")
        },
        "contract_treatments": {
            k.removeprefix("treatment_"): v
            for k, v in stats.items()
            if k.startswith("treatment_")
        },
        "meets_threshold": stats.get("meets_threshold"),
        "warnings": ds.warnings,
        "elapsed_seconds": round(time.monotonic() - t0, 1),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
