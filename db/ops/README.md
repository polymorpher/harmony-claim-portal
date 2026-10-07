# Confirmation operations

These scripts are safe to commit. Database passwords, owner URLs, and claim
exports stay out of the repository: passwords are generated on the host, and
exports go under `data/`, which is gitignored.

The lookup API connects as `claim_read` (select on the public ledger only).
The confirmation API connects as `claim_confirm` (insert evidence in schema
`confirm` only). Migrations and `injector/inject_claims.py` connect as
`claimapi`, the owner. That URL is in `/etc/harmony-claim-migrate.env`, mode
`0600`, owned by root. It is not in the API environment files.

`claim_confirm` cannot update or delete a confirmation. A second signature for
the same address and data version is rejected. Reviews are a separate append
by the owner role. The injector's table swap does not include schema `confirm`.

A stored signature is not migration authorization. `export-confirmations.sh`
writes the evidence for an offline check that recovers every signer and
re-reads the candidate list before a later batch is built.

## One-time and every deploy

`backend/deploy/deploy-backend.sh` applies migrations and then:

```sh
sudo db/ops/setup-roles.sh --vm --db-name claims --domain migrate.country
```

Re-running keeps existing role passwords when their env files are still in
place. The first split copies the original lookup env to
`/etc/harmony-claim-api.env.pre-split` (root-only, mode 600) and rotates the
owner database password, so that old copy can no longer connect. Each deploy
saves env files under `/var/lib/harmony-claim-api/env-backup/<release>/` as
root mode 600, not as a group-readable copy of the API file, and restores them
if the new processes fail their health checks. A restored lookup env that still
contains an owner URL is pointed at the current migrate-env password.

After a split, `/etc/harmony-claim-api.env` has `CLAIM_READ_URL` and no
`DATABASE_URL`. A manual restore of the pre-split world is:

```sh
sudo systemctl disable --now harmony-claim-proxy harmony-claim-confirm
sudo install -m 640 -o root -g claimapi /etc/harmony-claim-api.env.pre-split /etc/harmony-claim-api.env
sudo ln -sfn /opt/harmony-claim-api/releases/<previous-release>/backend /opt/harmony-claim-api/current
sudo systemctl restart harmony-claim-api
```

Local development, after the schema is loaded:

```sh
db/ops/setup-roles.sh --local
```

That writes `backend/.env.read`, `backend/.env.confirm`, and
`backend/.env.owner`. All three are gitignored.

## Load candidates

Candidates are addresses, stage reasons, and versions. They do not include
balances. The exchange exclusion set is read from the harmony-migration
checkout and is not copied into this repo. The load refuses to run if that
set is missing or if no candidates remain.

Set these in `.env` (names only; values are not secret, but they do select
which snapshot the signatures bind to):

```text
CONFIRM_DATA_VERSION=2026-09-17
CONFIRM_POLICY_VERSION=migration-policy-20260917
CONFIRM_CUTOFF_TIME=2026-09-10T14:00:00Z
```

With the owner tunnel open:

```sh
CONFIRM_OWNER_URL="$(backend/deploy/tunnel-db.sh --print-dsn)" \
  db/ops/load-candidates.sh --migration-repo ~/git/harmony-migration
```

`--print-dsn` prints the owner URL. Do not paste it into a ticket or a file
that is committed. Pass it in the environment as above rather than as
`--dsn URL`: a command-line argument, password included, shows in `ps` to
every user of the machine. The scripts themselves never give psql or pg_dump
the password as an argument; `db/ops/pgpass.sh` moves it into a temporary
password file that is removed on exit.

The loader refuses to replace candidates when `CONFIRM_DATA_VERSION` does not
equal `snapshot_meta.data_version` for the ledger that is already loaded.
`--allow-version-mismatch` overrides that check. Use it only when the lookup
page and the confirmation set are supposed to name different versions.

A new data version replaces `confirm.candidates`. Existing signatures stay.
Holders sign again for the new version.

For a local fixture wallet only:

```sh
psql postgres://claimapi@127.0.0.1:5434/claims -f db/ops/fixture-candidates.sql
```

Use the owner URL from `backend/.env.owner`. Do not load the fixture into the
public database.

## Who has confirmed

```sh
db/ops/confirmed-wallets.sh                    # tunnel to the VM, print the report, close the tunnel
db/ops/confirmed-wallets.sh --csv              # also writes data/confirmed-wallets/confirmed-wallets-<UTC timestamp>.csv
db/ops/confirmed-wallets.sh --compact          # one line per confirmation
```

The default needs only `.env` and `gcloud`. It opens the IAP tunnel to the
VM's PostgreSQL, reads the owner database URL from the VM, runs the report,
and closes the tunnel. If `backend/deploy/tunnel-db.sh` is already running,
that tunnel is used and left open. For a local database, or on the VM itself,
skip the tunnel:

```sh
db/ops/confirmed-wallets.sh --no-tunnel --db-url "$(grep '^DATABASE_URL=' backend/.env.owner | cut -d= -f2-)"
db/ops/confirmed-wallets.sh --no-tunnel        # uses CONFIRM_OWNER_URL or DATABASE_URL from .env
```

Prints every recorded signature with the wallet's amounts: the total not in
the initial airdrop, split into the wallet part and vault shares; the balance
components behind it (liquid per shard, pending undelegation, unclaimed
reward, cross-shard, WONE); the vault shares per validator; last activity;
signer; and the full signature. Each record shows its confirmation `id` (the
`#N` before the address is only a row number) and a `review` line: the
approval decision, whether the wallet part was sent and by which run, and how
many vault positions were sent or are blocked. The header carries the report
time (UTC and local), the database host without its password, and the loaded
ledger and candidate versions. The summary counts by reason, category, version
and decision, totals the wallet part and vault shares pending, sent and
blocked, flags wallets that signed under a superseded candidate set or whose
signer differs from the address, and gives the confirmed allocation as a share
of the candidate set.

**Blocked** means a batch may not send that part to the wallet itself, even
though the lookup page may show an amount. The routing exceptions decide it,
as in `backend/src/claims.ts`, but more strictly:

- `redirect`: a route sends some of it to another address.
- `hold`: some of it is held pending a policy decision or a destination.
- `exchange_manual`: some of it is delivered separately by an exchange.
- `ledger mismatch` (vault shares only): the wallet's positions do not add up to
  the ledger's `migration_staked_to_vault_atto`, so the portal's arithmetic
  and the pipeline disagree.

Exchange-manual amounts are subtracted from vault shares, as on the lookup
page; not-issued and redistributed amounts are subtracted from both parts.
Blocked parts are left out of the pending filters and exports below and are
listed in the summary. A part already marked sent stays sent.

Filters select what is shown; the summary and the CSVs then cover only that:

```sh
db/ops/confirmed-wallets.sh --decision none --csv                       # still to review
db/ops/confirmed-wallets.sh --decision approved --wallet pending --csv  # input for the next wallet batch
db/ops/confirmed-wallets.sh --decision approved --vault pending --csv   # input for the next vault batch
db/ops/confirmed-wallets.sh --run confirmed-wallets-1 --compact         # who that run paid
```

- `--decision none|approved|rejected` is per confirmation.
- `--wallet pending|sent|blocked` and `--vault pending|partial|sent|blocked`
  are per wallet: a wallet paid under one confirmation stays paid after it
  signs again under a new data version. Wallets with nothing to send for a
  part match none of these.
- `--vault pending` means something is left to send, so it includes
  `partial`; the vault-shares CSV then lists only the positions still to send.
  `--vault blocked` lists the blocked positions.
- `--run NAME` (repeatable) keeps wallets whose wallet part or any vault
  position is currently marked sent by that run.

The filtering is done by `confirmed-wallets.py` after one full extract, so a
filtered run reads the same rows as an unfiltered one.

`--csv` writes two files with the report timestamp, and the filters if any, in
their names: one row per confirmation with atto and ONE amounts, the
per-validator breakdown in a `vault_shares_breakdown` column, the review state
(`decision`, `wallet_destination_status`, `wallet_status`, `vault_status` and
the runs), the signature and the signed message; and a companion
`-vault-shares.csv` with one row per wallet and validator, its
`destination_status`, the wallet's `decision`, and `sent_status` (pending,
sent, blocked or none), `blocked_reason` and `sent_run`. The output prints the
SHA-256 of both files. `--out-dir` changes the directory.

The two files go into harmony-migration's tools as they are: the main file
into `safe-batch build --address-column address --amount-column
wallet_allocation_atto`, the vault-shares file into `vault-batch build
--input`. Those builders recognise the export by its `decision` and status
columns and refuse it unless every row is approved and still pending, so an
unfiltered or stale export stops the build instead of paying unreviewed,
rejected, blocked or already-paid wallets. A plain payment list without these
columns is read as before. `db/ops/test_airdrop_compat.py` runs both files
through the builders' readers from `$HARMONY_MIGRATION_REPO` (default
`~/git/harmony-migration`) and is skipped when that checkout is missing.

Amounts come from the loaded ledger, so they reflect the current
`snapshot_meta.data_version`, not the version the wallet signed under; the
`still_candidate` column says whether the two agree. The report runs as the
owner role because it reads schema `confirm` and the public ledger in one
pass, which neither runtime role can do. The database URL is never printed.

## Approving and marking deliveries

`record-review.sh` appends rows to `confirm.reviews` as the owner role. It never
updates or deletes a row and does not touch the ledger or the schema. Without
`--apply` it only prints the plan and saves it under `data/reviews/`; with
`--apply` it writes every planned row in one transaction, or none. It opens
the same tunnel as `confirmed-wallets.sh` (`--no-tunnel`, `--db-url` as there).

```sh
# 1. review: export what is undecided, keep the rows you approve
db/ops/confirmed-wallets.sh --decision none --csv
db/ops/record-review.sh --approve --from-csv approved.csv --label approved-1           # prints the plan
db/ops/record-review.sh --approve --from-csv approved.csv --label approved-1 --apply
db/ops/record-review.sh --reject --confirmation-id 15 --note "reason"

# 2. after a run's Safe transactions have executed, mark what it paid
db/ops/record-review.sh --sent wallet --from-run ~/git/harmony-migration/airdrop/runs/confirmed-wallets-1 --apply
db/ops/record-review.sh --sent vault --from-run ~/git/harmony-migration/airdrop/runs/vaults-pilot-1 --apply
db/ops/record-review.sh --sent wallet --from-run …/confirmed-wallets-2 --transaction 1 --apply   # one Safe tx so far

# 3. undo a run's marks, for example for a transaction that did not execute
db/ops/record-review.sh --unsent wallet --run confirmed-wallets-2 --note "tx 2 replaced" --apply
```

- **Inputs.** `--from-csv` reads an `id` column, an `address` column, or both
  (then they must agree), so a `confirmed-wallets` export works as it is.
  `--sent` reads the run directory itself: `recipients.csv` of a `safe-batch`
  run, `deposits.csv` of a `vault-batch` run, or the per-transaction lists for
  `--transaction`. Each list must match its SHA-256 in `manifest.json`.
- **Approve** refuses confirmations signed under a superseded candidate set,
  a signer that differs from the address, and addresses missing from the
  ledger. Already approved confirmations are left out.
- **Sent** refuses a wallet that is not approved, an amount that differs from
  the ledger (`wallet_allocation_atto` for the wallet part, the vault shares
  for that validator), a blocked part, a delivery already marked sent by
  another run (a double payment), and a run name already recorded from a
  different `manifest.json`. Rows already recorded for the same run are left out, so
  marking a run again is safe. Addresses without a confirmation, such as
  initial-stage delegators in a vault run, are counted and left out.
- **Run names identify batches.** The batch id is built from the run
  directory's name, so give every batch its own directory, with a sequence
  number: `confirmed-wallets-1`, `confirmed-wallets-2`, `vaults-pilot-1`,
  `vaults-3`. Each row also stores the run's `manifest.json` SHA-256.
- **Concurrent changes.** The apply step locks `confirm.reviews` and stops if
  any review row was added since the plan was made.
- **It does not read the chain.** Run `--sent` after the transactions have
  executed and, for vaults, after `vault-batch reconcile` passed.

How the rows read back (`db/ops/review_tracks.py`): `batch_id`
`wallet:<run>` is the wallet part, `vault:<run>:<validator>` the vault shares
with one validator, anything else an approval decision with an optional label.
Status `queued` on a decision means approved, `rejected` rejected; `included`
on a wallet or vault row means sent, `queued` there means undone. The latest
row of each kind wins. Rows that do not parse are counted in the report's
summary and otherwise ignored, so write rows with this script, not by hand.

## Export and backup

```sh
export CONFIRM_OWNER_URL="$(backend/deploy/tunnel-db.sh --print-dsn)"   # with the tunnel open
db/ops/export-confirmations.sh --out data/confirm-export
db/ops/backup-confirm.sh
```

`data/` is gitignored. `confirmations.csv` includes `id`; `reviews.csv` has
every review row. The export manifest is the SHA-256 of `confirmations.csv`.
Recover each signature before using the file.

## Rotating the owner password

The role split rotates the owner password once. To rotate it again, for
example after it was shown somewhere it should not have been, run on the VM
between deploys, from a release that has this option:

```sh
sudo db/ops/setup-roles.sh --vm --db-name claims --domain migrate.country --rotate-owner
```

It sets a new password for `claimapi`, writes it to
`/etc/harmony-claim-migrate.env` and keeps `CONFIRM_BACKUP_BUCKET` there. The
API processes do not use the owner role. Sessions already open keep working;
`confirmed-wallets.sh`, `record-review.sh`, the backup timer and the next
deploy read the new URL from the migrate env.

## Verifying a signature

Every row has `signature_scheme`. Rows from before migration 006 are
`personal_sign`. The signature is 65 bytes, `r || s || v` with `v` 27 or 28.
The signed text is the `message` column exactly, UTF-8.

- `personal_sign`: EIP-191. Recover from
  `keccak256("\x19Ethereum Signed Message:\n" + len(message) + message)`.
  Browser and phone wallets, Ledger Wallet over WalletConnect, and the 2025
  Harmony and Ethereum Ledger apps over USB use this.
- `harmony_ledger_tx`: the pre-2025 Harmony Ledger app, which only signs
  transactions. Recover from `keccak256(payload)`, where `payload` is
  `rlp([0, 0, 0, 0, 0, address, 0, message, 1, 0, 0])`: nonce, gas price,
  gas limit, shard, to shard, recipient (the confirming address itself),
  amount, data, then chain id 1 and the two EIP-155 zeros. Integers are
  minimal big-endian, so each 0 is the empty string. This equals Harmony's
  `types.NewEIP155Signer(big.NewInt(1)).Hash(tx)` for that transaction. It
  can never be included in a block: a gas limit of 0 is below intrinsic gas.

In both cases the recovered address must equal `address`.

Deploy enables `harmony-claim-backup.timer`, which runs `backup-confirm.sh`
daily, keeps 14 dumps under `/var/lib/harmony-claim-api/backups`, and uploads
when `CONFIRM_BACKUP_BUCKET` is set in the migrate env.
`db/ops/setup-roles.sh --backup-bucket` writes that name there; the API
environment files do not receive it. Deploy passes `CONFIRM_BACKUP_BUCKET`
from `.env` when it is set.

A challenge is a random nonce and an issued time. It is not stored. The
server rebuilds the signed message from the candidate row and accepts the
signature while that issued time is inside the window. Replaying a valid
signature does not create a second row.

Backups matter because these rows cannot be rebuilt from the migration
artifacts. Set `CONFIRM_BACKUP_BUCKET` to a private bucket to upload the dump.
Restore is manual and goes to a scratch database first:

```sh
createdb claims_confirm_restore
pg_restore --dbname=claims_confirm_restore data/confirm-backups/confirm-*.dump
psql claims_confirm_restore -c "SELECT count(*) FROM confirm.confirmations"
dropdb claims_confirm_restore
```

Do not restore over the live `claims` database until that scratch count matches
the export.

## Processes

| Unit | Listens | Database role |
| --- | --- | --- |
| `harmony-claim-proxy` | `0.0.0.0:8080` | none |
| `harmony-claim-api` | `127.0.0.1:8081` | `claim_read` |
| `harmony-claim-confirm` | `127.0.0.1:8082` | `claim_confirm` |

The load balancer still sends `/api/*` to port 8080. The proxy forwards
`/api/v1/confirmations` to the confirmation process and every other path to
the lookup process. Both API processes refuse to start if their role can
modify a ledger table.

`/confirm` is uploaded as its own object so the site returns HTTP 200. The
bucket's website error page would otherwise serve the app with status 404.
