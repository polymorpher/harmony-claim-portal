#!/usr/bin/env bash
# Who has confirmed: wallets that signed on /confirm or were attested with
# db/ops/record-attestation.sh, with amounts, signatures and review state
# (approval decision, wallet part sent, vault shares sent).
#
#   db/ops/confirmed-wallets.sh            # tunnel to the VM, print the report, close the tunnel
#   db/ops/confirmed-wallets.sh --csv      # also write data/confirmed-wallets/confirmed-wallets-<UTC time>.csv
#   db/ops/confirmed-wallets.sh --compact  # one line per confirmation
#
# Filters (combine freely; the summary and CSVs cover only what is shown):
#   --decision none|approved|rejected   the confirmation's approval decision
#   --wallet pending|sent               the wallet part; wallets with nothing to send match neither
#   --vault pending|partial|sent        vault shares; pending means something is left to send, so it
#                                       includes partial, and the vault-shares CSV then lists only the
#                                       positions still to send
#   --run NAME                          wallet part or vault shares marked sent by run NAME (repeatable)
#
#   db/ops/confirmed-wallets.sh --decision approved --wallet pending --csv   # input for the next wallet batch
#   db/ops/confirmed-wallets.sh --decision approved --vault pending --csv    # input for the next vault batch
#
# Compare the sent marks with Ethereum (the reserve's transfers and vault deposits):
#   db/ops/confirmed-wallets.sh --chain --decision approved --compact
# The RPC is ETH_RPC_URL (environment or .env), else RPC_URL in
# $HARMONY_MIGRATION_REPO/airdrop/.env (default ~/git/harmony-migration). Vault addresses come
# from the vault catalog, frontend/public/vault-catalog.json unless --vault-catalog PATH.
#
# Without the tunnel (local database, or running on the VM itself):
#   db/ops/confirmed-wallets.sh --no-tunnel --db-url postgres://claimapi:PASSWORD@127.0.0.1:5434/claims
#   db/ops/confirmed-wallets.sh --no-tunnel      # uses CONFIRM_OWNER_URL or DATABASE_URL from .env
#
# Other options: --out-dir DIR, --no-tunnel, --db-url URL (implies --no-tunnel).
# Review rows are written by db/ops/record-review.sh. The database URL is never printed.
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
out_dir="$root/data/confirmed-wallets"
chain=0
catalog="$root/frontend/public/vault-catalog.json"
extra=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --csv|--compact) extra+=("$1"); shift ;;
    --chain) chain=1; shift ;;
    --vault-catalog) catalog="$2"; shift 2 ;;
    --decision|--wallet|--vault|--run)
      [ "$#" -ge 2 ] || die "$1 needs a value"
      case "$1:$2" in
        --decision:none|--decision:approved|--decision:rejected) ;;
        --wallet:pending|--wallet:sent) ;;
        --vault:pending|--vault:partial|--vault:sent) ;;
        --run:?*) ;;
        *) die "$1 does not accept '$2' (see --help)" ;;
      esac
      extra+=("$1" "$2"); shift 2 ;;
    --out-dir) out_dir="$2"; shift 2 ;;
    --no-tunnel) OWNER_DB_TUNNEL=0; shift ;;
    --db-url|--dsn) OWNER_DB_URL="$2"; OWNER_DB_TUNNEL=0; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

require_tools psql python3

# The Ethereum RPC for --chain; printed nowhere, passed to the reader in its environment only.
chain_rpc() {
  if [ -n "${ETH_RPC_URL:-}" ]; then
    printf '%s' "$ETH_RPC_URL"
    return
  fi
  local file="${HARMONY_MIGRATION_REPO:-$HOME/git/harmony-migration}/airdrop/.env" line
  [ -f "$file" ] || return 0
  line="$(grep -E '^RPC_URL=' "$file" | tail -1 || true)"
  printf '%s' "${line#RPC_URL=}" | tr -d "\"'"
}

if [ "$chain" = 1 ]; then
  [ -f "$catalog" ] || die "no vault catalog at $catalog (build it with injector/build_vault_catalog.py, or pass --vault-catalog)"
  rpc="$(chain_rpc)"
  [ -n "$rpc" ] || die "--chain needs ETH_RPC_URL, or RPC_URL in \$HARMONY_MIGRATION_REPO/airdrop/.env"
fi

work="$(mktemp -d)"
trap 'owner_db_close; rm -rf "$work"' EXIT

owner_db_open "$work"
log "querying confirmations, ledger amounts, vault shares, candidates, reviews"
owner_db_extract "$work"

# Close our tunnel before printing so the report is the last thing on screen.
owner_db_close

if [ "$chain" = 1 ]; then
  log "reading the reserve's transfers and vault deposits to these wallets from Ethereum"
  read -r chain_block chain_host < <(ETH_RPC_URL="$rpc" python3 "$here/chain-deliveries.py" \
    --confirmations "$work/confirmations.csv" --catalog "$catalog" --out "$work/deliveries.csv") \
    || die "could not read Ethereum"
  [ -n "${chain_block:-}" ] || die "could not read Ethereum"
  extra+=(--deliveries "$work/deliveries.csv" --chain-source "Ethereum via $chain_host, up to block $chain_block")
fi

python3 "$here/confirmed-wallets.py" \
  --confirmations "$work/confirmations.csv" \
  --vault-shares "$work/vault-shares.csv" \
  --exceptions "$work/exceptions.csv" \
  --candidates "$work/candidates.csv" \
  --reviews "$work/reviews.csv" \
  --ledger-data-version "$OWNER_DB_LEDGER_VERSION" \
  --source "$OWNER_DB_SOURCE" \
  --out-dir "$out_dir" \
  ${extra[@]+"${extra[@]}"}
