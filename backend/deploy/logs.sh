#!/usr/bin/env bash
# Tail the API's journal on the VM through IAP.
#   backend/deploy/logs.sh [-n 200] [--since "1 hour ago"]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../infra/lib.sh
source "$here/../../infra/lib.sh"
load_env
set_defaults
require_vars GCP_PROJECT GCP_ZONE VM_NAME
require_tools gcloud

args="-n 100"
if [ "$#" -gt 0 ]; then args="$*"; fi
exec gcloud --project "$GCP_PROJECT" --quiet compute ssh "$VM_NAME" --zone "$GCP_ZONE" --tunnel-through-iap \
  --command "sudo journalctl -u $SERVICE_NAME -f --no-pager $args"
