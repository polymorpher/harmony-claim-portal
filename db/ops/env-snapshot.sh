#!/usr/bin/env bash
# Save or restore deploy env files without leaving them readable by the API users.
#
#   env-snapshot.sh save    <dir> <api-env>
#   env-snapshot.sh restore <dir> <api-env>
#
# Snapshots are root:root mode 600. Restore puts the lookup and confirmation
# files back on the groups those services can read. If the restored lookup env
# still contains an owner URL, that URL is replaced with the one in the migrate
# env, because the role split rotates the owner password.
set -euo pipefail

cmd="${1:-}"
dir="${2:-}"
api_env="${3:-}"
[ -n "$cmd" ] && [ -n "$dir" ] && [ -n "$api_env" ] || {
  echo "usage: $0 save|restore <dir> <api-env>" >&2
  exit 1
}

save_one() {
  local src="$1" dest="$2"
  if [ -f "$src" ]; then
    install -o root -g root -m 600 "$src" "$dest"
  fi
}

case "$cmd" in
  save)
    mkdir -p "$dir"
    chmod 700 "$(dirname "$dir")" "$dir"
    save_one "$api_env" "$dir/api.env"
    save_one /etc/harmony-claim-migrate.env "$dir/migrate.env"
    save_one /etc/harmony-claim-confirm.env "$dir/confirm.env"
    ;;
  restore)
    if [ -f "$dir/api.env" ]; then
      install -o root -g claimapi -m 640 "$dir/api.env" "$api_env"
    fi
    if [ -f "$dir/migrate.env" ]; then
      install -o root -g root -m 600 "$dir/migrate.env" /etc/harmony-claim-migrate.env
    fi
    if [ -f "$dir/confirm.env" ]; then
      install -o root -g claimconfirm -m 640 "$dir/confirm.env" /etc/harmony-claim-confirm.env
    fi
    python3 - "$api_env" /etc/harmony-claim-migrate.env <<'PY'
import sys
from pathlib import Path
api = Path(sys.argv[1])
migrate = Path(sys.argv[2])
if not api.exists() or not migrate.exists():
    raise SystemExit(0)
lines = api.read_text().splitlines()
if not any(line.startswith("DATABASE_URL=") for line in lines):
    raise SystemExit(0)
owner = next((line for line in migrate.read_text().splitlines() if line.startswith("DATABASE_URL=")), "")
if not owner:
    raise SystemExit(0)
api.write_text("\n".join(owner if line.startswith("DATABASE_URL=") else line for line in lines) + "\n")
PY
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
