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
# statuses all report ready, or --allow-held-routing is passed for a preview.
PGPASSWORD=... python3 inject_claims.py \
  --migration-repo ~/git/harmony-migration \
  --dsn postgres://claimapi@localhost:5433/claims \
  --data-version 2026-09-17 --validator-names
```

The database must have every migration through
`db/migrations/007_exchange_manual_delivery.sql`; the injector checks for it
before creating the staging schema.

Flags:

- `--migration-repo PATH` root of the harmony-migration checkout (default `~/git/harmony-migration`);
- `--dsn URL` PostgreSQL DSN (default `postgres://claimapi@localhost:5433/claims`, i.e. the IAP tunnel);
- `--data-version TEXT` label recorded in `snapshot_meta` and `load_runs`;
- `--dry-run` parse and verify everything, print the summary, do not connect;
- `--fixture` load a deterministic synthetic data set instead of the real files;
- `--validator-names` enrich `validator_vaults.validator_name` through `hmyv2_getAllValidatorInformation` (`--rpc-url`, default `https://api.harmony.one`);
- `--no-activity` skip the optional last-activity enrichment file;
- `--limit N` only read the first N rows of the all-accounts CSV (development);
- `--allow-held-routing` load real data while routing release gates are on hold.
  The held statuses are recorded in `snapshot_meta` and the site labels its
  results as a preview.

## Checks performed

- `keccak256(address) == secure_key` for every resolved address (hard error);
- `wallet_airdrop + staked_to_vault == total_claim` per row (hard error);
- `native_total_claim + wone_balance == qualification_total` and
  `native_wallet_airdrop + wone_airdrop == wallet_airdrop` (hard errors);
- exception sums per `(source, component)` never exceed the source component
  (hard error);
- only `ready`, `hold`, `exchange_manual`, `not_issuing`, and terminal
  `redistributed` routing statuses are accepted, and each must carry its
  matching issuance treatment (hard error);
- every threshold-qualified row appears exactly once in the stage policy, and
  compiled terminal deductions reconcile to its migration allocation;
- exchange manual-delivery routes (`exchange_manual_reserve_delivery`) cover
  exactly the remaining entitlement of each source; that source's account is
  stored as stage `exchange_manual`, treatment `manual_from_reserve`, with the
  routed amounts as its allocation (hard error);
- every exchange audit row with planned delivery has compiled routes whose
  amounts and destinations match the audit, same-address tiers route to the
  source, Gate's same-address tier equals the ordinary `initial` stage, no
  address is listed by two exchanges, and no route lacks an inventory row
  (hard errors);
- materialized initial-stage wallet, vault-share, and validator-vault amounts
  exactly match the stage policy minus exchange-routed sources and the staged
  vault partition;
- each vault partition closes as
  `post_policy = base - not_issued - exchange_manual`, its base equals the
  deposit file, and its `exchange_manual` assets equal the compiled exchange
  vault routes (hard error);
- delegation sums per delegator equal the account's `staked_to_vault`
  (reported as warnings);
- every referenced validator has a vault row (hard error).

## Embargo

The inputs are under the numerical embargo described in
`harmony-migration/docs/numerical-embargo.md`. The injector prints only counts
to the terminal and writes nothing but the database. Do not paste its output
into tracked files. Loading real data into the public VM is an operator
decision taken after the embargo is lifted; use `--fixture` until then.
