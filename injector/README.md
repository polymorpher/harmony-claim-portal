# Claim injector

`inject_claims.py` reads the WONE-aware cutoff claims, final account-policy
categories, migration-stage policy, materialized initial-stage plan, contract
treatments, exchange audits, staged validator-vault partitions, and sparse
routing exceptions from a local `harmony-migration` checkout and loads them
into the claim portal database.

The load is atomic: every data table is filled in a `claims_staging` schema
with `COPY`, verified, and then swapped into `public` inside one transaction,
so the API never observes partial data.

## Setup

```sh
cd injector
python3 -m venv .venv && . .venv/bin/activate
pip install -e .
```

Requires Python 3.12+, `psycopg[binary]` and `pycryptodome` (Keccak-256 for
the secure-key check).

## Usage

```sh
# validate the real inputs without touching a database
python3 inject_claims.py --migration-repo ~/git/harmony-migration --dry-run

# load synthetic rows into a local dev database
python3 inject_claims.py --fixture --dsn "$(../scripts/dev-postgres.sh url claims)" --data-version fixture-1

# production load through the IAP tunnel (backend/deploy/tunnel-db.sh)
# Refused unless global, routing initial-stage, and materialized initial-stage
# statuses all report ready.
PGPASSWORD=... python3 inject_claims.py \
  --migration-repo ~/git/harmony-migration \
  --dsn postgres://claimapi@localhost:5433/claims \
  --data-version 2026-09-17 --validator-names
```

Flags:

- `--migration-repo PATH` root of the harmony-migration checkout (default `~/git/harmony-migration`);
- `--dsn URL` PostgreSQL DSN (default `postgres://claimapi@localhost:5433/claims`, i.e. the IAP tunnel);
- `--data-version TEXT` label recorded in `snapshot_meta` and `load_runs`;
- `--dry-run` parse and verify everything, print the summary, do not connect;
- `--fixture` load a deterministic synthetic data set instead of the real files;
- `--validator-names` enrich `validator_vaults.validator_name` through `hmyv2_getAllValidatorInformation` (`--rpc-url`, default `https://api.harmony.one`);
- `--no-activity` skip the optional last-activity enrichment file;
- `--limit N` only read the first N rows of the all-accounts CSV (development).

## Checks performed

- `keccak256(address) == secure_key` for every resolved address (hard error);
- `wallet_airdrop + staked_to_vault == total_claim` per row (hard error);
- `native_total_claim + wone_balance == qualification_total` and
  `native_wallet_airdrop + wone_airdrop == wallet_airdrop` (hard errors);
- exception sums per `(source, component)` never exceed the source component
  (hard error);
- only `ready`, `hold`, `not_issuing`, and terminal `redistributed` routing
  statuses are accepted (hard error);
- every threshold-qualified row appears exactly once in the stage policy, and
  compiled terminal deductions reconcile to its migration allocation;
- materialized initial-stage wallet, vault-share, and validator-vault amounts
  exactly match the stage policy and staged vault partition;
- delegation sums per delegator equal the account's `staked_to_vault`
  (reported as warnings);
- every referenced validator has a vault row (hard error).

## Embargo

The inputs are under the numerical embargo described in
`harmony-migration/docs/numerical-embargo.md`. The injector prints only counts
to the terminal and writes nothing but the database. Do not paste its output
into tracked files. Loading real data into the public VM is an operator
decision taken after the embargo is lifted; use `--fixture` until then.
