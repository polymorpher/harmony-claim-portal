#!/usr/bin/env bash
# Append a review decision for one stored confirmation. Does not update the
# confirmation row and does not change the claim ledger.
#
#   db/ops/record-review.sh --confirmation-id 15 --status queued --batch-id later-1 --dsn "$OWNER_DSN"
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# shellcheck source=../../infra/lib.sh
source "$root/infra/lib.sh"

if [ -f "${HCP_ENV_FILE:-$root/.env}" ]; then
  load_env
fi

confirmation_id=""
status=""
batch_id=""
note=""
dsn="${CONFIRM_OWNER_URL:-${DATABASE_URL:-}}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirmation-id) confirmation_id="$2"; shift 2 ;;
    --status) status="$2"; shift 2 ;;
    --batch-id) batch_id="$2"; shift 2 ;;
    --note) note="$2"; shift 2 ;;
    --dsn) dsn="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$dsn" ] || die "pass --dsn or set CONFIRM_OWNER_URL"
case "$confirmation_id" in
  ''|*[!0-9]*) die "--confirmation-id must be a positive integer" ;;
esac
case "$status" in
  queued|included|rejected) ;;
  *) die "--status must be queued, included, or rejected" ;;
esac
require_tools psql

psql "$dsn" -v ON_ERROR_STOP=1 \
  -v confirmation_id="$confirmation_id" \
  -v status="$status" \
  -v batch_id="$batch_id" \
  -v note="$note" <<'SQL'
SELECT 1 / COUNT(*) AS present
  FROM confirm.confirmations
 WHERE id = :'confirmation_id'::bigint;
INSERT INTO confirm.reviews (confirmation_id, status, batch_id, note)
SELECT c.id, :'status', NULLIF(:'batch_id', ''), :'note'
  FROM confirm.confirmations c
 WHERE c.id = :'confirmation_id'::bigint;
SQL
log "recorded review for confirmation $confirmation_id"
