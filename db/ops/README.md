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
db/ops/load-candidates.sh \
  --migration-repo ~/git/harmony-migration \
  --dsn "$(backend/deploy/tunnel-db.sh --print-dsn)"
```

`--print-dsn` prints the owner URL. Do not paste it into a ticket or a file
that is committed.

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

## Export, review, backup

```sh
db/ops/export-confirmations.sh --out data/confirm-export --dsn "$CONFIRM_OWNER_URL"
db/ops/record-review.sh --confirmation-id 15 --status queued --batch-id later-1 --dsn "$CONFIRM_OWNER_URL"
db/ops/backup-confirm.sh --dsn "$CONFIRM_OWNER_URL"
```

`data/` is gitignored. `confirmations.csv` includes `id`, which
`record-review.sh --confirmation-id` uses. The export manifest is the SHA-256
of that CSV. Recover each signature before using the file.

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
