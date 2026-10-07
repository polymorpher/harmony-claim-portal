#!/usr/bin/env bash
# Who has confirmed: wallets that signed on /confirm, with amounts, signatures
# and review state (approval decision, wallet part sent, vault shares sent).
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
extra=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --csv|--compact) extra+=("$1"); shift ;;
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

work="$(mktemp -d)"
trap 'owner_db_close; rm -rf "$work"' EXIT

owner_db_open "$work"
log "querying confirmations, ledger amounts, vault shares, candidates, reviews"
owner_db_extract "$work"

# Close our tunnel before printing so the report is the last thing on screen.
owner_db_close

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
