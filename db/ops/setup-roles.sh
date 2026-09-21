#!/usr/bin/env bash
# Create claim_read and claim_confirm, grant least privilege, and split the
# database URLs so the API processes never receive the owner password.
#
#   db/ops/setup-roles.sh --local
#   sudo db/ops/setup-roles.sh --vm --db-name claims --domain migrate.country
#
# --local writes backend/.env.read and backend/.env.confirm (gitignored) for
# the dev Postgres from scripts/dev-postgres.sh.
# --vm writes /etc/harmony-claim-migrate.env (root:root, mode 600),
# /etc/harmony-claim-api.env (lookup, no owner URL) and
# /etc/harmony-claim-confirm.env. Passwords are generated on this host and are
# not printed. Re-running keeps an existing password when its env file is still
# present.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

mode=""
db_name="${DB_NAME:-claims}"
domain="${CONFIRM_DOMAIN:-${DOMAIN:-migrate.country}}"
api_env="${APP_ENV_FILE:-/etc/harmony-claim-api.env}"
migrate_env="${MIGRATE_ENV_FILE:-/etc/harmony-claim-migrate.env}"
confirm_env="${CONFIRM_ENV_FILE:-/etc/harmony-claim-confirm.env}"
rate_max="${RATE_LIMIT_MAX:-30}"
rate_window="${RATE_LIMIT_WINDOW:-1 minute}"
confirm_rate="${CONFIRM_RATE_LIMIT_MAX:-10}"
ttl="${CHALLENGE_TTL_SECONDS:-600}"
expose="${EXPOSE_CONTRACT_AMOUNTS:-false}"
backup_bucket="${CONFIRM_BACKUP_BUCKET:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --local|--vm) mode="${1#--}"; shift ;;
    --db-name) db_name="$2"; shift 2 ;;
    --domain) domain="$2"; shift 2 ;;
    --api-env) api_env="$2"; shift 2 ;;
    --migrate-env) migrate_env="$2"; shift 2 ;;
    --confirm-env) confirm_env="$2"; shift 2 ;;
    --backup-bucket) backup_bucket="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ -n "$mode" ] || { echo "pass --local or --vm" >&2; exit 1; }
if [ -n "$backup_bucket" ]; then
  case "$backup_bucket" in
    *[!A-Za-z0-9._-]*) echo "invalid backup bucket name" >&2; exit 1 ;;
  esac
fi
case "$db_name" in
  ''|*[!A-Za-z0-9_]*) echo "invalid database name" >&2; exit 1 ;;
esac
case "$domain" in
  ''|*[!A-Za-z0-9.-]*) echo "invalid domain" >&2; exit 1 ;;
esac

sql_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"
}

run_psql() {
  if [ "$mode" = "local" ]; then
    psql -h localhost -p "${DEV_PGPORT:-5434}" -U postgres -d "$db_name" -v ON_ERROR_STOP=1 "$@"
  else
    sudo -u postgres psql -d "$db_name" -v ON_ERROR_STOP=1 "$@"
  fi
}

role_exists() {
  run_psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$1'" | grep -q 1
}

password_from_url() {
  python3 -c 'import sys; from urllib.parse import urlparse, unquote
u = urlparse(sys.argv[1])
if not u.password: raise SystemExit(2)
sys.stdout.write(unquote(u.password))' "$1"
}

env_value() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" | head -1 | cut -d= -f2- | tr -d '"'
}

ensure_password() {
  # $1 role, $2 existing url or empty. Prints the password to stdout.
  local existing="$2"
  if [ -n "$existing" ]; then
    password_from_url "$existing"
    return
  fi
  openssl rand -hex 24
}

set_password() {
  local role="$1" password="$2" quoted verb
  quoted="$(sql_quote "$password")"
  if role_exists "$role"; then verb="ALTER"; else verb="CREATE"; fi
  run_psql <<SQL
${verb} ROLE ${role} WITH LOGIN PASSWORD ${quoted} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
SQL
}

if [ "$mode" = "vm" ]; then
  id -u claimconfirm >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin claimconfirm
  id -u claimproxy >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin claimproxy
fi

if ! role_exists claimapi; then
  if [ "$mode" = "local" ]; then
    run_psql -c "CREATE ROLE claimapi WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"
  else
    echo "role claimapi is missing; bootstrap the database before setup-roles" >&2
    exit 1
  fi
fi

owner_url="$(env_value "$migrate_env" DATABASE_URL)"
if [ -z "$owner_url" ]; then
  owner_url="$(env_value "$api_env" DATABASE_URL)"
fi
if [ "$mode" = "local" ]; then
  owner_password="$(openssl rand -hex 24)"
  set_password claimapi "$owner_password"
  owner_url="postgres://claimapi:${owner_password}@127.0.0.1:${DEV_PGPORT:-5434}/${db_name}"
else
  [ -n "$owner_url" ] || { echo "owner DATABASE_URL not found in $migrate_env or $api_env" >&2; exit 1; }
fi

if [ -f "$api_env" ]; then
  prev_rate="$(env_value "$api_env" RATE_LIMIT_MAX)"
  prev_window="$(env_value "$api_env" RATE_LIMIT_WINDOW)"
  prev_expose="$(env_value "$api_env" EXPOSE_CONTRACT_AMOUNTS)"
  [ -n "$prev_rate" ] && rate_max="$prev_rate"
  [ -n "$prev_window" ] && rate_window="$prev_window"
  [ -n "$prev_expose" ] && expose="$prev_expose"
fi

read_url="$(env_value "$api_env" CLAIM_READ_URL)"
confirm_url="$(env_value "$confirm_env" CONFIRM_DATABASE_URL)"
read_password="$(ensure_password claim_read "$read_url")"
confirm_password="$(ensure_password claim_confirm "$confirm_url")"
set_password claim_read "$read_password"
set_password claim_confirm "$confirm_password"

if [ "$mode" = "local" ]; then
  read_url="postgres://claim_read:${read_password}@127.0.0.1:${DEV_PGPORT:-5434}/${db_name}"
  confirm_url="postgres://claim_confirm:${confirm_password}@127.0.0.1:${DEV_PGPORT:-5434}/${db_name}"
else
  read_url="postgres://claim_read:${read_password}@127.0.0.1:5432/${db_name}"
  confirm_url="postgres://claim_confirm:${confirm_password}@127.0.0.1:5432/${db_name}"
fi

run_psql -f "$here/grants.sql"
if [ "$mode" = "local" ]; then
  run_psql -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT SELECT ON TABLES TO claim_read"
fi

write_env() {
  local path="$1" modebits="$2" owner="$3" group="$4" contents="$5"
  local tmp
  tmp="$(mktemp)"
  printf '%s\n' "$contents" >"$tmp"
  if [ "$mode" = "vm" ]; then
    install -o "$owner" -g "$group" -m "$modebits" "$tmp" "$path"
  else
    install -m 600 "$tmp" "$path"
  fi
  rm -f "$tmp"
}

read_body="CLAIM_READ_URL=${read_url}
PORT=8081
HOST=127.0.0.1
RATE_LIMIT_MAX=${rate_max}
RATE_LIMIT_WINDOW=\"${rate_window}\"
EXPOSE_CONTRACT_AMOUNTS=${expose}
LOG_LEVEL=info
TRUST_PROXY=true
ENFORCE_DB_PRIVILEGES=true
NODE_ENV=production"

confirm_body="CONFIRM_DATABASE_URL=${confirm_url}
PORT=8082
HOST=127.0.0.1
CONFIRM_DOMAIN=${domain}
CHALLENGE_TTL_SECONDS=${ttl}
CONFIRM_RATE_LIMIT_MAX=${confirm_rate}
RATE_LIMIT_WINDOW=\"${rate_window}\"
LOG_LEVEL=info
TRUST_PROXY=true
ENFORCE_DB_PRIVILEGES=true
NODE_ENV=production"

if [ "$mode" = "vm" ] && [ -f "$api_env" ] && grep -q '^DATABASE_URL=' "$api_env" && [ ! -f "${api_env}.pre-split" ]; then
  install -o root -g root -m 600 "$api_env" "${api_env}.pre-split"
  echo "saved ${api_env}.pre-split (original lookup env, before the role split)"
fi

# Rotate only after grants succeed and the pre-split copy exists, and write the
# new password down as the next step. A failure before this leaves the old
# password working; a failure after it leaves the new one in the migrate env.
if [ "$mode" = "vm" ] && [ -f "$api_env" ] && grep -q '^DATABASE_URL=' "$api_env"; then
  owner_password="$(openssl rand -hex 24)"
  set_password claimapi "$owner_password"
  owner_url="postgres://claimapi:${owner_password}@127.0.0.1:5432/${db_name}"
  echo "rotated the owner database password for the role split"
fi

owner_body="DATABASE_URL=${owner_url}"
if [ -n "$backup_bucket" ]; then
  owner_body="${owner_body}
CONFIRM_BACKUP_BUCKET=${backup_bucket}"
fi

if [ "$mode" = "vm" ]; then
  write_env "$migrate_env" 600 root root "$owner_body"
  write_env "$api_env" 640 root claimapi "$read_body"
  write_env "$confirm_env" 640 root claimconfirm "$confirm_body"
  if grep -q '^DATABASE_URL=' "$api_env" || grep -q 'claimapi:' "$api_env"; then
    echo "lookup env still contains the owner credential" >&2
    exit 1
  fi
  if grep -q 'claimapi:' "$confirm_env" || grep -q 'CLAIM_READ_URL=' "$confirm_env"; then
    echo "confirm env contains a lookup or owner credential" >&2
    exit 1
  fi
else
  mkdir -p "$root/backend"
  write_env "$root/backend/.env.read" 600 "" "" "$read_body"
  write_env "$root/backend/.env.confirm" 600 "" "" "$confirm_body"
  write_env "$root/backend/.env.owner" 600 "" "" "$owner_body"
  echo "wrote backend/.env.read, backend/.env.confirm and backend/.env.owner"
fi

echo "roles claim_read and claim_confirm are granted"
