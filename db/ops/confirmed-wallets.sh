#!/usr/bin/env bash
# Who has confirmed: wallets that signed on /confirm, with amounts and signatures.
#
#   db/ops/confirmed-wallets.sh            # tunnel to the VM, print the report, close the tunnel
#   db/ops/confirmed-wallets.sh --csv      # also write data/confirmed-wallets/confirmed-wallets-<UTC time>.csv
#   db/ops/confirmed-wallets.sh --compact  # one line per confirmation
#
# The default needs only .env (GCP_PROJECT, GCP_ZONE, VM_NAME, DB_TUNNEL_PORT)
# and a logged-in gcloud. One IAP SSH session forwards the VM's PostgreSQL to
# localhost and reads the owner database URL from the VM (a root-only file
# there); the report runs, then the session is closed. If something already
# listens on DB_TUNNEL_PORT, for example backend/deploy/tunnel-db.sh, that
# tunnel is used and left open.
#
# Without the tunnel (local database, or running on the VM itself):
#   db/ops/confirmed-wallets.sh --no-tunnel --db-url postgres://claimapi:PASSWORD@127.0.0.1:5434/claims
#   db/ops/confirmed-wallets.sh --no-tunnel      # uses CONFIRM_OWNER_URL or DATABASE_URL from .env
#
# Options: --csv, --compact, --out-dir DIR, --no-tunnel, --db-url URL (implies --no-tunnel).
#
# Each record shows the amount not in the initial airdrop (wallet part plus
# vault shares), the balance components behind it, vault shares per validator,
# last activity, signer, and the full signature. The summary has counts by
# reason, category, version and review status, the confirmed allocation, and
# the share of the loaded candidate set. The database URL is never printed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# shellcheck source=../../infra/lib.sh
source "$root/infra/lib.sh"

if [ -f "${HCP_ENV_FILE:-$root/.env}" ]; then
  load_env
fi

use_tunnel=1
db_url=""
out_dir="$root/data/confirmed-wallets"
extra=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --csv|--compact) extra+=("$1"); shift ;;
    --out-dir) out_dir="$2"; shift 2 ;;
    --no-tunnel) use_tunnel=0; shift ;;
    --db-url|--dsn) db_url="$2"; use_tunnel=0; shift 2 ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (options: --csv, --compact, --out-dir DIR, --no-tunnel, --db-url URL)" ;;
  esac
done

require_tools psql python3

work="$(mktemp -d)"
tunnel_pid=""

# All descendants of a pid, deepest first (gcloud runs ssh as a child).
descendants() {
  local child
  while read -r child; do
    [ -n "$child" ] || continue
    descendants "$child"
    echo "$child"
  done <<<"$(pgrep -P "$1" 2>/dev/null || true)"
}

any_alive() {
  local pid
  for pid in "$@"; do
    if kill -0 "$pid" 2>/dev/null; then return 0; fi
  done
  return 1
}

stop_tunnel() {
  [ -n "$tunnel_pid" ] || return 0
  local pids=() pid tries=0
  while read -r pid; do
    [ -n "$pid" ] && pids+=("$pid")
  done <<<"$(descendants "$tunnel_pid")"
  pids+=("$tunnel_pid")
  kill -TERM "${pids[@]}" 2>/dev/null || true
  wait "$tunnel_pid" 2>/dev/null || true
  while any_alive "${pids[@]}" && [ "$tries" -lt 10 ]; do
    sleep 0.3
    tries=$((tries + 1))
  done
  if any_alive "${pids[@]}"; then
    kill -KILL "${pids[@]}" 2>/dev/null || true
  fi
  tunnel_pid=""
}

cleanup() {
  stop_tunnel
  rm -rf "$work"
}
trap cleanup EXIT

port_open() {
  python3 - "$1" <<'PY'
import socket, sys
s = socket.socket()
s.settimeout(1)
try:
    s.connect(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)
sys.exit(0)
PY
}

log_tail() { tail -n 5 "$1" 2>/dev/null | tr '\n' ' '; }

# gcloud registers the local SSH key with OS Login on first use. Two sessions
# doing that at once fail with "importSshPublicKey ... Multiple concurrent
# mutations"; the second attempt then finds the key already registered.
ssh_key_race() { grep -qiE 'concurrent mutations|importSshPublicKey' "$1" 2>/dev/null; }

if [ "$use_tunnel" -eq 1 ]; then
  set_defaults
  require_vars GCP_PROJECT GCP_ZONE VM_NAME DB_TUNNEL_PORT DB_NAME
  require_tools gcloud

  # The owner URL lives in a root-only file on the VM.
  read_url='if [ -f /etc/harmony-claim-migrate.env ]; then sudo grep -E "^DATABASE_URL=" /etc/harmony-claim-migrate.env; else sudo grep -E "^DATABASE_URL=" '"$APP_ENV_FILE"'; fi | cut -d= -f2- | tr -d "\""'
  ready_marker="HCP_TUNNEL_READY"
  raw_url=""

  if port_open "$DB_TUNNEL_PORT"; then
    log "using the tunnel already open on localhost:$DB_TUNNEL_PORT"
    log "reading the database URL from $VM_NAME"
    for attempt in 1 2 3; do
      if raw_url="$(vm_ssh "$read_url" 2>"$work/ssh.log" </dev/null)" && [ -n "$raw_url" ]; then break; fi
      raw_url=""
      if [ "$attempt" -lt 3 ] && ssh_key_race "$work/ssh.log"; then
        warn "SSH key registration raced with another gcloud session; retrying ($attempt/3)"
        sleep 3
        continue
      fi
      die "could not read the database URL from $VM_NAME: $(log_tail "$work/ssh.log")"
    done
  else
    log "opening tunnel to $VM_NAME (localhost:$DB_TUNNEL_PORT -> PostgreSQL) and reading the database URL"
    # One SSH session forwards the port and prints the URL, then idles to
    # keep the forward open until stop_tunnel ends it.
    for attempt in 1 2 3; do
      : >"$work/tunnel.out"
      : >"$work/tunnel.log"
      gcloud --project "$GCP_PROJECT" --quiet compute ssh "$VM_NAME" --zone "$GCP_ZONE" --tunnel-through-iap \
        --command "$read_url; echo $ready_marker; exec sleep 86400" \
        -- -L "${DB_TUNNEL_PORT}:127.0.0.1:5432" -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
        >"$work/tunnel.out" 2>"$work/tunnel.log" </dev/null &
      tunnel_pid=$!
      waited=0
      until grep -q "^$ready_marker" "$work/tunnel.out" 2>/dev/null; do
        kill -0 "$tunnel_pid" 2>/dev/null || break
        [ "$waited" -lt 60 ] || die "tunnel did not come up in 60 s: $(log_tail "$work/tunnel.log")"
        sleep 1
        waited=$((waited + 1))
      done
      if grep -q "^$ready_marker" "$work/tunnel.out" 2>/dev/null; then
        raw_url="$(grep -v "^$ready_marker" "$work/tunnel.out" | grep -m1 . | tr -d '[:space:]')"
        break
      fi
      wait "$tunnel_pid" 2>/dev/null || true
      tunnel_pid=""
      if [ "$attempt" -lt 3 ] && ssh_key_race "$work/tunnel.log"; then
        warn "SSH key registration raced with another gcloud session; retrying ($attempt/3)"
        sleep 3
        continue
      fi
      die "tunnel to $VM_NAME failed: $(log_tail "$work/tunnel.log")"
    done
  fi

  [ -n "$raw_url" ] || die "the VM returned no database URL (expected DATABASE_URL in /etc/harmony-claim-migrate.env)"
  # Point the URL at the local end of the tunnel.
  db_url="$(printf '%s' "$raw_url" | sed -E "s#@[^/]+/#@localhost:${DB_TUNNEL_PORT}/#")"
  port_open "$DB_TUNNEL_PORT" || die "nothing is listening on localhost:$DB_TUNNEL_PORT: $(log_tail "$work/tunnel.log")"
  source_label="$VM_NAME PostgreSQL via IAP tunnel (localhost:$DB_TUNNEL_PORT)"
else
  db_url="${db_url:-${CONFIRM_OWNER_URL:-${DATABASE_URL:-}}}"
  [ -n "$db_url" ] || die "--no-tunnel needs --db-url URL, or CONFIRM_OWNER_URL / DATABASE_URL in .env"
  # Header label: scheme, user, host, port and database; never the password.
  source_label="$(printf '%s' "$db_url" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://[^:/@]+):[^@]*@#\1@#')"
fi

# COPY ... TO STDOUT needs no server-side file privilege. Timestamps are
# rendered in UTC in SQL so the formatter never depends on a session timezone.
extract() {
  psql "$db_url" -X -q -v ON_ERROR_STOP=1 -f - > "$1"
}

log "querying confirmations, ledger amounts, vault shares, candidates"
extract "$work/confirmations.csv" <<'SQL'
COPY (
  SELECT
    c.id,
    lower(c.address)                                                        AS address,
    lower(c.signer)                                                         AS signer,
    to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')  AS confirmed_at_utc,
    c.data_version,
    c.policy_version,
    c.stage_reason,
    c.signature,
    c.signature_scheme,
    c.message,
    (cand.address IS NOT NULL)                                              AS still_candidate,
    (a.address IS NOT NULL)                                                 AS in_ledger,
    a.account_category,
    a.meets_threshold,
    a.stage_policy_applied,
    a.migration_stage,
    a.issuance_treatment,
    a.migration_allocation_atto::text,
    a.migration_wallet_allocation_atto::text,
    a.migration_staked_to_vault_atto::text,
    a.liquid_shard0_atto::text,
    a.liquid_shard1_atto::text,
    a.pending_undelegation_atto::text,
    a.unclaimed_staking_reward_atto::text,
    a.pending_cross_shard_atto::text,
    a.wone_balance_atto::text,
    a.wone_airdrop_atto::text,
    a.native_wallet_airdrop_atto::text,
    a.wallet_airdrop_atto::text,
    a.staked_to_vault_atto::text,
    a.qualification_total_atto::text,
    a.total_claim_atto::text,
    to_char(a.last_activity_time_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_activity_utc,
    a.last_activity_type,
    r.status                                                                AS review_status,
    r.batch_id                                                              AS review_batch_id,
    to_char(r.reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at_utc
  FROM confirm.confirmations c
  LEFT JOIN confirm.candidates cand
    ON cand.address = c.address
   AND cand.data_version = c.data_version
   AND cand.policy_version = c.policy_version
  LEFT JOIN public.accounts a
    ON lower(a.address) = lower(c.address)
  LEFT JOIN LATERAL (
    SELECT status, batch_id, reviewed_at
      FROM confirm.reviews
     WHERE confirmation_id = c.id
     ORDER BY reviewed_at DESC, id DESC
     LIMIT 1
  ) r ON true
  ORDER BY c.created_at, c.id
) TO STDOUT WITH (FORMAT csv, HEADER true)
SQL

extract "$work/vault-shares.csv" <<'SQL'
COPY (
  SELECT
    lower(d.delegator_address) AS address,
    lower(d.validator_address) AS validator_address,
    v.validator_name,
    d.staked_to_vault_atto::text,
    d.is_self_delegation,
    d.priority,
    v.governor_status
  FROM public.delegations d
  LEFT JOIN public.validator_vaults v
    ON v.validator_address = d.validator_address
  WHERE lower(d.delegator_address) IN (SELECT DISTINCT lower(address) FROM confirm.confirmations)
  ORDER BY d.delegator_address, d.staked_to_vault_atto DESC, d.validator_address
) TO STDOUT WITH (FORMAT csv, HEADER true)
SQL

extract "$work/exceptions.csv" <<'SQL'
COPY (
  SELECT
    lower(e.source_address)    AS address,
    e.component,
    lower(e.validator_address) AS validator_address,
    e.destination_status,
    e.amount_atto::text
  FROM public.routing_exceptions e
  WHERE lower(e.source_address) IN (SELECT DISTINCT lower(address) FROM confirm.confirmations)
  ORDER BY e.source_address, e.component, e.route_priority, e.route_id, e.id
) TO STDOUT WITH (FORMAT csv, HEADER true)
SQL

extract "$work/candidates.csv" <<'SQL'
COPY (
  SELECT
    cand.data_version,
    cand.policy_version,
    to_char(cand.cutoff_time_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS cutoff_utc,
    count(*)                                                                    AS candidates,
    count(*) FILTER (WHERE cand.stage_reason = 'wallet activity predates initial window') AS candidates_predates_window,
    count(*) FILTER (WHERE cand.stage_reason = 'no indexed wallet activity')    AS candidates_no_activity,
    COALESCE(sum(a.migration_allocation_atto), 0)::text                         AS candidates_allocation_atto,
    COALESCE(sum(a.migration_wallet_allocation_atto), 0)::text                  AS candidates_wallet_allocation_atto,
    COALESCE(sum(a.migration_staked_to_vault_atto), 0)::text                    AS candidates_staked_to_vault_atto
  FROM confirm.candidates cand
  LEFT JOIN public.accounts a
    ON lower(a.address) = lower(cand.address)
  GROUP BY cand.data_version, cand.policy_version, cand.cutoff_time_utc
  ORDER BY cand.data_version, cand.policy_version
) TO STDOUT WITH (FORMAT csv, HEADER true)
SQL

ledger_version="$(psql "$db_url" -X -q -tA -v ON_ERROR_STOP=1 \
  -c "SELECT value #>> '{}' FROM public.snapshot_meta WHERE key = 'data_version'" | tr -d '[:space:]')"

# Close our tunnel before printing so the report is the last thing on screen.
stop_tunnel

python3 "$here/confirmed-wallets.py" \
  --confirmations "$work/confirmations.csv" \
  --vault-shares "$work/vault-shares.csv" \
  --exceptions "$work/exceptions.csv" \
  --candidates "$work/candidates.csv" \
  --ledger-data-version "$ledger_version" \
  --source "$source_label" \
  --out-dir "$out_dir" \
  ${extra[@]+"${extra[@]}"}
