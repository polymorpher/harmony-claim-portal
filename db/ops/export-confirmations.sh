#!/usr/bin/env bash
# Export confirmation evidence for offline batch review.
#
#   db/ops/export-confirmations.sh --out data/confirm-export --dsn "$OWNER_DSN"
#
# Writes confirmations.csv, reviews.csv and manifest.json. The manifest hash
# covers the confirmation CSV. Signatures in that CSV are unverified input:
# the batch job must recover each signer before promoting a wallet, using the
# row's signature_scheme (see db/ops/README.md).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# shellcheck source=../../infra/lib.sh
source "$root/infra/lib.sh"

if [ -f "${HCP_ENV_FILE:-$root/.env}" ]; then
  load_env
fi

out=""
dsn="${CONFIRM_OWNER_URL:-${DATABASE_URL:-}}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --dsn) dsn="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$out" ] || die "pass --out"
[ -n "$dsn" ] || die "pass --dsn or set CONFIRM_OWNER_URL"
require_tools psql python3
mkdir -p "$out"

log "exporting confirmations"
psql "$dsn" -v ON_ERROR_STOP=1 <<EOF
\\copy (SELECT id, address, data_version, policy_version, stage_reason, message, signature, signature_scheme, signer, created_at FROM confirm.confirmations ORDER BY created_at, address) TO '${out}/confirmations.csv' WITH (FORMAT csv, HEADER true)
\\copy (SELECT r.id, r.confirmation_id, c.address, c.data_version, r.status, r.batch_id, r.note, r.reviewed_at FROM confirm.reviews r JOIN confirm.confirmations c ON c.id = r.confirmation_id ORDER BY r.reviewed_at, r.id) TO '${out}/reviews.csv' WITH (FORMAT csv, HEADER true)
EOF

python3 - "$out" <<'PY'
import csv, hashlib, json, pathlib, sys
out = pathlib.Path(sys.argv[1])
body = (out / "confirmations.csv").read_bytes()
with (out / "confirmations.csv").open(newline="") as handle:
    rows = max(sum(1 for _ in csv.reader(handle)) - 1, 0)
manifest = {
    "confirmations_sha256": hashlib.sha256(body).hexdigest(),
    "confirmation_rows": rows,
}
(out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps(manifest))
PY
log "wrote $out"
