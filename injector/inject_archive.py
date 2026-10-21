#!/usr/bin/env python3
"""Load a harmony-migration transaction archive into the claim portal DB (/history).

The archive is the output directory of harmony-migration's `make tx-archive`
(docs/tx-archive.md): transactions.csv, internal_transfers.csv, cross_shard.csv,
staking.csv and manifest.json. Every file must match the SHA-256 and row count
in the manifest. Records are merged into public.archive_records in
chronological order (id 1 is the oldest) through an archive_staging schema
swap, so the API never sees a partial archive and the claim tables are not
touched.

Python 3.12+, psycopg 3.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Iterable

csv.field_size_limit(1 << 24)

DEFAULT_DSN = "postgres://claimapi@localhost:5433/claims"
STAGING = "archive_staging"
DATA_TABLES = ("archive_meta", "archive_records", "archive_methods")
FILES = ("transactions.csv", "internal_transfers.csv", "cross_shard.csv", "staking.csv")
COLUMNS = (
    "id", "record_type", "kind", "shard", "to_shard", "rolled_back", "block_number", "block_hash",
    "block_time", "tx_index", "trace_address", "tx_hash", "eth_hash", "from_addr", "to_addr",
    "value_atto", "fee_atto", "status", "method", "ancestor_reverted", "dest_status",
    "dest_block_number", "dest_block_hash", "dest_time", "input",
)
METHOD_COLUMNS = ("selector", "signature", "verified", "candidates", "source")
TYPE_ORDER = {"transaction": 0, "cross_shard": 1, "internal": 2, "staking": 3}
KINDS = {
    "transaction": {"transfer", "call", "create", "xshard_native", "xshard_precompile"},
    "internal": {"call", "callcode", "create", "selfdestruct"},
    "staking": {"Delegate", "Undelegate", "CreateValidator", "CollectRewards"},
}
CROSS_SHARD_MECHANISMS = ("native", "precompile")
DEST_STATUSES = {"credited", "not_found", "mismatch", "unmapped"}


class ArchiveError(ValueError):
    pass


def log(msg: str) -> None:
    print(f"[inject-archive] {msg}", file=sys.stderr, flush=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def raw(value: str, size: int, what: str, optional: bool = False) -> bytes | None:
    if value in ("", None):
        if optional:
            return None
        raise ArchiveError(f"missing {what}")
    if not value.startswith("0x") or len(value) != 2 + 2 * size:
        raise ArchiveError(f"bad {what}: {value!r}")
    try:
        return bytes.fromhex(value[2:])
    except ValueError as error:
        raise ArchiveError(f"bad {what}: {value!r}") from error


def method_bytes(value: str) -> bytes | None:
    """The first (up to) 4 bytes of calldata; shorter when the calldata itself is shorter."""
    if value in ("", None):
        return None
    if not value.startswith("0x") or len(value) % 2 or not 4 <= len(value) <= 10:
        raise ArchiveError(f"bad method: {value!r}")
    try:
        return bytes.fromhex(value[2:])
    except ValueError as error:
        raise ArchiveError(f"bad method: {value!r}") from error


def calldata_bytes(value: str | None, method: str) -> bytes | None:
    """Full calldata; it must begin with the recorded selector."""
    if value in ("", None):
        if method:
            raise ArchiveError(f"selector {method} without calldata")
        return None
    if not value.startswith("0x") or len(value) % 2 or not value.startswith(method):
        raise ArchiveError(f"bad calldata starting {value[:12]!r} for selector {method!r}")
    try:
        return bytes.fromhex(value[2:])
    except ValueError as error:
        raise ArchiveError(f"bad calldata starting {value[:12]!r}") from error


def utc(seconds: str | int | None) -> dt.datetime | None:
    if seconds in ("", None):
        return None
    return dt.datetime.fromtimestamp(int(seconds), dt.timezone.utc)


def flag(value: str, what: str) -> int:
    if value not in ("0", "1"):
        raise ArchiveError(f"bad {what}: {value!r}")
    return int(value)


def trace_key(trace: str | None) -> tuple[int, ...]:
    return tuple(int(part) for part in trace.split(".")) if trace else ()


def branch_flag(value: str) -> bool:
    if value not in ("canonical", "rolled_back"):
        raise ArchiveError(f"bad branch {value!r}")
    return value == "rolled_back"


def read_rows(path: Path) -> Iterable[dict[str, str]]:
    with open(path, newline="", encoding="utf-8") as source:
        yield from csv.DictReader(source)


def record(record_type: str, kind: str, shard: int, to_shard: int | None, rolled_back: bool, row: dict[str, str],
           tx_hash: bytes, eth_hash: bytes | None, from_addr: bytes, to_addr: bytes | None, value: int,
           fee: int | None, status: int, method: bytes | None = None, trace: str | None = None,
           ancestor_reverted: bool | None = None, dest: tuple = (None, None, None, None),
           input_data: bytes | None = None) -> tuple:
    block_number = int(row["block_number"])
    tx_index = int(row["tx_index"])
    key = (int(row["timestamp"]), shard, block_number, tx_index, TYPE_ORDER[record_type], trace_key(trace))
    values = (record_type, kind, shard, to_shard, rolled_back, block_number, raw(row["block_hash"], 32, "block hash"),
              utc(row["timestamp"]), tx_index, trace, tx_hash, eth_hash, from_addr, to_addr, value, fee, status,
              method, ancestor_reverted, *dest, input_data)
    return key, values


def read_archive(directory: Path) -> tuple[list[tuple], dict]:
    manifest_path = directory / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("kind") != "harmony-transaction-archive" or manifest.get("schema_version") != 1:
        raise ArchiveError("not a schema-1 harmony-transaction-archive manifest")
    for name in FILES:
        expected = manifest["files"][name]
        if sha256_file(directory / name) != expected["sha256"]:
            raise ArchiveError(f"{name}: SHA-256 differs from manifest.json")
    minimum = int(manifest["min_value_atto"])
    records: list[tuple] = []
    counts = {name: 0 for name in FILES}

    def check_value(value: int, name: str) -> int:
        if value < minimum:
            raise ArchiveError(f"{name}: value {value} below the archive minimum")
        return value

    xshard_hashes = {(r["from_shard"], r["branch"], r["tx_hash"]) for r in read_rows(directory / "cross_shard.csv")}
    eth_hashes: dict[tuple, bytes | None] = {}

    for row in read_rows(directory / "transactions.csv"):
        counts["transactions.csv"] += 1
        if row["kind"] not in KINDS["transaction"]:
            raise ArchiveError(f"transactions.csv: unknown kind {row['kind']!r}")
        shard, rolled_back = int(row["shard"]), branch_flag(row["branch"])
        eth = raw(row["eth_hash"], 32, "eth hash", optional=True)
        if (row["shard"], row["branch"], row["tx_hash"]) in xshard_hashes:
            eth_hashes[(row["shard"], row["branch"], row["tx_hash"])] = eth
        records.append(record(
            "transaction", row["kind"], shard, int(row["to_shard"]), rolled_back, row,
            raw(row["tx_hash"], 32, "tx hash"), eth, raw(row["from"], 20, "from"),
            raw(row["to"], 20, "to", optional=True), check_value(int(row["value_atto"]), "transactions.csv"),
            int(row["fee_atto"]), flag(row["status"], "status"), method_bytes(row["method"]),
            input_data=calldata_bytes(row["input"], row["method"]) if "input" in row else None))

    for row in read_rows(directory / "internal_transfers.csv"):
        counts["internal_transfers.csv"] += 1
        if row["type"] not in KINDS["internal"]:
            raise ArchiveError(f"internal_transfers.csv: unknown type {row['type']!r}")
        shard = int(row["shard"])
        records.append(record(
            "internal", row["type"], shard, shard, branch_flag(row["branch"]), row,
            raw(row["tx_hash"], 32, "tx hash"), raw(row.get("eth_hash", ""), 32, "eth hash", optional=True),
            raw(row["from"], 20, "from"), raw(row["to"], 20, "to", optional=True),
            check_value(int(row["value_atto"]), "internal_transfers.csv"), None, flag(row["effective"], "effective"),
            trace=row["trace_address"] or None))

    for row in read_rows(directory / "cross_shard.csv"):
        counts["cross_shard.csv"] += 1
        if not row["mechanism"].startswith(CROSS_SHARD_MECHANISMS) or row["dest_status"] not in DEST_STATUSES:
            raise ArchiveError(f"cross_shard.csv: bad mechanism or destination status in {row['tx_hash']}")
        shard = int(row["from_shard"])
        dest_number = int(row["dest_block_number"]) if row["dest_block_number"] else None
        dest = (row["dest_status"], dest_number, raw(row["dest_block_hash"], 32, "dest block hash", optional=True),
                utc(row["dest_timestamp"]))
        records.append(record(
            "cross_shard", row["mechanism"], shard, int(row["to_shard"]), branch_flag(row["branch"]), row,
            raw(row["tx_hash"], 32, "tx hash"),
            raw(row.get("eth_hash", ""), 32, "eth hash", optional=True)
            or eth_hashes.get((row["from_shard"], row["branch"], row["tx_hash"])),
            raw(row["from"], 20, "from"), raw(row["to"], 20, "to"),
            check_value(int(row["value_atto"]), "cross_shard.csv"), None, 1,
            ancestor_reverted=bool(flag(row["ancestor_reverted"], "ancestor_reverted")), dest=dest))

    for row in read_rows(directory / "staking.csv"):
        counts["staking.csv"] += 1
        if row["type"] not in KINDS["staking"]:
            raise ArchiveError(f"staking.csv: unknown type {row['type']!r}")
        shard = int(row["shard"])
        records.append(record(
            "staking", row["type"], shard, shard, branch_flag(row["branch"]), row,
            raw(row["tx_hash"], 32, "tx hash"), None, raw(row["delegator"], 20, "delegator"),
            raw(row["validator"], 20, "validator", optional=True),
            check_value(int(row["amount_atto"]), "staking.csv"), None, flag(row["status"], "status")))

    for name in FILES:
        if counts[name] != manifest["files"][name]["rows"]:
            raise ArchiveError(f"{name}: {counts[name]} rows, manifest says {manifest['files'][name]['rows']}")
    methods = read_methods(directory, manifest["files"].get("method_names.csv"))
    records.sort(key=lambda item: item[0])
    rows = [(index, *values) for index, (_, values) in enumerate(records, 1)]
    by_type: dict[str, int] = {}
    for item in rows:
        by_type[item[1]] = by_type.get(item[1], 0) + 1
    meta = {
        "kind": "harmony-transaction-archive",
        "min_value_atto": str(minimum),
        "coverage": [{
            "shard": run["shard"], "branch": run["branch"], "start_block": run["start"], "end_block": run["end"],
            "start_time_utc": run["boundaries"]["start"]["time_utc"],
            "end_time_utc": run["boundaries"]["end"]["time_utc"],
        } for run in sorted(manifest["runs"], key=lambda r: (r["shard"], r["branch"], r["start"]))],
        "notes": manifest.get("notes", []),
        "row_counts": {"archive_records": len(rows), **by_type, "archive_methods": len(methods)},
        "manifest_sha256": sha256_file(manifest_path),
        "fixture": False,
    }
    return rows, methods, meta


def read_methods(directory: Path, entry: dict | None) -> list[tuple]:
    """Selector -> signature labels from method_names.csv, when the archive has them."""
    if entry is None:
        return []
    path = directory / "method_names.csv"
    if sha256_file(path) != entry["sha256"]:
        raise ArchiveError("method_names.csv: SHA-256 differs from manifest.json")
    methods = []
    for row in read_rows(path):
        selector = method_bytes(row["selector"])
        if selector is None or len(selector) != 4 or not row["signature"]:
            raise ArchiveError(f"method_names.csv: bad row {row}")
        methods.append((selector, row["signature"], flag(row["verified"], "verified") == 1,
                        int(row["candidates"]), row["source"]))
    if len(methods) != entry["rows"]:
        raise ArchiveError("method_names.csv: row count differs from manifest.json")
    return methods


def fixture_archive() -> tuple[list[tuple], list[tuple], dict]:
    """Deterministic synthetic archive on Hardhat development addresses."""
    alice = bytes.fromhex("f39fd6e51aad88f6f4ce6ab8827279cfffb92266")
    bob = bytes.fromhex("70997970c51812dc3a010c7d01b50e0d17dc79c8")
    pool = bytes.fromhex("3c44cdddb6a900fa2b585dd299e03d12fa4293bc")
    one = 10**18

    def h(n: int) -> bytes:
        return n.to_bytes(32, "big")

    base = dt.datetime(2025, 1, 1, tzinfo=dt.timezone.utc)
    specs = [
        ("transaction", "transfer", 0, 0, False, 67492500, 0, None, h(1), h(101), alice, bob, 1500 * one, 21 * 10**14, 1, None, None, (None,) * 4),
        ("transaction", "call", 0, 0, False, 67492600, 0, None, h(2), h(102), alice, pool, 10 * one, 9 * 10**15, 1, bytes.fromhex("7ff36ab5"), None, (None,) * 4),
        ("internal", "call", 0, 0, False, 67492600, 0, "0", h(2), h(102), pool, alice, 12 * one, None, 1, None, None, (None,) * 4),
        ("transaction", "transfer", 0, 0, False, 67492700, 1, None, h(3), h(103), bob, alice, 250 * one, 21 * 10**14, 0, None, None, (None,) * 4),
        ("transaction", "xshard_native", 0, 1, False, 67492800, 0, None, h(4), h(104), alice, alice, 99 * one, 21 * 10**14, 1, None, None, (None,) * 4),
        ("cross_shard", "native", 0, 1, False, 67492800, 0, None, h(4), h(104), alice, alice, 99 * one, None, 1, None, False,
         ("credited", 70074900, h(904), base + dt.timedelta(minutes=6))),
        ("staking", "Delegate", 0, 0, False, 67492900, 0, None, h(5), None, alice, pool, 1000 * one, None, 1, None, None, (None,) * 4),
        ("transaction", "transfer", 0, 0, True, 92730100, 0, None, h(6), h(106), alice, bob, 5000 * one, 21 * 10**14, 1, None, None, (None,) * 4),
        ("transaction", "transfer", 1, 1, False, 70075000, 0, None, h(7), h(107), bob, alice, 42 * one, 21 * 10**14, 1, None, None, (None,) * 4),
    ]
    swap_input = bytes.fromhex("7ff36ab5" + "00" * 31 + "01" + "00" * 31 + "80")
    rows = []
    for index, spec in enumerate(specs, 1):
        (record_type, kind, shard, to_shard, rolled_back, block, tx_index, trace, tx_hash, eth_hash, frm, to,
         value, fee, status, method, ancestor, dest) = spec
        input_data = swap_input if method else None
        rows.append((index, record_type, kind, shard, to_shard, rolled_back, block, h(10_000 + block),
                     base + dt.timedelta(minutes=index), tx_index, trace, tx_hash, eth_hash, frm, to, value, fee,
                     status, method, ancestor, *dest, input_data))
    methods = [(bytes.fromhex("7ff36ab5"), "swapExactETHForTokens(uint256,address[],address,uint256)", True, 2,
                "fixture")]
    by_type: dict[str, int] = {}
    for item in rows:
        by_type[item[1]] = by_type.get(item[1], 0) + 1
    meta = {
        "kind": "harmony-transaction-archive",
        "min_value_atto": str(one),
        "coverage": [
            {"shard": 0, "branch": "canonical", "start_block": 67492436, "end_block": 93624315,
             "start_time_utc": "2025-01-01T00:00:01Z", "end_time_utc": "2026-09-10T14:41:43Z"},
            {"shard": 1, "branch": "canonical", "start_block": 70074850, "end_block": 94978278,
             "start_time_utc": "2025-01-01T00:00:00Z", "end_time_utc": "2026-08-11T23:25:37Z"},
        ],
        "notes": ["Synthetic test data."],
        "row_counts": {"archive_records": len(rows), **by_type, "archive_methods": len(methods)},
        "fixture": True,
    }
    return rows, methods, meta


def load_into_db(rows: list[tuple], methods: list[tuple], meta: dict, dsn: str, data_version: str,
                 started: dt.datetime) -> dict:
    import psycopg

    with psycopg.connect(dsn, autocommit=False) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM information_schema.tables "
                        "WHERE table_schema='public' AND table_name='archive_methods'")
            if cur.fetchone() is None:
                sys.exit("error: archive schema not applied; run db/migrations/009_tx_archive.sql and "
                         "010_tx_archive_calldata.sql")
            cur.execute(f"DROP SCHEMA IF EXISTS {STAGING} CASCADE")
            cur.execute(f"CREATE SCHEMA {STAGING}")
            for table in DATA_TABLES:
                cur.execute(f"CREATE TABLE {STAGING}.{table} (LIKE public.{table} INCLUDING ALL)")
            conn.commit()

            log(f"copying {len(rows)} archive records")
            with cur.copy(f"COPY {STAGING}.archive_records ({', '.join(COLUMNS)}) FROM STDIN") as copy:
                for row in rows:
                    copy.write_row(row)
            with cur.copy(f"COPY {STAGING}.archive_methods ({', '.join(METHOD_COLUMNS)}) FROM STDIN") as copy:
                for method in methods:
                    copy.write_row(method)
            meta = {**meta, "data_version": data_version,
                    "loaded_at": dt.datetime.now(dt.timezone.utc).isoformat()}
            with cur.copy(f"COPY {STAGING}.archive_meta (key, value) FROM STDIN") as copy:
                for key, value in meta.items():
                    copy.write_row((key, json.dumps(value)))
            conn.commit()

            log("swapping archive staging tables into public")
            for table in DATA_TABLES:
                cur.execute(f"DROP TABLE public.{table}")
                cur.execute(f"ALTER TABLE {STAGING}.{table} SET SCHEMA public")
            cur.execute(f"DROP SCHEMA {STAGING}")
            cur.execute(
                "INSERT INTO load_runs (started_at, finished_at, data_version, inputs, row_counts) "
                "VALUES (%s, now(), %s, %s, %s)",
                (started, data_version,
                 json.dumps({"archive": True, "manifest_sha256": meta.get("manifest_sha256"),
                             "fixture": meta.get("fixture", False)}),
                 json.dumps(meta["row_counts"])))
            conn.commit()
        conn.autocommit = True
        with conn.cursor() as cur:
            for table in DATA_TABLES:
                cur.execute(f"VACUUM (ANALYZE) public.{table}")
    return meta["row_counts"]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--archive-dir", help="harmony-migration tx-archive output directory")
    parser.add_argument("--dsn", default=os.environ.get("DATABASE_URL", DEFAULT_DSN))
    parser.add_argument("--data-version", default=f"archive-{dt.date.today().isoformat()}")
    parser.add_argument("--dry-run", action="store_true", help="read and verify only")
    parser.add_argument("--fixture", action="store_true", help="load synthetic records")
    args = parser.parse_args(argv)
    if not args.fixture and not args.archive_dir:
        parser.error("--archive-dir is required unless --fixture")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    started = dt.datetime.now(dt.timezone.utc)
    t0 = time.monotonic()
    if args.fixture:
        rows, methods, meta = fixture_archive()
    else:
        try:
            rows, methods, meta = read_archive(Path(args.archive_dir).expanduser())
        except ArchiveError as error:
            sys.exit(f"error: {error}")
    counts = meta["row_counts"] if args.dry_run else load_into_db(rows, methods, meta, args.dsn, args.data_version,
                                                                  started)
    print(json.dumps({"mode": "dry-run" if args.dry_run else "loaded", "fixture": args.fixture,
                      "data_version": args.data_version, "row_counts": counts, "coverage": meta["coverage"],
                      "notes": meta["notes"], "elapsed_seconds": round(time.monotonic() - t0, 1)}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
