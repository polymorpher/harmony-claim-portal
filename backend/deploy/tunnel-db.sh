#!/usr/bin/env bash
# Open an IAP SSH tunnel: localhost:$DB_TUNNEL_PORT -> VM:5432 (PostgreSQL is
# bound to localhost on the VM). Keep this running while the injector loads.
#
#   backend/deploy/tunnel-db.sh
#   PGPASSWORD=... python3 injector/inject_claims.py --dsn postgres://claimapi@localhost:5433/claims ...
#
# The claimapi password lives in /etc/harmony-claim-api.env on the VM:
#   backend/deploy/tunnel-db.sh --print-dsn
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../infra/lib.sh
source "$here/../../infra/lib.sh"
load_env
set_defaults
require_vars GCP_PROJECT GCP_ZONE VM_NAME DB_TUNNEL_PORT DB_NAME
require_tools gcloud

if [ "${1:-}" = "--print-dsn" ]; then
  url="$(vm_ssh "sudo grep -E '^DATABASE_URL=' $APP_ENV_FILE | cut -d= -f2- | tr -d '\"'")"
  # rewrite host/port for the tunnel
  echo "$url" | sed -E "s#@[^/]+/#@localhost:${DB_TUNNEL_PORT}/#"
  exit 0
fi

log "tunnel localhost:$DB_TUNNEL_PORT -> $VM_NAME:5432 (Ctrl-C to close)"
exec gcloud --project "$GCP_PROJECT" --quiet compute ssh "$VM_NAME" --zone "$GCP_ZONE" --tunnel-through-iap \
  -- -N -L "${DB_TUNNEL_PORT}:127.0.0.1:5432" -o ExitOnForwardFailure=yes -o ServerAliveInterval=30
