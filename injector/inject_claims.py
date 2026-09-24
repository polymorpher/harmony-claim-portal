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
import subprocess
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

ROUTE_STAGES = (None, "initial", "exchange_manual", "next_stage", "deferred", "manual_review")
ROUTE_TREATMENTS = ("issue", "manual_from_reserve", "not_issued", "redistributed")
ROUTE_STATUSES = ("ready", "hold", "exchange_manual", "not_issuing", "redistributed")
DESTINATION_STATUSES = ROUTE_STATUSES
# Exchange wallets leave the airdrop; their whole remaining entitlement is
# delivered by hand from the 2050 supply reserve.
EXCHANGE_ROUTE_REASON = "exchange_manual_reserve_delivery"
EXCHANGE_STAGE_REASON = "exchange wallet delivered manually from the 2050 supply reserve"
EXCHANGE_DESTINATION_MODES = ("aggregate", "aggregate_split", "same_address", "tiered")
EXCHANGE_DELIVERY_STATUSES = ("exchange_manual", "hold")

# Data tables replaced by the swap, in dependency-free order.
# Schema confirm (next-batch signatures) is not in this list and must stay out of it.
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
    "stage_policy_applied",
    "migration_stage",
    "issuance_treatment",
    "stage_reason",
    "migration_wallet_allocation_atto",
    "migration_staked_to_vault_atto",
    "migration_allocation_atto",
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
    "initial_assets_atto",
    "exchange_manual_assets_atto",
    "next_stage_assets_atto",
    "qualified_deferred_assets_atto",
    "manual_review_assets_atto",
    "uncompiled_deferred_assets_atto",
    "not_issued_assets_atto",
    "post_policy_assets_atto",
)
EXCEPTION_COLUMNS = (
    "component",
    "source_address",
    "source_category",
    "migration_stage",
    "issuance_treatment",
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
    "migration_stage",
    "issuance_treatment",
    "planned_delivery_status",
    "configured_destination",
    "configured_destination_status",
    "destination_mode",
    "delivery_tier",
    "planned_wallet_destination",
    "planned_staking_destination",
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

def require_sha256(path: Path, expected: str | None, label: str) -> None:
    if not expected:
        raise ValueError(f"{label}: missing declared SHA-256")
    actual = sha256_file(path)
    if actual != expected:
        raise ValueError(f"{label}: SHA-256 mismatch for {path}")

def git_head(path: Path) -> str | None:
    if not (path / ".git").exists():
        return None
    result = subprocess.run(
        ["git", "-C", str(path), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    )
    value = result.stdout.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError(f"invalid git HEAD for {path}")
    return value


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
        self.stage_policy = repo / "artifacts/migration-policy-20260917/migration-stage-policy.csv"
        self.stage_summary = repo / "artifacts/migration-policy-20260917/migration-stage-summary.json"
        self.validator_policy = review / "validator-policy-accounts.csv"
        self.contract_policy = review / "contract-review-policy.csv"
        self.priority_shares = review / "base-priority-vault-shares.csv"
        self.deferred_shares = review / "base-deferred-vault-shares.csv"
        self.vault_deposits = review / "base-validator-vault-deposits.csv"
        self.routing_exceptions = routing / "generated/routing-exceptions.csv"
        self.governor_exceptions = routing / "generated/validator-governor-exceptions.csv"
        self.vault_stages = routing / "generated/validator-vault-stages.csv"
        initial_stage = routing / "generated/initial-stage"
        self.initial_stage_summary = initial_stage / "summary.json"
        self.initial_wallets = initial_stage / "wallet-allocations.csv"
        self.initial_vault_shares = initial_stage / "vault-shares.csv"
        self.initial_validator_vaults = initial_stage / "validator-vaults.csv"
        self.initial_unresolved = initial_stage / "unresolved.csv"
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
            self.stage_policy,
            self.stage_summary,
            self.validator_policy,
            self.contract_policy,
            self.priority_shares,
            self.deferred_shares,
            self.vault_deposits,
            self.routing_exceptions,
            self.governor_exceptions,
            self.vault_stages,
            self.initial_stage_summary,
            self.initial_wallets,
            self.initial_vault_shares,
            self.initial_validator_vaults,
            self.initial_unresolved,
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
    stage_summary = json.loads(inputs.stage_summary.read_text())
    threshold = int(manifest["eligibility_1000_one"]["threshold_atto"])
    if stage_summary.get("status") != "passed":
        raise ValueError("migration-stage summary is not passed")
    require_sha256(
        inputs.stage_policy,
        stage_summary.get("output_sha256"),
        "migration-stage policy",
    )
    require_sha256(
        inputs.stage_policy,
        routing_summary.get("migration_stages_sha256"),
        "routing migration-stage input",
    )
    routing_outputs = routing_summary.get("outputs", {})
    for key, path in (
        ("routing_exceptions", inputs.routing_exceptions),
        ("governor_exceptions", inputs.governor_exceptions),
        ("vault_stages", inputs.vault_stages),
    ):
        require_sha256(
            path,
            (routing_outputs.get(key) or {}).get("sha256"),
            f"routing {key}",
        )

    stage_policy: dict[str, dict[str, Any]] = {}
    for row in read_csv(inputs.stage_policy):
        address = norm_address(row["address"])
        if address is None:
            raise ValueError("migration-stage row without address")
        secure_key = norm_secure_key(row["secure_key"])
        if secure_key_of(address) != secure_key:
            raise ValueError(f"migration-stage secure key mismatch for {address}")
        if address in stage_policy:
            raise ValueError(f"duplicate migration-stage row for {address}")
        issuance = row["issuance_treatment"].strip()
        if issuance not in ("issue", "not_issued"):
            raise ValueError(f"unknown issuance_treatment {issuance!r}")
        stage = opt(row.get("migration_stage"))
        if stage not in (None, "initial", "next_stage", "deferred"):
            raise ValueError(f"unknown migration_stage {stage!r}")
        stage_policy[address] = {
            "stage": stage,
            "issuance": issuance,
            "reason": (row.get("stage_reason") or "").strip(),
            "wallet": parse_int(
                row["migration_wallet_allocation_atto"],
                "migration wallet allocation",
            ),
            "staked": parse_int(
                row["migration_staked_to_vault_atto"],
                "migration staked allocation",
            ),
            "total": parse_int(
                row["migration_allocation_atto"],
                "migration total allocation",
            ),
        }
    if len(stage_policy) != int(stage_summary["qualified_rows"]):
        raise ValueError("migration-stage row count does not match summary")
    log(f"migration-stage rows: {len(stage_policy)}")

    # --- routing exceptions ----------------------------------------------------
    exceptions = []
    exception_sums: dict[tuple[str, str], int] = defaultdict(int)
    terminal_component_sums: dict[tuple[str, str], int] = defaultdict(int)
    # source -> [wallet_airdrop, vault_shares] delivered by exchange arrangement
    exchange_routes: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    exchange_route_destinations: dict[str, set[str]] = defaultdict(set)
    exchange_vault_assets: dict[str, int] = defaultdict(int)
    for row in read_csv(inputs.routing_exceptions):
        component = row["component"].strip()
        if component not in ("wallet_airdrop", "vault_shares"):
            raise ValueError(f"unknown component {component!r}")
        source = norm_address(row["source_address"])
        if source is None:
            raise ValueError("routing exception without source address")
        amount = parse_int(row["amount_atto"], "exception amount")
        status = row["destination_status"].strip()
        if status not in ROUTE_STATUSES:
            raise ValueError(f"unknown destination_status {status!r}")
        migration_stage = opt(row.get("migration_stage"))
        if migration_stage not in ROUTE_STAGES:
            raise ValueError(f"unknown route migration_stage {migration_stage!r}")
        issuance_treatment = (row.get("issuance_treatment") or "issue").strip()
        if issuance_treatment not in ROUTE_TREATMENTS:
            raise ValueError(f"unknown route issuance_treatment {issuance_treatment!r}")
        reason = (row.get("reason") or "").strip()
        validator = norm_address(row.get("validator_address"))
        destination_address = norm_address(row.get("destination_address"))
        exchange_route = reason == EXCHANGE_ROUTE_REASON
        if exchange_route != (issuance_treatment == "manual_from_reserve"):
            raise ValueError(f"exchange reason/treatment mismatch for {source}")
        if exchange_route != (migration_stage == "exchange_manual"):
            raise ValueError(f"exchange reason/stage mismatch for {source}")
        if exchange_route:
            if status not in EXCHANGE_DELIVERY_STATUSES:
                raise ValueError(f"exchange route with destination_status {status!r}")
            if status == "exchange_manual" and destination_address is None:
                raise ValueError(f"exchange route without destination for {source}")
            exchange_routes[source][0 if component == "wallet_airdrop" else 1] += amount
            if destination_address is not None:
                exchange_route_destinations[source].add(destination_address)
            if component == "vault_shares":
                if validator is None:
                    raise ValueError(f"exchange vault route without validator for {source}")
                exchange_vault_assets[validator] += amount
        else:
            expected_treatment = {
                "ready": "issue",
                "hold": "issue",
                "not_issuing": "not_issued",
                "redistributed": "redistributed",
            }.get(status)
            if issuance_treatment != expected_treatment:
                raise ValueError(
                    f"route treatment {issuance_treatment!r} does not match status {status!r}"
                )
        exceptions.append(
            (
                component,
                source,
                row["source_category"].strip(),
                migration_stage,
                issuance_treatment,
                validator,
                amount,
                row["exception_type"].strip(),
                row["route_id"].strip(),
                parse_int(row["route_priority"], "route priority"),
                opt(row.get("destination_id")),
                destination_address,
                status,
                reason,
                (row.get("evidence") or "").strip(),
            )
        )
        exception_sums[(source, component)] += amount
        if status in ("not_issuing", "redistributed"):
            terminal_component_sums[(source, component)] += amount
    exception_sources = {src for src, _ in exception_sums}
    for source in exchange_routes:
        if source in stage_policy and stage_policy[source]["issuance"] != "issue":
            raise ValueError(f"exchange route for a not-issued stage-policy row {source}")
    log(
        f"routing exceptions: {len(exceptions)} rows, {len(exception_sources)} sources, "
        f"{len(exchange_routes)} exchange manual-delivery sources"
    )

    initial_summary = json.loads(inputs.initial_stage_summary.read_text())
    if initial_summary.get("migration_stage") != "initial":
        raise ValueError("initial-stage summary has the wrong migration stage")
    if initial_summary.get("issuance_treatment") != "issue":
        raise ValueError("initial-stage summary has the wrong issuance treatment")
    initial_inputs = initial_summary.get("inputs", {})
    for key, path in (
        ("stage_policy", inputs.stage_policy),
        ("routing_exceptions", inputs.routing_exceptions),
        ("governor_exceptions", inputs.governor_exceptions),
        ("vault_stages", inputs.vault_stages),
        ("routing_summary", inputs.routing_summary),
    ):
        require_sha256(
            path,
            (initial_inputs.get(key) or {}).get("sha256"),
            f"initial-stage {key} input",
        )
    initial_outputs = initial_summary.get("outputs", {})
    for key, path in (
        ("wallets", inputs.initial_wallets),
        ("vault_shares", inputs.initial_vault_shares),
        ("validator_vaults", inputs.initial_validator_vaults),
        ("unresolved", inputs.initial_unresolved),
    ):
        require_sha256(
            path,
            (initial_outputs.get(key) or {}).get("sha256"),
            f"initial-stage {key} output",
        )
    initial_wallets: dict[str, int] = {}
    initial_wallet_total = 0
    for row in read_csv(inputs.initial_wallets):
        address = norm_address(row["source_address"])
        if address is None or address in initial_wallets:
            raise ValueError("invalid or duplicate initial-stage wallet")
        status = row["destination_status"].strip()
        destination = norm_address(row.get("destination_address"))
        if status not in ("ready", "hold"):
            raise ValueError(f"invalid initial wallet destination status {status!r}")
        if status == "ready" and destination is None:
            raise ValueError("ready initial wallet is missing its destination")
        amount = parse_int(row["amount_atto"], "initial wallet amount")
        initial_wallets[address] = amount
        initial_wallet_total += amount
    initial_shares: dict[str, int] = defaultdict(int)
    initial_share_rows = 0
    initial_share_total = 0
    for row in read_csv(inputs.initial_vault_shares):
        address = norm_address(row["source_address"])
        if address is None:
            raise ValueError("initial-stage vault share without source")
        status = row["destination_status"].strip()
        beneficiary = norm_address(row.get("beneficiary_address"))
        if status not in ("ready", "hold"):
            raise ValueError(f"invalid initial vault-share destination status {status!r}")
        if status == "ready" and beneficiary is None:
            raise ValueError("ready initial vault share is missing its beneficiary")
        amount = parse_int(row["amount_atto"], "initial vault share")
        initial_shares[address] += amount
        initial_share_rows += 1
        initial_share_total += amount
    initial_vault_assets: dict[str, int] = {}
    initial_vault_total = 0
    for row in read_csv(inputs.initial_validator_vaults):
        validator = norm_address(row["validator_address"])
        if validator is None or validator in initial_vault_assets:
            raise ValueError("invalid or duplicate initial-stage validator vault")
        governor_status = row["governor_status"].strip()
        governor = norm_address(row.get("governor_address"))
        if governor_status not in ("ready", "hold"):
            raise ValueError(f"invalid initial governor status {governor_status!r}")
        if governor_status == "ready" and governor is None:
            raise ValueError("ready initial vault is missing its governor")
        initial_vault_assets[validator] = parse_int(
            row["initial_assets_atto"], "initial validator assets"
        )
        initial_vault_total += initial_vault_assets[validator]
    initial_stage_addresses = {
        address
        for address, policy in stage_policy.items()
        if policy["stage"] == "initial" and address not in exchange_routes
    }
    if set(initial_wallets) != initial_stage_addresses:
        raise ValueError("initial wallet materialization does not match stage policy")
    for address in initial_stage_addresses:
        policy = stage_policy[address]
        if initial_wallets[address] != int(policy["wallet"]):
            raise ValueError(f"initial wallet amount mismatch for {address}")
        if initial_shares.get(address, 0) != int(policy["staked"]):
            raise ValueError(f"initial vault-share amount mismatch for {address}")
    if len(initial_wallets) != int(initial_summary["source_addresses"]):
        raise ValueError("initial wallet count does not match initial-stage summary")
    if initial_wallet_total != int(initial_summary["wallet_allocation_atto"]):
        raise ValueError("initial wallet total does not match initial-stage summary")
    if initial_share_rows != int(initial_summary["vault_share_rows"]):
        raise ValueError("initial vault-share count does not match summary")
    if initial_share_total != int(initial_summary["vault_share_allocation_atto"]):
        raise ValueError("initial vault-share total does not match summary")
    if len(initial_vault_assets) != int(initial_summary["validator_vaults"]):
        raise ValueError("initial validator-vault count does not match summary")
    if initial_vault_total != initial_share_total:
        raise ValueError("initial validator assets do not equal initial vault shares")
    initial_unresolved_rows = sum(1 for _ in read_csv(inputs.initial_unresolved))
    if initial_unresolved_rows != int(initial_summary["unresolved_rows"]):
        raise ValueError("initial unresolved count does not match summary")
    log(
        f"initial-stage materialization: wallets={len(initial_wallets)} "
        f"vault_shares={initial_share_rows} "
        f"validator_vaults={len(initial_vault_assets)}"
    )

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
            if status not in DESTINATION_STATUSES:
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
    if exchange_policy.get("schema_version") != 2:
        raise ValueError("exchange policy schema_version must be 2 (manual reserve delivery)")
    exchange_wallets: list[tuple] = []
    exchange_addresses: set[str] = set()
    for exchange in exchange_policy.get("exchanges", []):
        exchange_id = exchange["id"].strip()
        display_name = exchange["display_name"].strip()
        delivery_policy = exchange["delivery_policy"].strip()
        if delivery_policy != "manual_from_reserve":
            raise ValueError(f"exchange {exchange_id}: unsupported delivery_policy {delivery_policy!r}")
        destination_mode = exchange["destination_mode"].strip()
        if destination_mode not in EXCHANGE_DESTINATION_MODES:
            raise ValueError(f"exchange {exchange_id}: unknown destination_mode {destination_mode!r}")
        audit_path = inputs.exchange_audits / f"{exchange_id}.csv"
        for row in read_csv(audit_path):
            address = norm_address(row.get("address_hex"))
            if address is None:
                raise ValueError(f"{audit_path}: exchange row without address_hex")
            if address in exchange_addresses:
                raise ValueError(f"exchange wallet {address} listed more than once")
            exchange_addresses.add(address)
            if (row.get("destination_mode") or "").strip() != destination_mode:
                raise ValueError(f"{audit_path}: destination_mode disagrees with policy for {address}")
            planned_status = (row.get("planned_delivery_status") or "").strip()
            audit_stage = opt(row.get("migration_stage"))
            audit_issuance = (row.get("issuance_treatment") or "").strip()
            if audit_issuance != "manual_from_reserve":
                raise ValueError(f"{audit_path}: unexpected issuance_treatment for {address}")
            tier = (row.get("delivery_tier") or "").strip()
            wallet_destination = norm_address(row.get("planned_wallet_destination"))
            staking_destination = norm_address(row.get("planned_staking_destination"))
            routed = exchange_routes.get(address)
            if planned_status in EXCHANGE_DELIVERY_STATUSES:
                if audit_stage != "exchange_manual":
                    raise ValueError(f"{audit_path}: planned delivery without exchange_manual stage for {address}")
                if routed is None:
                    raise ValueError(f"{audit_path}: planned delivery has no compiled route for {address}")
                planned = (
                    parse_int(row["planned_wallet_airdrop_atto"], "planned wallet"),
                    parse_int(row["planned_staked_to_vault_atto"], "planned staked"),
                )
                if planned != tuple(routed):
                    raise ValueError(f"{audit_path}: planned amounts disagree with compiled routes for {address}")
                route_destinations = exchange_route_destinations.get(address, set())
                if not route_destinations <= {wallet_destination, staking_destination}:
                    raise ValueError(f"{audit_path}: compiled route destination not planned for {address}")
                if tier in ("same_address", "same_address_initial") and route_destinations - {address}:
                    raise ValueError(f"{audit_path}: same-address tier routed elsewhere for {address}")
                if destination_mode == "tiered":
                    ordinary_initial = (stage_policy.get(address) or {}).get("stage") == "initial"
                    if (tier == "same_address_initial") != ordinary_initial:
                        raise ValueError(f"{audit_path}: tier disagrees with ordinary stage for {address}")
            else:
                if routed is not None:
                    raise ValueError(f"{audit_path}: compiled route for a row without planned delivery {address}")
                if audit_stage is not None:
                    raise ValueError(f"{audit_path}: stage assigned without planned delivery for {address}")
            exchange_wallets.append(
                (
                    exchange_id,
                    display_name,
                    address,
                    delivery_policy,
                    (row.get("qualification_status") or "unknown").strip(),
                    audit_stage,
                    audit_issuance,
                    planned_status or "unknown",
                    norm_address(row.get("configured_destination")),
                    (row.get("configured_destination_status") or "hold").strip(),
                    destination_mode,
                    tier or None,
                    wallet_destination,
                    staking_destination,
                )
            )
    unlisted = set(exchange_routes) - exchange_addresses
    if unlisted:
        raise ValueError(f"{len(unlisted)} exchange manual-delivery routes have no exchange inventory row")
    log(f"exchange wallets: {len(exchange_wallets)}")

    governors: dict[str, tuple[str | None, str]] = {}
    for row in read_csv(inputs.governor_exceptions):
        v = norm_address(row["validator_address"])
        if v:
            governors[v] = (opt(row.get("destination_id")), row["destination_status"].strip())

    # --- vaults and delegations --------------------------------------------------
    stage_columns = VAULT_COLUMNS[VAULT_COLUMNS.index("initial_assets_atto"):]
    vault_stage_data: dict[str, tuple[int, ...]] = {}
    vault_base_assets: dict[str, int] = {}
    for row in read_csv(inputs.vault_stages):
        validator = norm_address(row["validator_address"])
        if validator is None:
            raise ValueError("validator-vault stage row without address")
        if validator in vault_stage_data:
            raise ValueError(f"duplicate validator-vault stage row {validator}")
        values = tuple(parse_int(row[column], column) for column in stage_columns)
        stage = dict(zip(stage_columns, values))
        base = parse_int(row["base_vault_assets_atto"], "base vault assets")
        if (
            stage["post_policy_assets_atto"]
            != base - stage["not_issued_assets_atto"] - stage["exchange_manual_assets_atto"]
        ):
            raise ValueError(f"validator-vault stage partition does not close for {validator}")
        if stage["exchange_manual_assets_atto"] != exchange_vault_assets.get(validator, 0):
            raise ValueError(f"exchange vault release disagrees with compiled routes for {validator}")
        vault_stage_data[validator] = values
        vault_base_assets[validator] = base
    if set(exchange_vault_assets) - set(vault_stage_data):
        raise ValueError("exchange vault routes reference validators without a stage partition")
    vaults: list[list] = []
    vault_addresses: set[str] = set()
    for row in read_csv(inputs.vault_deposits):
        v = norm_address(row["validator_address"])
        assert v is not None
        stage_values = vault_stage_data.get(v)
        if stage_values is None:
            raise ValueError(f"validator vault {v} missing stage partition")
        if initial_vault_assets.get(v, 0) != stage_values[0]:
            raise ValueError(f"initial validator-vault assets mismatch for {v}")
        vault_assets = parse_int(row["vault_assets_atto"], "vault assets")
        if vault_assets != vault_base_assets[v]:
            raise ValueError(f"vault deposit assets disagree with the stage partition for {v}")
        gov = governors.get(v, (None, "ready"))
        vaults.append(
            [
                v,
                vault_assets,
                parse_int(row["priority_staked_to_vault_atto"], "priority staked"),
                parse_int(row["deferred_staked_to_vault_atto"], "deferred staked"),
                parse_int(row["delegation_rows"], "delegation rows"),
                gov[0],
                gov[1],
                None,
                *stage_values,
            ]
        )
        vault_addresses.add(v)
    if len(vault_stage_data) != len(vaults):
        raise ValueError("validator-vault stage partition contains unknown or missing vaults")
    if {
        validator for validator, values in vault_stage_data.items() if values[0] > 0
    } != set(initial_vault_assets):
        raise ValueError("initial validator-vault materialization set mismatch")

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
            meets = amounts["qualification_total_atto"] >= threshold
            stage_record = stage_policy.get(address) if address is not None else None
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
                if stage_record and stage_record["issuance"] == "not_issued":
                    treatment = "contract_not_issued"
            elif code_bearing:
                category = "contract"
                primary = "unreviewed-code-bearing"
            else:
                category = "ordinary_eoa"
            categorized_as_priority = policy_category in ("automatic", "contract_review", "excluded")
            if limit is None and resolved and meets != categorized_as_priority:
                raise ValueError(
                    f"row {n}: threshold/category mismatch for {address}: "
                    f"meets={meets} policy={policy_category}"
                )
            if limit is None and resolved and meets != (stage_record is not None):
                raise ValueError(
                    f"row {n}: threshold/stage-policy mismatch for {address}: "
                    f"meets={meets} stage_policy={stage_record is not None}"
                )
            if stage_record:
                stage_wallet = int(stage_record["wallet"])
                stage_staked = int(stage_record["staked"])
                stage_total = int(stage_record["total"])
                if stage_wallet + stage_staked != stage_total:
                    raise ValueError(f"stage wallet + staked != total for {address}")
                expected_wallet = amounts["wallet_airdrop_atto"] - terminal_component_sums.get(
                    (address, "wallet_airdrop"), 0
                )
                expected_staked = amounts["staked_to_vault_atto"] - terminal_component_sums.get(
                    (address, "vault_shares"), 0
                )
                expected_wallet = max(expected_wallet, 0)
                expected_staked = max(expected_staked, 0)
                if limit is None and (
                    expected_wallet != stage_wallet or expected_staked != stage_staked
                ):
                    raise ValueError(
                        f"compiled terminal component deductions != stage allocation for {address}"
                    )
                migration_stage = stage_record["stage"]
                issuance_treatment = stage_record["issuance"]
                stage_reason = stage_record["reason"]
            else:
                stage_wallet = stage_staked = stage_total = 0
                migration_stage = "below_threshold" if not meets else None
                issuance_treatment = "issue"
                stage_reason = (
                    "below the snapshot qualification threshold" if not meets else ""
                )
            exchange_amounts = exchange_routes.get(address) if address is not None else None
            if exchange_amounts is not None:
                routed_wallet, routed_staked = exchange_amounts
                remaining_wallet = amounts["wallet_airdrop_atto"] - terminal_component_sums.get(
                    (address, "wallet_airdrop"), 0
                )
                remaining_staked = amounts["staked_to_vault_atto"] - terminal_component_sums.get(
                    (address, "vault_shares"), 0
                )
                if limit is None and (
                    routed_wallet != remaining_wallet or routed_staked != remaining_staked
                ):
                    raise ValueError(
                        f"exchange routes do not cover the remaining entitlement for {address}"
                    )
                stage_wallet, stage_staked = routed_wallet, routed_staked
                stage_total = routed_wallet + routed_staked
                migration_stage = "exchange_manual"
                issuance_treatment = "manual_from_reserve"
                stage_reason = EXCHANGE_STAGE_REASON
            counts[category] += 1
            counts[f"policy_{policy_category}"] += 1
            counts[f"stage_{migration_stage or 'none'}"] += 1
            counts[f"issuance_{issuance_treatment}"] += 1
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
                stage_record is not None,
                migration_stage,
                issuance_treatment,
                stage_reason,
                stage_wallet,
                stage_staked,
                stage_total,
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
    bundle_id = hashlib.sha256(
        json.dumps(input_hashes, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    meta = {
        "cutoff": manifest["cutoff"],
        "valuation": manifest.get("valuation", {}),
        "threshold_atto": str(threshold),
        "eligibility": {
            **manifest["eligibility_1000_one"],
            "field": "qualification_total_atto",
        },
        "data_version": data_version,
        "provenance": {
            "bundle_sha256": bundle_id,
            "harmony_migration_commit": git_head(inputs.repo),
            "harmony_supply_audit_commit": git_head(
                inputs.repo.parent / "harmony-supply-audit"
            ),
        },
        "migration_policy": {
            "status": stage_summary.get("status"),
            "initial_window": stage_summary.get("initial_window"),
            "stage_rows": stage_summary.get("stage_rows"),
            "issuance_treatment_rows": stage_summary.get("issuance_treatment_rows"),
            "source": str(inputs.stage_policy.relative_to(inputs.repo)),
        },
        "initial_stage": {
            "status": initial_summary.get("status"),
            "source_addresses": initial_summary.get("source_addresses"),
            "wallet_rows": initial_summary.get("wallet_rows"),
            "vault_share_rows": initial_summary.get("vault_share_rows"),
            "validator_vaults": initial_summary.get("validator_vaults"),
            "unresolved_rows": initial_summary.get("unresolved_rows"),
        },
        "routing": {
            "status": routing_summary.get("status"),
            "initial_stage_status": routing_summary.get("initial_stage_status"),
            "stage_readiness": routing_summary.get("stage_readiness", {}),
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
FIX_GATE_WALLET = "0x" + "aa" * 20
FIX_BYBIT_WALLET = "0x" + "cc" * 20
FIX_MEXC_NO_CLAIM = "0x" + "55" * 20
FIX_GATE_DESTINATION = "0x" + "bb" * 20
FIX_OKX_DESTINATION = "0x" + "dd" * 20
FIX_MEXC_DESTINATION = "0x" + "ee" * 20


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
        migration_stage=None,
        issuance_treatment="issue",
        stage_reason="",
        migration_wallet=None,
        migration_staked=None,
        migration_total=None,
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
        stage_policy_applied = meets
        if issuance_treatment == "manual_from_reserve":
            migration_stage = "exchange_manual"
            stage_reason = EXCHANGE_STAGE_REASON
            migration_wallet = wallet if migration_wallet is None else migration_wallet
            migration_staked = staked if migration_staked is None else migration_staked
            migration_total = migration_wallet + migration_staked
        elif not meets:
            migration_stage = "below_threshold"
            stage_reason = stage_reason or "below the snapshot qualification threshold"
            migration_wallet = migration_staked = migration_total = 0
        elif issuance_treatment == "not_issued":
            migration_stage = None
            migration_wallet = migration_staked = migration_total = 0
            treatment = treatment or ("contract_not_issued" if category == "contract" else None)
        else:
            migration_stage = migration_stage or (
                "next_stage" if category == "contract" else "initial"
            )
            migration_wallet = wallet if migration_wallet is None else migration_wallet
            migration_staked = staked if migration_staked is None else migration_staked
            migration_total = (
                migration_wallet + migration_staked
                if migration_total is None
                else migration_total
            )
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
            stage_policy_applied,
            migration_stage,
            issuance_treatment,
            stage_reason,
            migration_wallet,
            migration_staked,
            migration_total,
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
        acct(excl, "excluded", liquid0=1000 * ONE, staked=4000 * ONE,
             issuance_treatment="not_issued"),
        acct(partial, "ordinary_eoa", liquid0=8000 * ONE, staked=2000 * ONE,
             migration_wallet=3000 * ONE, migration_staked=2000 * ONE,
             migration_total=5000 * ONE),
        acct(safe, "contract", liquid0=50_000 * ONE, code_bearing=True, primary="multisig-wallet",
             subcategory="gnosis-safe", identity="2-of-3 fixture Safe",
             treatment="multisig_next_stage", migration_stage="next_stage"),
        acct(wone, "contract", liquid0=1_000_000 * ONE, code_bearing=True,
             primary="erc20-token", issuance_treatment="not_issued",
             treatment="contract_not_issued"),
        acct(deferred, "ordinary_eoa", liquid0=500 * ONE),
        acct(deleg, "ordinary_eoa", liquid0=100 * ONE, staked=1500 * ONE,
             issuance_treatment="manual_from_reserve"),
        acct(FIX_GATE_WALLET, "ordinary_eoa", liquid0=2500 * ONE,
             issuance_treatment="manual_from_reserve"),
        acct(FIX_BYBIT_WALLET, "ordinary_eoa", liquid0=50_000 * ONE, activity=activity,
             issuance_treatment="manual_from_reserve"),
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
        [v1, 17_005 * ONE, 17_000 * ONE, 5 * ONE, 5, None, "ready", None,
         14_000 * ONE, 0, 0, 5 * ONE, 0, 0, 3_000 * ONE, 14_005 * ONE],
        [v2, 22_500 * ONE, 22_500 * ONE, 0, 3, None, "hold", None,
         20_000 * ONE, 1_500 * ONE, 0, 0, 0, 0, 1_000 * ONE, 20_000 * ONE],
    ]
    destinations = [
        ("not-issuing", None, "not_issuing", "terminal non-issuance"),
        ("wone-holder-redistribution", None, "redistributed", "terminal source offset"),
        ("contract-recovery-custody", None, "hold", "segregated recovery custody, address pending"),
        ("treasury", None, "hold", ""),
        ("exchange-okx", FIX_OKX_DESTINATION, "exchange_manual", "synthetic exchange destination"),
        ("exchange-gate", FIX_GATE_DESTINATION, "exchange_manual", "synthetic exchange destination"),
        ("exchange-mexc", FIX_MEXC_DESTINATION, "exchange_manual", "synthetic exchange destination"),
    ]
    vw = "verified validator wrapper same-address"
    ev = "artifacts/contract-review-20260911/out/validator-policy-accounts.csv"
    exceptions = [
        # validator wrappers: same-address, ready
        ("wallet_airdrop", v1, "validator_account", "initial", "issue", None, 300 * ONE, "validator_wrapper_same_address",
         "default-v1", 1_000_000, None, v1, "ready", vw, ev),
        ("vault_shares", v1, "validator_account", "initial", "issue", v1, 10_000 * ONE, "validator_wrapper_same_address",
         "default-v1", 1_000_000, None, v1, "ready", vw, ev),
        ("wallet_airdrop", v2, "validator_account", "initial", "issue", None, 100 * ONE, "validator_wrapper_same_address",
         "default-v2", 1_000_000, None, v2, "ready", vw, ev),
        ("vault_shares", v2, "validator_account", "initial", "issue", v2, 20_000 * ONE, "validator_wrapper_same_address",
         "default-v2", 1_000_000, None, v2, "ready", vw, ev),
        # excluded: everything not issued (wallet first, then pro-rata vault)
        ("wallet_airdrop", excl, "excluded", None, "not_issued", None, 1000 * ONE, "explicit_route",
         "not-issuing-fixture-excl", 100, "not-issuing", None, "not_issuing",
         "not_issuing_blacklisted_extra_mint_recipient", "fixture incident report"),
        ("vault_shares", excl, "excluded", None, "not_issued", v1, 3000 * ONE, "explicit_route",
         "not-issuing-fixture-excl", 100, "not-issuing", None, "not_issuing",
         "not_issuing_blacklisted_extra_mint_recipient", "fixture incident report"),
        ("vault_shares", excl, "excluded", None, "not_issued", v2, 1000 * ONE, "explicit_route",
         "not-issuing-fixture-excl", 100, "not-issuing", None, "not_issuing",
         "not_issuing_blacklisted_extra_mint_recipient", "fixture incident report"),
        # ordinary EOA with a partial not-issuing deduction on the wallet only
        ("wallet_airdrop", partial, "ordinary_eoa", "initial", "not_issued", None, 5000 * ONE, "explicit_route",
         "not-issuing-fixture-partial", 100, "not-issuing", None, "not_issuing",
         "not_issuing_blacklisted_extra_mint_recipient", "fixture incident report"),
        # Safe multisig: hold pending replacement Safe
        ("wallet_airdrop", safe, "contract_review", "next_stage", "issue", None, 50_000 * ONE, "contract_review_hold",
         "default-safe", 1_000_000, None, None, "hold", "contract_review", ""),
        # WONE-like reserve: holder offset + contract-policy non-issuance.
        ("wallet_airdrop", wone, "contract_review", None, "redistributed", None, 900_000 * ONE, "explicit_route",
         "wone-priority-holder-redistribution", 400, "wone-holder-redistribution", None,
         "redistributed", "wone_priority_holder_redistribution", "fixture WONE accounting"),
        ("wallet_airdrop", wone, "contract_review", None, "not_issued", None, 100_000 * ONE, "explicit_route",
         "wone-reserve-remainder-not-issued", 401, "not-issuing", None, "not_issuing",
         "wone_reserve_remainder_retained_not_issued", "fixture WONE accounting"),
        # deferred account with an explicit partial route and a deferred hold remainder
        ("wallet_airdrop", deferred, "deferred", "manual_review", "not_issued", None, 200 * ONE, "explicit_route",
         "not-issuing-fixture-deferred", 100, "not-issuing", None, "not_issuing",
         "not_issuing_reported_wallet_theft_perpetrator", "fixture theft report"),
        ("wallet_airdrop", deferred, "deferred", "manual_review", "issue", None, 300 * ONE, "deferred_hold",
         "default-deferred", 1_000_000, None, None, "hold", "deferred", ""),
        # exchange wallets: excluded from the airdrop, delivered by hand from the 2050 reserve
        ("wallet_airdrop", deleg, "exchange_manual", "exchange_manual", "manual_from_reserve", None, 100 * ONE,
         "explicit_route", "exchange-okx-fixture", 300, "exchange-okx", FIX_OKX_DESTINATION,
         "exchange_manual", EXCHANGE_ROUTE_REASON, "fixture exchange inventory"),
        ("vault_shares", deleg, "exchange_manual", "exchange_manual", "manual_from_reserve", v2, 1500 * ONE,
         "explicit_route", "exchange-okx-fixture", 300, "exchange-okx", FIX_OKX_DESTINATION,
         "exchange_manual", EXCHANGE_ROUTE_REASON, "fixture exchange inventory"),
        ("wallet_airdrop", FIX_GATE_WALLET, "exchange_manual", "exchange_manual", "manual_from_reserve", None,
         2500 * ONE, "explicit_route", "exchange-gate-fixture", 300, "exchange-gate", FIX_GATE_DESTINATION,
         "exchange_manual", EXCHANGE_ROUTE_REASON, "fixture exchange inventory"),
        ("wallet_airdrop", FIX_BYBIT_WALLET, "exchange_manual", "exchange_manual", "manual_from_reserve", None,
         50_000 * ONE, "explicit_route", "exchange-bybit-fixture", 300, None, FIX_BYBIT_WALLET,
         "exchange_manual", EXCHANGE_ROUTE_REASON, "fixture exchange inventory"),
    ]

    def exchange_row(exchange_id, display_name, address, qualification, planned, mode, tier,
                     configured, configured_status, wallet_destination, staking_destination):
        return (
            exchange_id, display_name, address, "manual_from_reserve", qualification,
            "exchange_manual" if planned == "exchange_manual" else None, "manual_from_reserve",
            planned, configured, configured_status, mode, tier, wallet_destination, staking_destination,
        )

    exchange_wallets = [
        exchange_row("okx", "OKX", deleg, "qualified", "exchange_manual", "aggregate", "aggregate",
                     FIX_OKX_DESTINATION, "configured", FIX_OKX_DESTINATION, FIX_OKX_DESTINATION),
        exchange_row("gate", "Gate", FIX_GATE_WALLET, "qualified", "exchange_manual", "tiered",
                     "aggregated_non_initial", FIX_GATE_DESTINATION, "configured",
                     FIX_GATE_DESTINATION, FIX_GATE_DESTINATION),
        exchange_row("bybit", "Bybit", FIX_BYBIT_WALLET, "qualified", "exchange_manual", "same_address",
                     "same_address", None, "same_address", FIX_BYBIT_WALLET, FIX_BYBIT_WALLET),
        exchange_row("mexc", "MEXC", FIX_MEXC_NO_CLAIM, "below_threshold", "no_cutoff_claim", "aggregate",
                     "aggregate", FIX_MEXC_DESTINATION, "configured", FIX_MEXC_DESTINATION,
                     FIX_MEXC_DESTINATION),
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
            cur.execute(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name='accounts' "
                "AND column_name='migration_stage'"
            )
            if cur.fetchone() is None:
                sys.exit("error: migration-stage schema not applied; run db/migrations/003_migration_stages.sql")
            cur.execute(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name='validator_vaults' "
                "AND column_name='exchange_manual_assets_atto'"
            )
            if cur.fetchone() is None:
                sys.exit(
                    "error: exchange manual-delivery schema not applied; "
                    "run db/migrations/007_exchange_manual_delivery.sql"
                )
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
    p.add_argument(
        "--allow-held-routing",
        action="store_true",
        help="load real data while routing release gates are on hold; the portal shows those statuses",
    )
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

    if not args.dry_run and not args.fixture:
        routing = ds.meta.get("routing", {})
        initial_stage = ds.meta.get("initial_stage", {})
        blockers = []
        if routing.get("status") != "ready":
            blockers.append(f"global routing status={routing.get('status')!r}")
        if routing.get("initial_stage_status") != "ready":
            blockers.append(
                f"routing initial-stage status={routing.get('initial_stage_status')!r}"
            )
        if initial_stage.get("status") != "ready":
            blockers.append(
                f"materialized initial-stage status={initial_stage.get('status')!r}"
            )
        if blockers and not args.allow_held_routing:
            sys.exit(
                "error: refusing real database load while release gates are not ready:\n  "
                + "\n  ".join(blockers)
                + "\n(pass --allow-held-routing to load a preview that shows these statuses)"
            )
        for blocker in blockers:
            log(f"warning: loading preview while {blocker}")

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
        "migration_stages": {
            k.removeprefix("stage_"): v
            for k, v in stats.items()
            if k.startswith("stage_")
        },
        "issuance_treatments": {
            k.removeprefix("issuance_"): v
            for k, v in stats.items()
            if k.startswith("issuance_")
        },
        "meets_threshold": stats.get("meets_threshold"),
        "warnings": ds.warnings,
        "elapsed_seconds": round(time.monotonic() - t0, 1),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
