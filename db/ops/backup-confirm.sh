#!/usr/bin/env bash
# Back up schema confirm. Claim tables can be rebuilt from harmony-migration;
# signed confirmations cannot.
#
#   db/ops/backup-confirm.sh --dsn "$OWNER_DSN"
#   CONFIRM_BACKUP_BUCKET=my-private-bucket db/ops/backup-confirm.sh --dsn "$OWNER_DSN"
#
# Writes a custom-format dump under data/confirm-backups (gitignored) unless
# --out is set. When CONFIRM_BACKUP_BUCKET is set, uploads the dump there.
# The bucket must not be public. This script does not change bucket IAM.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
if [ -f "$root/infra/lib.sh" ]; then
  # shellcheck source=../../infra/lib.sh
  source "$root/infra/lib.sh"
  if [ -f "${HCP_ENV_FILE:-$root/.env}" ]; then
    load_env
  fi
else
  log() { printf '==> %s\n' "$*" >&2; }
  die() { printf 'error: %s\n' "$*" >&2; exit 1; }
  require_tools() {
    local t
    for t in "$@"; do
      command -v "$t" >/dev/null 2>&1 || die "required tool not found: $t"
    done
  }
fi

dsn="${CONFIRM_OWNER_URL:-${DATABASE_URL:-}}"
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dsn) dsn="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$dsn" ] || die "pass --dsn or set CONFIRM_OWNER_URL"
require_tools pg_dump python3
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [ -z "$out" ]; then
  if [ -d /var/lib/harmony-claim-api ]; then
    base=/var/lib/harmony-claim-api/backups
  else
    base="$root/data/confirm-backups"
  fi
  mkdir -p "$base"
  out="$base/confirm-$stamp.dump"
else
  base="$(dirname "$out")"
  mkdir -p "$base"
fi

log "dumping schema confirm"
pg_dump "$dsn" --schema=confirm --format=custom --no-owner --file="$out"
chmod 600 "$out"
log "wrote $out"
shopt -s nullglob
dumps=("$base"/confirm-*.dump)
if [ "${#dumps[@]}" -gt 14 ]; then
  while IFS= read -r old; do
    rm -f "$old"
  done < <(python3 -c 'import os, sys
files = sys.argv[1:]
files.sort(key=lambda path: os.stat(path).st_mtime)
for path in files[:-14]:
    print(path)' "${dumps[@]}")
fi

if [ -n "${CONFIRM_BACKUP_BUCKET:-}" ]; then
  require_tools gcloud
  dest="gs://${CONFIRM_BACKUP_BUCKET}/confirm/confirm-$stamp.dump"
  log "uploading to $dest"
  if [ -n "${GCP_PROJECT:-}" ]; then
    gcloud --project "$GCP_PROJECT" storage cp "$out" "$dest" >/dev/null
  else
    gcloud storage cp "$out" "$dest" >/dev/null
  fi
  log "uploaded $dest"
fi
