#!/usr/bin/env bash
# Load the next-batch confirmation candidate set.
#
#   db/ops/load-candidates.sh --migration-repo ~/git/harmony-migration --dsn "$OWNER_DSN"
#
# CONFIRM_DATA_VERSION, CONFIRM_POLICY_VERSION and CONFIRM_CUTOFF_TIME can come
# from the environment or from the repo .env. The owner URL is the argument,
# CONFIRM_OWNER_URL, or DATABASE_URL. It is not printed.
#
# Refuses to load when the exchange exclusion set is missing or the candidate
# set is empty. A load replaces confirm.candidates and appends confirm.candidate_loads.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# shellcheck source=../../infra/lib.sh
source "$root/infra/lib.sh"

if [ -f "${HCP_ENV_FILE:-$root/.env}" ]; then
  load_env
fi

migration_repo=""
dsn="${CONFIRM_OWNER_URL:-${DATABASE_URL:-}}"
allow_empty=0
allow_mismatch=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --migration-repo) migration_repo="$2"; shift 2 ;;
    --dsn) dsn="$2"; shift 2 ;;
    --allow-empty) allow_empty=1; shift ;;
    --allow-version-mismatch) allow_mismatch=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$migration_repo" ] || die "pass --migration-repo (the harmony-migration checkout; it is not part of this repo)"
[ -n "$dsn" ] || die "pass --dsn or set CONFIRM_OWNER_URL"
require_vars CONFIRM_DATA_VERSION CONFIRM_POLICY_VERSION CONFIRM_CUTOFF_TIME
require_tools python3 psql

case "$CONFIRM_DATA_VERSION" in
  *[!A-Za-z0-9._:-]*) die "CONFIRM_DATA_VERSION has characters this loader does not accept" ;;
esac
case "$CONFIRM_POLICY_VERSION" in
  *[!A-Za-z0-9._:-]*) die "CONFIRM_POLICY_VERSION has characters this loader does not accept" ;;
esac
case "$CONFIRM_CUTOFF_TIME" in
  *[!A-Za-z0-9._:+-]*) die "CONFIRM_CUTOFF_TIME has characters this loader does not accept" ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
csv="$work/candidates.csv"

log "selecting candidates"
python3 "$here/load-candidates.py" \
  --migration-repo "$migration_repo" \
  --data-version "$CONFIRM_DATA_VERSION" \
  --policy-version "$CONFIRM_POLICY_VERSION" \
  --cutoff-time "$CONFIRM_CUTOFF_TIME" \
  --output "$csv"

rows="$(($(wc -l <"$csv") - 1))"
if [ "$rows" -le 0 ] && [ "$allow_empty" -ne 1 ]; then
  die "candidate set is empty; refusing to replace confirm.candidates"
fi
sha="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$csv")"

loaded="$(psql "$dsn" -tA -c "SELECT value #>> '{}' FROM snapshot_meta WHERE key = 'data_version'")"
loaded="$(printf '%s' "$loaded" | tr -d '[:space:]')"
if [ "$allow_mismatch" -ne 1 ] && [ "$loaded" != "$CONFIRM_DATA_VERSION" ]; then
  die "CONFIRM_DATA_VERSION=${CONFIRM_DATA_VERSION} does not match snapshot_meta data_version=${loaded:-<missing>}; the lookup page and /confirm would disagree. Pass --allow-version-mismatch only when that is intentional."
fi

log "loading $rows candidates"
psql "$dsn" -v ON_ERROR_STOP=1 \
  -v data_version="$CONFIRM_DATA_VERSION" \
  -v policy_version="$CONFIRM_POLICY_VERSION" \
  -v cutoff="$CONFIRM_CUTOFF_TIME" \
  -v row_count="$rows" \
  -v sha="$sha" <<EOF
BEGIN;
TRUNCATE confirm.candidates;
\\copy confirm.candidates (address, account_category, stage_reason, data_version, policy_version, cutoff_time_utc) FROM '${csv}' WITH (FORMAT csv, HEADER true)
INSERT INTO confirm.candidate_loads (data_version, policy_version, cutoff_time_utc, row_count, sha256)
VALUES (:'data_version', :'policy_version', :'cutoff'::timestamptz, :'row_count'::integer, :'sha');
COMMIT;
EOF
log "loaded $rows candidates"
