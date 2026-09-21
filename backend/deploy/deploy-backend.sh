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
require_vars GCP_PROJECT GCP_ZONE VM_NAME DOMAIN DB_NAME
if [ -n "${CONFIRM_BACKUP_BUCKET:-}" ]; then
  case "$CONFIRM_BACKUP_BUCKET" in
    *[!A-Za-z0-9._-]*) die "CONFIRM_BACKUP_BUCKET has characters this deploy does not accept" ;;
  esac
fi
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
mkdir -p "$stage/app/backend" "$stage/app/shared" "$stage/app/frontend" "$stage/app/db/migrations" "$stage/app/db/seed" "$stage/app/db/ops"
cp -R backend/dist backend/package.json "$stage/app/backend/"
cp -R shared/dist shared/package.json "$stage/app/shared/"
# the lockfile lists every workspace importer; ship the manifest so
# --frozen-lockfile accepts it (the frontend is not installed on the VM)
cp frontend/package.json "$stage/app/frontend/"
cp package.json pnpm-lock.yaml pnpm-workspace.yaml "$stage/app/"
cp db/migrations/*.sql "$stage/app/db/migrations/"
cp db/seed/reason_texts.json db/seed/apply-reason-texts.sh "$stage/app/db/seed/"
cp db/ops/*.sh db/ops/*.sql db/ops/*.py "$stage/app/db/ops/"
cp backend/systemd/*.service backend/systemd/*.timer "$stage/app/"
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

# Owner URL. After setup-roles it lives only in the root-only migrate env.
migrate_env="/etc/harmony-claim-migrate.env"
if [ -f "\$migrate_env" ]; then
  db_url="\$(sudo grep -E '^DATABASE_URL=' "\$migrate_env" | cut -d= -f2- | tr -d '"')"
else
  db_url="\$(sudo grep -E '^DATABASE_URL=' "\$env_file" | cut -d= -f2- | tr -d '"')"
fi
[ -n "\$db_url" ] || { echo "owner DATABASE_URL missing" >&2; exit 1; }

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

echo "saving env and release pointer for rollback"
sudo bash db/ops/env-snapshot.sh save /var/lib/harmony-claim-api/env-backup/"\$release" "\$env_file"
if [ -L "\$app_dir/current" ]; then readlink -f "\$app_dir/current" | sudo tee /var/lib/harmony-claim-api/env-backup/"\$release"/previous-current >/dev/null; fi

echo "splitting database roles"
sudo bash db/ops/setup-roles.sh --vm \
  --db-name "$DB_NAME" \
  --domain "$DOMAIN" \
  --api-env "\$env_file" \
  ${CONFIRM_BACKUP_BUCKET:+--backup-bucket "$CONFIRM_BACKUP_BUCKET"}

sudo install -m 0644 harmony-claim-api.service "/etc/systemd/system/\$service.service"
sudo install -m 0644 harmony-claim-confirm.service /etc/systemd/system/harmony-claim-confirm.service
sudo install -m 0644 harmony-claim-proxy.service /etc/systemd/system/harmony-claim-proxy.service
sudo ln -sfn "\$app_dir/releases/\$release/backend" "\$app_dir/current.new"
sudo mv -Tf "\$app_dir/current.new" "\$app_dir/current"
sudo chown -R "\$app_user:\$app_user" "\$app_dir/releases/\$release"
sudo systemctl daemon-reload
sudo systemctl enable "\$service" harmony-claim-confirm harmony-claim-proxy >/dev/null
sudo systemctl restart "\$service" harmony-claim-confirm
sudo systemctl restart harmony-claim-proxy

for i in \$(seq 1 30); do
  if curl -fsS "http://127.0.0.1:\$port/api/health" >/dev/null 2>&1 \
     && curl -fsS "http://127.0.0.1:8082/api/health" >/dev/null 2>&1; then
    echo "health ok after \$i s"
    break
  fi
  if [ "\$i" -eq 30 ]; then
    echo "health check failed; restoring the previous release and env" >&2
    sudo journalctl -u "\$service" -u harmony-claim-confirm -u harmony-claim-proxy -n 80 --no-pager >&2
    backup="/var/lib/harmony-claim-api/env-backup/\$release"
    sudo bash db/ops/env-snapshot.sh restore "\$backup" "\$env_file"
    if [ -s "\$backup/previous-current" ]; then
      sudo ln -sfn "\$(cat "\$backup/previous-current")" "\$app_dir/current.new"
      sudo mv -Tf "\$app_dir/current.new" "\$app_dir/current"
    fi
    if sudo grep -q '^DATABASE_URL=' "\$env_file"; then
      sudo systemctl disable --now harmony-claim-proxy harmony-claim-confirm >/dev/null 2>&1 || true
      sudo systemctl restart "\$service" || true
    else
      sudo systemctl restart "\$service" harmony-claim-confirm harmony-claim-proxy || true
    fi
    exit 1
  fi
  sleep 1
done

sudo mkdir -p /usr/local/lib/harmony-claim-portal /var/lib/harmony-claim-api/backups
sudo install -m 0755 db/ops/backup-confirm.sh /usr/local/lib/harmony-claim-portal/backup-confirm.sh
sudo install -m 0644 harmony-claim-backup.service harmony-claim-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now harmony-claim-backup.timer >/dev/null

# keep the five most recent releases
ls -1dt "\$app_dir"/releases/* | tail -n +6 | xargs -r sudo rm -rf
echo "deployed \$release"
EOF
)

vm_ssh "$remote_script"
log "done: release $release is live on $VM_NAME"
