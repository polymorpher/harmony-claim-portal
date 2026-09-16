#!/usr/bin/env bash
# Upsert db/seed/reason_texts.json into the reason_texts table.
# usage: db/seed/apply-reason-texts.sh <dsn>   (or set DATABASE_URL)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dsn="${1:-${DATABASE_URL:-}}"
if [ -z "$dsn" ]; then
  echo "usage: $0 <postgres dsn>  (or export DATABASE_URL)" >&2
  exit 1
fi
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v psql >/dev/null || { echo "psql is required" >&2; exit 1; }

json="$(jq -c . "$here/reason_texts.json")"
psql "$dsn" -v ON_ERROR_STOP=1 -q -v json="$json" <<'SQL'
INSERT INTO reason_texts (reason_code, title, user_text)
SELECT key, value->>'title', value->>'user_text'
FROM jsonb_each(:'json'::jsonb)
ON CONFLICT (reason_code) DO UPDATE
  SET title = EXCLUDED.title, user_text = EXCLUDED.user_text;
SQL
echo "reason_texts seeded: $(jq 'length' "$here/reason_texts.json") rows"
