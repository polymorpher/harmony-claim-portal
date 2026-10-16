#!/usr/bin/env bash
# Record that the holder of a candidate wallet confirmed its activity outside
# the site, for example an exchange that holds the key and cannot sign on
# /confirm. Adds one row per address to confirm.confirmations with
# signature_scheme attestation: no signature, who attested, and the SHA-256 of
# their statement. Appends only. Without --apply it prints the plan and writes
# nothing to the database.
#
#   db/ops/record-attestation.sh --address one1… --address 0x… \
#     --attested-by crypto.com --evidence statement.pdf [--note TEXT]
#   ... --apply
#
# The rows are then confirmations like any other: approve them and mark what
# a run paid with db/ops/record-review.sh, for example
#   db/ops/record-review.sh --approve --from-csv <the plan CSV> --label attested-1 --apply
#
# --apply            write the planned rows, in one transaction
# --out-dir DIR      where the plan CSV goes (default data/attestations)
# --no-tunnel        use CONFIRM_OWNER_URL or DATABASE_URL from .env instead of the IAP tunnel
# --db-url URL       use this database URL (implies --no-tunnel)
#
# Refuses an address that is not a candidate in the loaded set, is not deferred
# in the loaded ledger, or already confirmed under that set. Keep the evidence
# file: the database holds only its hash. Needs migration 008.
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
plan_dir="$root/data/attestations"
py_args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --address|--attested-by|--evidence|--note)
      [ "$#" -ge 2 ] || die "$1 needs a value"
      py_args+=("$1" "$2"); shift 2 ;;
    --apply) apply=1; shift ;;
    --out-dir) [ "$#" -ge 2 ] || die "--out-dir needs a value"; plan_dir="$2"; shift 2 ;;
    --no-tunnel) OWNER_DB_TUNNEL=0; shift ;;
    --db-url|--dsn) [ "$#" -ge 2 ] || die "$1 needs a value"; OWNER_DB_URL="$2"; OWNER_DB_TUNNEL=0; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
[ "${#py_args[@]}" -gt 0 ] || { usage; exit 1; }

require_tools psql python3

# Argument mistakes surface before the tunnel opens; this prints the addresses as 0x.
checked="$(python3 "$here/record-attestation.py" --check-only "${py_args[@]}")" || exit 2
addresses=()
while read -r address; do
  [ -n "$address" ] && addresses+=("$address")
done <<<"$checked"

work="$(mktemp -d)"
trap 'owner_db_close; rm -rf "$work"' EXIT

owner_db_open "$work"
log "reading the candidate and ledger rows of ${#addresses[@]} address(es), and the confirmations"
owner_db_candidates "$work" "${addresses[@]}"
owner_db_extract "$work"

mkdir -p "$plan_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
plan="$plan_dir/attestation-plan-$stamp.csv"
n=1
while [ -e "$plan" ]; do
  n=$((n + 1))
  plan="$plan_dir/attestation-plan-$stamp-$n.csv"
done
python3 "$here/record-attestation.py" \
  --candidates "$work/attest-candidates.csv" \
  --confirmations "$work/confirmations.csv" \
  --plan-out "$plan" \
  --meta-out "$work/meta" \
  "${py_args[@]}"

read -r planned <"$work/meta"
if [ "$apply" -ne 1 ]; then
  log "dry run: nothing written. Plan: $plan"
  log "add --apply to record these $planned attestation(s)"
  exit 0
fi

# The checks repeat inside the transaction: the candidate list may have been
# reloaded, or the wallet may have signed, since the extract.
cat >"$work/apply.sql" <<'SQL'
\o /dev/null
BEGIN;
SELECT set_config('hcp.planned_rows', :'planned_rows', true);
CREATE TEMP TABLE attestation_plan (
  address                      text NOT NULL,
  data_version                 text NOT NULL,
  policy_version               text NOT NULL,
  stage_reason                 text NOT NULL,
  attested_by                  text NOT NULL,
  evidence_sha256              text NOT NULL,
  message                      text NOT NULL,
  wallet_allocation_atto       text,
  vault_shares_allocation_atto text
) ON COMMIT DROP;
\copy attestation_plan FROM pstdin WITH (FORMAT csv, HEADER match)
DO $$
BEGIN
  IF (SELECT count(*) FROM attestation_plan) <> current_setting('hcp.planned_rows')::bigint THEN
    RAISE EXCEPTION 'the plan file does not hold the planned number of rows; nothing was written';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM attestation_plan p
      LEFT JOIN confirm.candidates c
        ON c.address = p.address AND c.data_version = p.data_version
       AND c.policy_version = p.policy_version AND c.stage_reason = p.stage_reason
     WHERE c.address IS NULL
  ) THEN
    RAISE EXCEPTION 'an address is no longer a candidate as planned; nothing was written. Run the command again.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM attestation_plan p
      JOIN confirm.confirmations c
        ON c.address = p.address AND c.data_version = p.data_version AND c.policy_version = p.policy_version
  ) THEN
    RAISE EXCEPTION 'an address was confirmed after the plan was made; nothing was written. Run the command again.';
  END IF;
END
$$;
\o
INSERT INTO confirm.confirmations
  (address, data_version, policy_version, stage_reason, message, signature, signature_scheme, signer,
   attested_by, evidence_sha256)
SELECT address, data_version, policy_version, stage_reason, message, NULL, 'attestation', NULL,
       attested_by, evidence_sha256
  FROM attestation_plan
RETURNING id, address;
\o /dev/null
COMMIT;
SQL

log "recording $planned attestation(s)"
psql "$OWNER_DB_URL" -X -q -tA -F ' ' -v ON_ERROR_STOP=1 \
  -v planned_rows="$planned" \
  -f "$work/apply.sql" <"$plan" >"$work/inserted" \
  || die "nothing was recorded (see the error above); the plan is $plan"
while read -r id address; do
  [ -n "$id" ] && log "  confirmation $id  $address"
done <"$work/inserted"
log "recorded $planned attestation(s) in confirm.confirmations; plan: $plan"
log "next: db/ops/record-review.sh --approve --from-csv $plan --label <name> --apply"
