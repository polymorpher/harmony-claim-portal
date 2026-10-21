#!/usr/bin/env bash
# Raise Node on the VM to NODE_MIN_VERSION without shipping a release, then
# restart the units still running the replaced binary and health-check.
# For Node security releases between deploys.
#
#   backend/deploy/upgrade-node.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../infra/lib.sh
source "$here/../../infra/lib.sh"
load_env
set_defaults
require_vars GCP_PROJECT GCP_ZONE VM_NAME
require_tools gcloud
node_floor="$(vm_node_floor_script)"

remote_script=$(cat <<EOF
set -euo pipefail
$node_floor

node_bin="\$(readlink -f /usr/bin/node)"
stale=()
for unit in $SERVICE_NAME harmony-claim-confirm harmony-claim-proxy; do
  pid="\$(systemctl show -p MainPID --value "\$unit")"
  if [ "\$pid" != 0 ] && [ "\$(sudo readlink "/proc/\$pid/exe")" != "\$node_bin" ]; then stale+=("\$unit"); fi
done
if [ "\${#stale[@]}" -eq 0 ]; then
  echo "every running unit already uses \$node_bin"
else
  echo "restarting \${stale[*]}"
  sudo systemctl restart "\${stale[@]}"
fi

for i in \$(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1 \
     && curl -fsS "http://127.0.0.1:8082/api/health" >/dev/null 2>&1; then
    echo "health ok after \$i s"
    exit 0
  fi
  sleep 1
done
echo "health check failed" >&2
sudo journalctl -u $SERVICE_NAME -u harmony-claim-confirm -u harmony-claim-proxy -n 80 --no-pager >&2
exit 1
EOF
)

log "checking Node on $VM_NAME (floor $NODE_MIN_VERSION)"
vm_ssh "$remote_script"
log "done"
