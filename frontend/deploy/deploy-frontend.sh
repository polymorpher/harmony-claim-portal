#!/usr/bin/env bash
# Build the SPA and publish it to the frontend bucket behind the load balancer.
#   frontend/deploy/deploy-frontend.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../infra/lib.sh
source "$here/../../infra/lib.sh"
load_env
set_defaults
require_vars GCP_PROJECT FRONTEND_BUCKET URL_MAP
require_tools gcloud pnpm

cd "$REPO_ROOT"
bucket="gs://$FRONTEND_BUCKET"

log "building frontend"
pnpm install --frozen-lockfile
pnpm --filter @hcp/shared build
[ -z "${VITE_BRIDGE_PROOFS_URL:-}" ] || die "VITE_BRIDGE_PROOFS_URL is for development; the site reads proofs from the published run"
VITE_WALLETCONNECT_PROJECT_ID="${VITE_WALLETCONNECT_PROJECT_ID:-}" \
  VITE_ETH_RPC_URLS="${VITE_ETH_RPC_URLS:-}" \
  VITE_BSC_RPC_URLS="${VITE_BSC_RPC_URLS:-}" \
  VITE_ARBITRUM_RPC_URLS="${VITE_ARBITRUM_RPC_URLS:-}" \
  VITE_BASE_RPC_URLS="${VITE_BASE_RPC_URLS:-}" \
  VITE_LINEA_RPC_URLS="${VITE_LINEA_RPC_URLS:-}" \
  pnpm --filter @hcp/frontend build
[ -f frontend/dist/index.html ] || die "frontend/dist/index.html missing after build"
# Only the mainnet catalog is published; rehearsal catalogs stay local.
rm -f frontend/dist/vault-catalog.*.json
# /confirm, /vault, /vault/<address>, /history, /ledger and /bridge must be real
# objects. The bucket error page serves index.html with HTTP 404, which a CDN
# can cache. History records are linked as /history?address=... or
# /history?tx=..., and bridge lookups as /bridge?address=..., so one object
# covers each.
pages=(confirm vault history ledger bridge)
for page in "${pages[@]}"; do
  mkdir -p "frontend/dist/$page"
  cp frontend/dist/index.html "frontend/dist/$page/index.html"
done
[ -f frontend/dist/ledger-key-tool.html ] && [ -f frontend/dist/ledger-key-tool.html.sha256 ] \
  || die "frontend/dist/ledger-key-tool.html or its .sha256 is missing after build"
if [ -f frontend/dist/vault-catalog.json ]; then
  # Checksummed names only: the page links to them, and a case-insensitive
  # filesystem cannot hold both spellings. Other spellings fall back to the
  # error page, which still renders the app.
  python3 - frontend/dist/vault-catalog.json frontend/dist/index.html frontend/dist/vault <<'PY'
import json, shutil, sys
catalog, index, out = sys.argv[1:]
for v in json.load(open(catalog, encoding="utf-8"))["vaults"]:
    shutil.copyfile(index, f"{out}/{v['vault']}")
PY
else
  warn "frontend/public/vault-catalog.json is missing; /vault will say the vault list could not be loaded"
  warn "build it with: python3 injector/build_vault_catalog.py --migration-repo ~/git/harmony-migration"
fi

log "syncing frontend/dist -> $bucket"
gc storage rsync frontend/dist "$bucket" --recursive --delete-unmatched-destination-objects
# A destination of gs://bucket/confirm is treated as the confirm/ prefix once
# confirm/index.html exists, so each page's object name has to be set explicitly.
token="$(gcloud auth print-access-token)"
for page in "${pages[@]}"; do
  curl -fsS -X POST \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: text/html" \
    -H "Cache-Control: no-cache" \
    --data-binary @frontend/dist/index.html \
    "https://storage.googleapis.com/upload/storage/v1/b/${FRONTEND_BUCKET}/o?uploadType=media&name=${page}" \
    >/dev/null
  curl -fsS -X PATCH \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    --data '{"cacheControl":"no-cache","contentType":"text/html"}' \
    "https://storage.googleapis.com/storage/v1/b/${FRONTEND_BUCKET}/o/${page}" \
    >/dev/null
done

log "setting cache-control"
# hashed assets are immutable; html must always be revalidated
gc storage objects update "$bucket/assets/**" \
  --cache-control="public,max-age=31536000,immutable" >/dev/null || true
gc storage objects update "$bucket/index.html" \
  --cache-control="no-cache" >/dev/null
for page in confirm history ledger bridge; do
  gc storage objects update "$bucket/$page/index.html" \
    --content-type="text/html" --cache-control="no-cache" >/dev/null
done
# The offline key tool and the hash /ledger shows for it must always match.
gc storage objects update "$bucket/ledger-key-tool.html" \
  --content-type="text/html" --cache-control="no-cache" >/dev/null
gc storage objects update "$bucket/ledger-key-tool.html.sha256" \
  --content-type="text/plain" --cache-control="no-cache" >/dev/null
# vault/<address> objects have no extension, so their type is set here.
gc storage objects update "$bucket/vault/**" \
  --content-type="text/html" --cache-control="no-cache" >/dev/null
if [ -f frontend/dist/vault-catalog.json ]; then
  gc storage objects update "$bucket/vault-catalog.json" \
    --content-type="application/json" --cache-control="no-cache" >/dev/null
fi

log "invalidating CDN cache"
gc compute url-maps invalidate-cdn-cache "$URL_MAP" --path '/*' --async >/dev/null
log "done: https://$DOMAIN"
