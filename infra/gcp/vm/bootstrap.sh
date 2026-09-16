#!/usr/bin/env bash
# GCE startup script for the API/DB VM (Debian 12). Runs as root on every boot;
# every step is idempotent and the marker file short-circuits reruns.
# Configuration comes from instance metadata set by 10-create-vm.sh.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

md() {
  curl -fsS -H 'Metadata-Flavor: Google' \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || echo "$2"
}

PG_MAJOR="$(md pg-major 18)"
NODE_MAJOR="$(md node-major 22)"
DB_NAME="$(md db-name claims)"
DB_USER="$(md db-user claimapi)"
API_PORT="$(md api-port 8080)"
APP_USER="$(md app-user claimapi)"
APP_DIR="$(md app-dir /opt/harmony-claim-api)"
APP_ENV_FILE="$(md app-env-file /etc/harmony-claim-api.env)"
SERVICE_NAME="$(md service-name harmony-claim-api)"
STATE_DIR=/var/lib/harmony-claim-api
MARKER="$STATE_DIR/bootstrap.done"

mkdir -p "$STATE_DIR"
if [ -f "$MARKER" ]; then
  echo "bootstrap already completed; nothing to do"
  exit 0
fi

echo "== base packages"
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg lsb-release apt-transport-https unattended-upgrades \
  jq git tar openssl

echo "== unattended upgrades"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

echo "== PostgreSQL $PG_MAJOR (PGDG)"
install -d /usr/share/postgresql-common/pgdg
if [ ! -f /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc ]; then
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
fi
codename="$(lsb_release -cs)"
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${codename}-pgdg main" \
  >/etc/apt/sources.list.d/pgdg.list
apt-get update -y
apt-get install -y "postgresql-${PG_MAJOR}" "postgresql-client-${PG_MAJOR}"

pg_conf="/etc/postgresql/${PG_MAJOR}/main/postgresql.conf"
sed -i "s/^#\?listen_addresses.*/listen_addresses = 'localhost'/" "$pg_conf"
# modest tuning for e2-medium (4 GB): the API runs small point lookups
cat >"/etc/postgresql/${PG_MAJOR}/main/conf.d/claim-portal.conf" <<'EOF'
shared_buffers = 512MB
effective_cache_size = 2GB
work_mem = 16MB
maintenance_work_mem = 256MB
max_connections = 50
log_min_duration_statement = 500
EOF
systemctl enable postgresql
systemctl restart postgresql

echo "== database role and database"
if [ -f "$APP_ENV_FILE" ] && grep -q '^DATABASE_URL=' "$APP_ENV_FILE"; then
  db_password="$(grep '^DATABASE_URL=' "$APP_ENV_FILE" | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#')"
else
  db_password="$(openssl rand -hex 24)"
fi
su - postgres -c "psql -v ON_ERROR_STOP=1 -tAc \"select 1 from pg_roles where rolname='${DB_USER}'\"" | grep -q 1 || \
  su - postgres -c "psql -v ON_ERROR_STOP=1 -c \"create role ${DB_USER} login password '${db_password}'\""
su - postgres -c "psql -v ON_ERROR_STOP=1 -c \"alter role ${DB_USER} with password '${db_password}'\""
su - postgres -c "psql -v ON_ERROR_STOP=1 -tAc \"select 1 from pg_database where datname='${DB_NAME}'\"" | grep -q 1 || \
  su - postgres -c "createdb -O ${DB_USER} ${DB_NAME}"

echo "== Node.js $NODE_MAJOR (NodeSource) + pnpm"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
# major must match the lockfile written by the workspace's packageManager (pnpm 12)
if ! command -v pnpm >/dev/null 2>&1 || [ "$(pnpm --version | cut -d. -f1)" != "12" ]; then
  npm install -g pnpm@12
fi
ln -sfn "$(command -v pnpm)" /usr/local/bin/pnpm

echo "== application user and directories"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR/home" --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/releases" "$APP_DIR/home"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "== runtime environment file"
umask 077
cat >"$APP_ENV_FILE" <<EOF
DATABASE_URL=postgres://${DB_USER}:${db_password}@127.0.0.1:5432/${DB_NAME}
PORT=${API_PORT}
HOST=0.0.0.0
RATE_LIMIT_MAX=30
RATE_LIMIT_WINDOW=1 minute
EXPOSE_CONTRACT_AMOUNTS=false
LOG_LEVEL=info
TRUST_PROXY=true
EOF
chown root:"$APP_USER" "$APP_ENV_FILE"
chmod 0640 "$APP_ENV_FILE"
umask 022

echo "== systemd unit placeholder"
# The real unit is installed by backend/deploy/deploy-backend.sh; a placeholder
# keeps `systemctl enable` valid before the first deploy.
if [ ! -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
  cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Harmony claim portal lookup API (awaiting first deploy)
After=network-online.target postgresql.service

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
EnvironmentFile=${APP_ENV_FILE}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node ${APP_DIR}/current/dist/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
fi

echo "== local firewall hygiene: nothing else listens publicly"
ss -ltnp | grep -E ':(5432|'"$API_PORT"')\b' || true

date -u +%Y-%m-%dT%H:%M:%SZ >"$MARKER"
echo "bootstrap complete"
