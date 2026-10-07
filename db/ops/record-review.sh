#!/usr/bin/env bash
# Record approval decisions and deliveries in confirm.reviews. Appends rows
# only: never updates or deletes, and does not change the claim ledger.
# Without --apply it prints the plan and writes nothing to the database.
#
# Approve or reject confirmations (ids: db/ops/confirmed-wallets.sh --compact, or the id column of --csv):
#   db/ops/record-review.sh --approve --from-csv approved.csv [--label approved-1] [--note TEXT]
#   db/ops/record-review.sh --approve --confirmation-id 151 --confirmation-id 152
#   db/ops/record-review.sh --reject --confirmation-id 15 --note "reason"
#
# After a run's Safe transactions have executed, mark what it paid:
#   db/ops/record-review.sh --sent wallet --from-run ~/git/harmony-migration/airdrop/runs/confirmed-wallets-1
#   db/ops/record-review.sh --sent vault --from-run ~/git/harmony-migration/airdrop/runs/vaults-pilot-1
#   ... --transaction 1 --transaction 2    only those Safe transactions of the run
#
# Undo the marks of one run, for example after a transaction that did not execute:
#   db/ops/record-review.sh --unsent wallet --run confirmed-wallets-1 [--confirmation-id N] --note "reason"
#
# --apply            write the planned rows, in one transaction
# --out-dir DIR      where the plan CSV goes (default data/reviews)
# --no-tunnel        use CONFIRM_OWNER_URL or DATABASE_URL from .env instead of the IAP tunnel
# --db-url URL       use this database URL (implies --no-tunnel)
#
# --sent refuses unapproved confirmations, amounts that differ from the ledger,
# a delivery already marked sent by another run, and a run name already
# recorded from a different manifest.json. db/ops/review_tracks.py describes
# the rows.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# shellcheck source=../../infra/lib.sh
source "$root/infra/lib.sh"
# shellcheck source=owner-db.sh
source "$here/owner-db.sh"

if [ -f "${HCP_ENV_FILE:-$root/.env}" ]; then
  load_env
fi

usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"; }

OWNER_DB_TUNNEL=1
apply=0
plan_dir="$root/data/reviews"
py_args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --approve|--reject) py_args+=("$1"); shift ;;
    --sent|--unsent|--confirmation-id|--from-csv|--from-run|--transaction|--run|--label|--note)
      [ "$#" -ge 2 ] || die "$1 needs a value"
      py_args+=("$1" "$2"); shift 2 ;;
    --apply) apply=1; shift ;;
    --out-dir) [ "$#" -ge 2 ] || die "--out-dir needs a value"; plan_dir="$2"; shift 2 ;;
    --no-tunnel) OWNER_DB_TUNNEL=0; shift ;;
    --db-url|--dsn) [ "$#" -ge 2 ] || die "$1 needs a value"; OWNER_DB_URL="$2"; OWNER_DB_TUNNEL=0; shift 2 ;;
    --status|--batch-id)
      die "$1 is gone: use --approve, --reject, --sent wallet|vault or --unsent wallet|vault (see --help)" ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
[ "${#py_args[@]}" -gt 0 ] || { usage; exit 1; }

require_tools psql python3

# Argument and run-directory mistakes surface before the tunnel opens.
python3 "$here/record-review.py" --check-only "${py_args[@]}"

work="$(mktemp -d)"
trap 'owner_db_close; rm -rf "$work"' EXIT

owner_db_open "$work"
log "reading confirmations, ledger amounts, vault shares and review rows"
owner_db_extract "$work"

mkdir -p "$plan_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
plan="$plan_dir/review-plan-$stamp.csv"
n=1
while [ -e "$plan" ]; do
  n=$((n + 1))
  plan="$plan_dir/review-plan-$stamp-$n.csv"
done
python3 "$here/record-review.py" \
  --confirmations "$work/confirmations.csv" \
  --vault-shares "$work/vault-shares.csv" \
  --exceptions "$work/exceptions.csv" \
  --reviews "$work/reviews.csv" \
  --plan-out "$plan" \
  --meta-out "$work/meta" \
  "${py_args[@]}"

read -r planned expected_rows expected_max_id <"$work/meta"
if [ "$planned" -eq 0 ]; then
  rm -f "$plan"
  log "nothing to record"
  exit 0
fi
if [ "$apply" -ne 1 ]; then
  log "dry run: nothing written. Plan: $plan"
  log "add --apply to record these $planned row(s)"
  exit 0
fi

# The lock keeps two runs of this script, or a hand-written insert, from
# interleaving; the counts prove nothing changed since the extract the plan
# was made from.
cat >"$work/apply.sql" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE confirm.reviews IN SHARE ROW EXCLUSIVE MODE;
SELECT set_config('hcp.expected_rows', :'expected_rows', true),
       set_config('hcp.expected_max_id', :'expected_max_id', true),
       set_config('hcp.planned_rows', :'planned_rows', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM confirm.reviews) <> current_setting('hcp.expected_rows')::bigint
     OR (SELECT COALESCE(max(id), 0) FROM confirm.reviews) <> current_setting('hcp.expected_max_id')::bigint THEN
    RAISE EXCEPTION 'confirm.reviews changed after the plan was made; nothing was written. Run the command again.';
  END IF;
END
$$;
CREATE TEMP TABLE review_plan (
  action          text,
  confirmation_id bigint NOT NULL,
  address         text NOT NULL,
  status          text NOT NULL,
  batch_id        text,
  note            text NOT NULL,
  amount_atto     text,
  amount_one      text
) ON COMMIT DROP;
\copy review_plan FROM pstdin WITH (FORMAT csv, HEADER match, FORCE_NOT_NULL (note))
DO $$
BEGIN
  IF (SELECT count(*) FROM review_plan) <> current_setting('hcp.planned_rows')::bigint THEN
    RAISE EXCEPTION 'the plan file does not hold the planned number of rows; nothing was written';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM review_plan p
      LEFT JOIN confirm.confirmations c ON c.id = p.confirmation_id
     WHERE c.id IS NULL OR lower(c.address) <> p.address
  ) THEN
    RAISE EXCEPTION 'a planned row names a confirmation that does not match its address; nothing was written';
  END IF;
END
$$;
INSERT INTO confirm.reviews (confirmation_id, status, batch_id, note)
SELECT confirmation_id, status, batch_id, note FROM review_plan;
COMMIT;
SQL

log "recording $planned row(s)"
psql "$OWNER_DB_URL" -X -q -o /dev/null -v ON_ERROR_STOP=1 \
  -v expected_rows="$expected_rows" \
  -v expected_max_id="$expected_max_id" \
  -v planned_rows="$planned" \
  -f "$work/apply.sql" <"$plan" \
  || die "nothing was recorded (see the error above); the plan is $plan"
log "recorded $planned review row(s) in confirm.reviews; plan: $plan"
