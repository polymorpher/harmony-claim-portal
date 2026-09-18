#!/usr/bin/env bash
# Build the API locally, ship it to the VM over IAP, apply pending SQL
# migrations, seed reason texts, restart the systemd unit and health-check.
#
#   backend/deploy/deploy-backend.sh
#
# Requires: the VM from infra/gcp/10-create-vm.sh with bootstrap finished
# (it created $APP_USER, $APP_DIR, $APP_ENV_FILE and installed the unit).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../infra/lib.sh
source "$here/../../infra/lib.sh"
load_env
set_defaults
require_vars GCP_PROJECT GCP_ZONE VM_NAME
require_tools gcloud pnpm tar

cd "$REPO_ROOT"

log "building shared + backend"
pnpm install --frozen-lockfile
pnpm --filter @hcp/shared build
pnpm --filter @hcp/backend build

release="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

log "staging release $release"
mkdir -p "$stage/app/backend" "$stage/app/shared" "$stage/app/frontend" "$stage/app/db/migrations" "$stage/app/db/seed"
cp -R backend/dist backend/package.json "$stage/app/backend/"
cp -R shared/dist shared/package.json "$stage/app/shared/"
# the lockfile lists every workspace importer; ship the manifest so
# --frozen-lockfile accepts it (the frontend is not installed on the VM)
cp frontend/package.json "$stage/app/frontend/"
cp package.json pnpm-lock.yaml pnpm-workspace.yaml "$stage/app/"
cp db/migrations/*.sql "$stage/app/db/migrations/"
cp db/seed/reason_texts.json db/seed/apply-reason-texts.sh "$stage/app/db/seed/"
cp backend/systemd/harmony-claim-api.service "$stage/app/"
tar -C "$stage/app" -czf "$stage/release.tgz" .

log "uploading to $VM_NAME"
vm_scp "$stage/release.tgz" "$VM_NAME:/tmp/harmony-claim-api-$release.tgz"

remote_script=$(cat <<EOF
set -euo pipefail
release="$release"
app_dir="$APP_DIR"
env_file="$APP_ENV_FILE"
app_user="$APP_USER"
service="$SERVICE_NAME"
port="$API_PORT"

sudo mkdir -p "\$app_dir/releases/\$release"
sudo tar -C "\$app_dir/releases/\$release" -xzf "/tmp/harmony-claim-api-\$release.tgz"
rm -f "/tmp/harmony-claim-api-\$release.tgz"
cd "\$app_dir/releases/\$release"

# production dependencies only; workspace packages resolve via the lockfile
sudo chown -R "\$app_user:\$app_user" "\$app_dir/releases/\$release"
sudo -u "\$app_user" -H env HOME="\$app_dir/home" PATH="/usr/local/bin:/usr/bin:/bin" \
  pnpm install --prod --frozen-lockfile --filter @hcp/backend --filter @hcp/shared

# database url from the env file written by the bootstrap script
db_url="\$(sudo grep -E '^DATABASE_URL=' "\$env_file" | cut -d= -f2- | tr -d '"')"
[ -n "\$db_url" ] || { echo "DATABASE_URL missing from \$env_file" >&2; exit 1; }

echo "applying migrations"
for f in db/migrations/*.sql; do
  version="\$(basename "\$f" .sql)"
  applied="\$(psql "\$db_url" -tAc "select 1 from schema_migrations where version='\$version'" 2>/dev/null || true)"
  if [ "\$applied" = "1" ]; then
    echo "  \$version: already applied"
  else
    echo "  \$version: applying"
    psql "\$db_url" -v ON_ERROR_STOP=1 -q -f "\$f"
  fi
done
DATABASE_URL="\$db_url" bash db/seed/apply-reason-texts.sh

sudo install -m 0644 harmony-claim-api.service "/etc/systemd/system/\$service.service"
sudo ln -sfn "\$app_dir/releases/\$release/backend" "\$app_dir/current.new"
sudo mv -Tf "\$app_dir/current.new" "\$app_dir/current"
sudo chown -R "\$app_user:\$app_user" "\$app_dir/releases/\$release"
sudo systemctl daemon-reload
sudo systemctl enable "\$service" >/dev/null
sudo systemctl restart "\$service"

for i in \$(seq 1 30); do
  if curl -fsS "http://127.0.0.1:\$port/api/health" >/dev/null 2>&1; then
    echo "health ok after \$i s"
    break
  fi
  if [ "\$i" -eq 30 ]; then
    echo "health check failed" >&2
    sudo journalctl -u "\$service" -n 50 --no-pager >&2
    exit 1
  fi
  sleep 1
done

# keep the five most recent releases
ls -1dt "\$app_dir"/releases/* | tail -n +6 | xargs -r sudo rm -rf
echo "deployed \$release"
EOF
)

vm_ssh "$remote_script"
log "done: release $release is live on $VM_NAME"
