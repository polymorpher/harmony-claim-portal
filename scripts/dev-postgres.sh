#!/usr/bin/env bash
# Run a user-owned PostgreSQL 18 cluster for local development and injector
# tests. Initialises its own data directory so it does not depend on a
# system-wide Postgres, and listens on a separate port.
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/bin}"
DATA="${DEV_PGDATA:-$HOME/.local/share/harmony-claim-portal/pgdata}"
PORT="${DEV_PGPORT:-5434}"
LOG="$DATA/server.log"
export PATH="$PGBIN:$PATH"

usage() {
  cat <<EOF
usage: $0 <command>

  init            create the data directory if it does not exist
  start           init if needed, then start the server on port $PORT
  stop            stop the server
  status          show server status
  createdb NAME   create a database (default: claims)
  psql [ARGS]     open psql against the dev server
  url [NAME]      print the connection URL (default database: claims)

environment: DEV_PGDATA=$DATA DEV_PGPORT=$PORT PGBIN=$PGBIN
EOF
}

init() {
  if [ -f "$DATA/PG_VERSION" ]; then
    return
  fi
  mkdir -p "$DATA"
  initdb -D "$DATA" -U postgres --auth=trust --encoding=UTF8 >/dev/null
  {
    echo "port = $PORT"
    echo "listen_addresses = 'localhost'"
    echo "unix_socket_directories = '$DATA'"
    echo "log_min_messages = warning"
  } >>"$DATA/postgresql.conf"
  echo "initialised $DATA"
}

case "${1:-}" in
  init) init ;;
  start)
    init
    if pg_ctl -D "$DATA" status >/dev/null 2>&1; then
      echo "already running on port $PORT"
    else
      pg_ctl -D "$DATA" -l "$LOG" -w start
    fi
    ;;
  stop) pg_ctl -D "$DATA" -m fast stop ;;
  status) pg_ctl -D "$DATA" status ;;
  createdb)
    name="${2:-claims}"
    if psql -h localhost -p "$PORT" -U postgres -tAc "select 1 from pg_database where datname='$name'" | grep -q 1; then
      echo "database $name exists"
    else
      createdb -h localhost -p "$PORT" -U postgres "$name"
      echo "created database $name"
    fi
    ;;
  psql) shift; exec psql -h localhost -p "$PORT" -U postgres "$@" ;;
  url) echo "postgres://postgres@localhost:$PORT/${2:-claims}" ;;
  *) usage; exit 1 ;;
esac
