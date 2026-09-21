#!/usr/bin/env python3
"""Select next-batch confirmation candidates from a migration-stage policy CSV.

Reads the harmony-migration checkout supplied by the operator. Writes only
eligible address rows. Exchange inventories are used as an exclusion set and
are not copied into this repository.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter
from pathlib import Path

REASONS = (
    "wallet activity predates initial window",
    "no indexed wallet activity",
)
CLASSIFICATION = {
    "wallet": "ordinary_eoa",
    "validator_wallet": "validator_account",
}


def normalize_address(value: str) -> str:
    text = (value or "").strip().lower()
    if len(text) != 42 or not text.startswith("0x"):
        raise ValueError(f"address is not 20-byte hex: {value!r}")
    int(text[2:], 16)
    return text


def load_exchange_addresses(repo: Path) -> set[str]:
    policy_path = repo / "exchanges" / "exchange-policy.json"
    audits = repo / "artifacts" / "exchange-accounting-20260917" / "audits"
    if not policy_path.is_file():
        raise SystemExit(f"missing {policy_path}; refusing to load without the exchange exclusion set")
    policy = json.loads(policy_path.read_text())
    exchanges = policy.get("exchanges") or []
    if not exchanges:
        raise SystemExit("exchange policy has no exchanges; refusing to load")
    found: set[str] = set()
    for row in exchanges:
        path = audits / f"{row['id']}.csv"
        if not path.is_file():
            raise SystemExit(f"missing exchange audit {path}; refusing to load")
        with path.open(newline="") as handle:
            reader = csv.DictReader(handle)
            if "address_hex" not in (reader.fieldnames or []):
                raise SystemExit(f"{path} has no address_hex column")
            for item in reader:
                if (item.get("address_hex") or "").strip():
                    found.add(normalize_address(item["address_hex"]))
    if not found:
        raise SystemExit("exchange audits named no addresses; refusing to load")
    return found


def load_exclude_file(path: Path) -> set[str]:
    found: set[str] = set()
    with path.open(newline="") as handle:
        sample = handle.read(4096)
        handle.seek(0)
        if "address_hex" in sample.splitlines()[0] or sample.startswith("address,"):
            reader = csv.DictReader(handle)
            field = "address_hex" if reader.fieldnames and "address_hex" in reader.fieldnames else "address"
            for item in reader:
                if (item.get(field) or "").strip():
                    found.add(normalize_address(item[field]))
        else:
            for line in handle:
                text = line.strip()
                if text and not text.startswith("#"):
                    found.add(normalize_address(text))
    return found


def select_candidates(
    rows: list[dict[str, str]],
    excluded: set[str],
    data_version: str,
    policy_version: str,
    cutoff: str,
) -> tuple[list[dict[str, str]], Counter[str]]:
    for label, value in (("data version", data_version), ("policy version", policy_version), ("cutoff", cutoff)):
        if not value or any(ord(ch) < 32 for ch in value) or len(value) > 80:
            raise SystemExit(f"invalid {label}")
    counts: Counter[str] = Counter()
    chosen: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in rows:
        try:
            address = normalize_address(row.get("address", ""))
        except ValueError:
            counts["invalid_address"] += 1
            continue
        if address in seen:
            raise SystemExit(f"duplicate stage-policy address {address}")
        seen.add(address)
        if address in excluded:
            counts["excluded_exchange"] += 1
            continue
        if (row.get("routing_category") or "").strip() != "automatic_policy":
            counts["excluded_routing"] += 1
            continue
        account = CLASSIFICATION.get((row.get("account_classification") or "").strip())
        if account is None:
            counts["excluded_classification"] += 1
            continue
        if (row.get("migration_stage") or "").strip() != "deferred":
            counts["excluded_stage"] += 1
            continue
        if (row.get("issuance_treatment") or "").strip() != "issue":
            counts["excluded_issuance"] += 1
            continue
        reason = (row.get("stage_reason") or "").strip()
        if reason not in REASONS:
            counts["excluded_reason"] += 1
            continue
        try:
            allocation = int((row.get("migration_allocation_atto") or "0").strip() or "0")
        except ValueError:
            counts["invalid_allocation"] += 1
            continue
        if allocation <= 0:
            counts["excluded_zero_allocation"] += 1
            continue
        counts[f"selected_{reason}"] += 1
        chosen.append({
            "address": address,
            "account_category": account,
            "stage_reason": reason,
            "data_version": data_version,
            "policy_version": policy_version,
            "cutoff_time_utc": cutoff,
        })
    return chosen, counts


def read_stage_policy(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def write_candidates(path: Path, rows: list[dict[str, str]]) -> None:
    fields = ["address", "account_category", "stage_reason", "data_version", "policy_version", "cutoff_time_utc"]
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the confirmation candidate CSV")
    parser.add_argument("--stage-policy", type=Path)
    parser.add_argument("--migration-repo", type=Path)
    parser.add_argument("--exclude-addresses", type=Path)
    parser.add_argument("--data-version", required=True)
    parser.add_argument("--policy-version", required=True)
    parser.add_argument("--cutoff-time", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--allow-empty-excludes", action="store_true")
    args = parser.parse_args()

    stage_path = args.stage_policy
    if args.migration_repo:
        stage_path = stage_path or (
            args.migration_repo / "artifacts" / "migration-policy-20260917" / "migration-stage-policy.csv"
        )
        excluded = load_exchange_addresses(args.migration_repo)
    elif args.exclude_addresses:
        excluded = load_exclude_file(args.exclude_addresses)
    else:
        raise SystemExit("pass --migration-repo or --exclude-addresses")
    if not excluded and not args.allow_empty_excludes:
        raise SystemExit("exclusion set is empty; refusing to load")
    if stage_path is None or not stage_path.is_file():
        raise SystemExit(f"stage policy not found: {stage_path}")

    chosen, counts = select_candidates(
        read_stage_policy(stage_path),
        excluded,
        args.data_version,
        args.policy_version,
        args.cutoff_time,
    )
    write_candidates(args.output, chosen)
    summary = {"candidates": len(chosen), **dict(counts)}
    print(json.dumps(summary, sort_keys=True), file=sys.stderr)


if __name__ == "__main__":
    main()
