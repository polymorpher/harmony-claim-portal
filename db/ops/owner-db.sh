# shellcheck shell=bash
# shellcheck disable=SC2034 # OWNER_DB_* are read by the scripts that source this file
# Owner-role database access for db/ops/confirmed-wallets.sh and
# db/ops/record-review.sh. Source after infra/lib.sh; do not execute.
#
#   OWNER_DB_TUNNEL=1                # default: IAP tunnel to the VM
#   OWNER_DB_TUNNEL=0 OWNER_DB_URL=… # a URL you already have (or CONFIRM_OWNER_URL / DATABASE_URL)
#   owner_db_open "$work"            # sets OWNER_DB_URL and OWNER_DB_SOURCE (no password)
#   owner_db_extract "$work"         # writes the CSV extracts, sets OWNER_DB_LEDGER_VERSION
#   owner_db_close                   # ends a tunnel this process opened; safe to call twice
#
# The tunnel needs .env (GCP_PROJECT, GCP_ZONE, VM_NAME, DB_TUNNEL_PORT) and a
# logged-in gcloud. One IAP SSH session forwards the VM's PostgreSQL to
# localhost and reads the owner database URL from the VM (a root-only file
# there). If something already listens on DB_TUNNEL_PORT, for example
# backend/deploy/tunnel-db.sh, that tunnel is used and left open.

OWNER_DB_URL="${OWNER_DB_URL:-}"
OWNER_DB_SOURCE=""
OWNER_DB_LEDGER_VERSION=""
_owner_db_tunnel_pid=""

# All descendants of a pid, deepest first (gcloud runs ssh as a child).
_owner_db_descendants() {
  local child
  while read -r child; do
    [ -n "$child" ] || continue
    _owner_db_descendants "$child"
    echo "$child"
  done <<<"$(pgrep -P "$1" 2>/dev/null || true)"
}

_owner_db_any_alive() {
  local pid
  for pid in "$@"; do
    if kill -0 "$pid" 2>/dev/null; then return 0; fi
  done
  return 1
}

owner_db_close() {
  [ -n "$_owner_db_tunnel_pid" ] || return 0
  local pids=() pid tries=0
  while read -r pid; do
    [ -n "$pid" ] && pids+=("$pid")
  done <<<"$(_owner_db_descendants "$_owner_db_tunnel_pid")"
  pids+=("$_owner_db_tunnel_pid")
  kill -TERM "${pids[@]}" 2>/dev/null || true
  wait "$_owner_db_tunnel_pid" 2>/dev/null || true
  while _owner_db_any_alive "${pids[@]}" && [ "$tries" -lt 10 ]; do
    sleep 0.3
    tries=$((tries + 1))
  done
  if _owner_db_any_alive "${pids[@]}"; then
    kill -KILL "${pids[@]}" 2>/dev/null || true
  fi
  _owner_db_tunnel_pid=""
}

_owner_db_port_open() {
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

_owner_db_log_tail() { tail -n 5 "$1" 2>/dev/null | tr '\n' ' '; }

# gcloud registers the local SSH key with OS Login on first use. Two sessions
# doing that at once fail with "importSshPublicKey ... Multiple concurrent
# mutations"; the second attempt then finds the key already registered.
_owner_db_ssh_key_race() { grep -qiE 'concurrent mutations|importSshPublicKey' "$1" 2>/dev/null; }

# owner_db_open WORKDIR: WORKDIR holds the SSH logs.
owner_db_open() {
  local work="$1"
  if [ "${OWNER_DB_TUNNEL:-1}" -ne 1 ]; then
    OWNER_DB_URL="${OWNER_DB_URL:-${CONFIRM_OWNER_URL:-${DATABASE_URL:-}}}"
    [ -n "$OWNER_DB_URL" ] || die "--no-tunnel needs --db-url URL, or CONFIRM_OWNER_URL / DATABASE_URL in .env"
    # Header label: scheme, user, host, port and database; never the password.
    OWNER_DB_SOURCE="$(printf '%s' "$OWNER_DB_URL" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://[^:/@]+):[^@]*@#\1@#')"
    return 0
  fi

  set_defaults
  require_vars GCP_PROJECT GCP_ZONE VM_NAME DB_TUNNEL_PORT DB_NAME
  require_tools gcloud

  # The owner URL lives in a root-only file on the VM.
  local read_url='if [ -f /etc/harmony-claim-migrate.env ]; then sudo grep -E "^DATABASE_URL=" /etc/harmony-claim-migrate.env; else sudo grep -E "^DATABASE_URL=" '"$APP_ENV_FILE"'; fi | cut -d= -f2- | tr -d "\""'
  local ready_marker="HCP_TUNNEL_READY"
  local raw_url="" attempt waited

  if _owner_db_port_open "$DB_TUNNEL_PORT"; then
    log "using the tunnel already open on localhost:$DB_TUNNEL_PORT"
    log "reading the database URL from $VM_NAME"
    for attempt in 1 2 3; do
      if raw_url="$(vm_ssh "$read_url" 2>"$work/ssh.log" </dev/null)" && [ -n "$raw_url" ]; then break; fi
      raw_url=""
      if [ "$attempt" -lt 3 ] && _owner_db_ssh_key_race "$work/ssh.log"; then
        warn "SSH key registration raced with another gcloud session; retrying ($attempt/3)"
        sleep 3
        continue
      fi
      die "could not read the database URL from $VM_NAME: $(_owner_db_log_tail "$work/ssh.log")"
    done
  else
    log "opening tunnel to $VM_NAME (localhost:$DB_TUNNEL_PORT -> PostgreSQL) and reading the database URL"
    # One SSH session forwards the port and prints the URL, then idles to
    # keep the forward open until owner_db_close ends it.
    for attempt in 1 2 3; do
      : >"$work/tunnel.out"
      : >"$work/tunnel.log"
      gcloud --project "$GCP_PROJECT" --quiet compute ssh "$VM_NAME" --zone "$GCP_ZONE" --tunnel-through-iap \
        --command "$read_url; echo $ready_marker; exec sleep 86400" \
        -- -L "${DB_TUNNEL_PORT}:127.0.0.1:5432" -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
        >"$work/tunnel.out" 2>"$work/tunnel.log" </dev/null &
      _owner_db_tunnel_pid=$!
      waited=0
      until grep -q "^$ready_marker" "$work/tunnel.out" 2>/dev/null; do
        kill -0 "$_owner_db_tunnel_pid" 2>/dev/null || break
        [ "$waited" -lt 60 ] || die "tunnel did not come up in 60 s: $(_owner_db_log_tail "$work/tunnel.log")"
        sleep 1
        waited=$((waited + 1))
      done
      if grep -q "^$ready_marker" "$work/tunnel.out" 2>/dev/null; then
        raw_url="$(grep -v "^$ready_marker" "$work/tunnel.out" | grep -m1 . | tr -d '[:space:]')"
        break
      fi
      wait "$_owner_db_tunnel_pid" 2>/dev/null || true
      _owner_db_tunnel_pid=""
      if [ "$attempt" -lt 3 ] && _owner_db_ssh_key_race "$work/tunnel.log"; then
        warn "SSH key registration raced with another gcloud session; retrying ($attempt/3)"
        sleep 3
        continue
      fi
      die "tunnel to $VM_NAME failed: $(_owner_db_log_tail "$work/tunnel.log")"
    done
  fi

  [ -n "$raw_url" ] || die "the VM returned no database URL (expected DATABASE_URL in /etc/harmony-claim-migrate.env)"
  # Point the URL at the local end of the tunnel.
  OWNER_DB_URL="$(printf '%s' "$raw_url" | sed -E "s#@[^/]+/#@localhost:${DB_TUNNEL_PORT}/#")"
  _owner_db_port_open "$DB_TUNNEL_PORT" || die "nothing is listening on localhost:$DB_TUNNEL_PORT: $(_owner_db_log_tail "$work/tunnel.log")"
  OWNER_DB_SOURCE="$VM_NAME PostgreSQL via IAP tunnel (localhost:$DB_TUNNEL_PORT)"
}

# COPY ... TO STDOUT needs no server-side file privilege. Timestamps are
# rendered in UTC in SQL so the formatters never depend on a session timezone.
_owner_db_copy() {
  psql "$OWNER_DB_URL" -X -q -v ON_ERROR_STOP=1 -f - > "$1"
}

# owner_db_extract DIR: confirmations.csv, vault-shares.csv, exceptions.csv,
# candidates.csv and reviews.csv.
owner_db_extract() {
  local dir="$1"
  _owner_db_copy "$dir/confirmations.csv" <<'SQL'
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
    a.last_activity_type
  FROM confirm.confirmations c
  LEFT JOIN confirm.candidates cand
    ON cand.address = c.address
   AND cand.data_version = c.data_version
   AND cand.policy_version = c.policy_version
  LEFT JOIN public.accounts a
    ON lower(a.address) = lower(c.address)
  ORDER BY c.created_at, c.id
) TO STDOUT WITH (FORMAT csv, HEADER true)
SQL

  _owner_db_copy "$dir/vault-shares.csv" <<'SQL'
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

  _owner_db_copy "$dir/exceptions.csv" <<'SQL'
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

  _owner_db_copy "$dir/candidates.csv" <<'SQL'
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

  # Every review row, oldest first: db/ops/review_tracks.py lets later rows win.
  _owner_db_copy "$dir/reviews.csv" <<'SQL'
COPY (
  SELECT
    r.id,
    r.confirmation_id,
    lower(c.address)                                                        AS address,
    r.status,
    r.batch_id,
    r.note,
    to_char(r.reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at_utc
  FROM confirm.reviews r
  JOIN confirm.confirmations c ON c.id = r.confirmation_id
  ORDER BY r.reviewed_at, r.id
) TO STDOUT WITH (FORMAT csv, HEADER true)
SQL

  OWNER_DB_LEDGER_VERSION="$(psql "$OWNER_DB_URL" -X -q -tA -v ON_ERROR_STOP=1 \
    -c "SELECT value #>> '{}' FROM public.snapshot_meta WHERE key = 'data_version'" | tr -d '[:space:]')"
}
