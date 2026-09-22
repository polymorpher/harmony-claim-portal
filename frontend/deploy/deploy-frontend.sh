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
VITE_WALLETCONNECT_PROJECT_ID="${VITE_WALLETCONNECT_PROJECT_ID:-}" pnpm --filter @hcp/frontend build
[ -f frontend/dist/index.html ] || die "frontend/dist/index.html missing after build"
# /confirm must be a real object. The bucket error page serves index.html with
# HTTP 404, which a CDN can cache.
mkdir -p frontend/dist/confirm
cp frontend/dist/index.html frontend/dist/confirm/index.html

log "syncing frontend/dist -> $bucket"
gc storage rsync frontend/dist "$bucket" --recursive --delete-unmatched-destination-objects
# A destination of gs://bucket/confirm is treated as the confirm/ prefix once
# confirm/index.html exists, so the object name has to be set explicitly.
token="$(gcloud auth print-access-token)"
curl -fsS -X POST \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: text/html" \
  -H "Cache-Control: no-cache" \
  --data-binary @frontend/dist/index.html \
  "https://storage.googleapis.com/upload/storage/v1/b/${FRONTEND_BUCKET}/o?uploadType=media&name=confirm" \
  >/dev/null
curl -fsS -X PATCH \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  --data '{"cacheControl":"no-cache","contentType":"text/html"}' \
  "https://storage.googleapis.com/storage/v1/b/${FRONTEND_BUCKET}/o/confirm" \
  >/dev/null

log "setting cache-control"
# hashed assets are immutable; html must always be revalidated
gc storage objects update "$bucket/assets/**" \
  --cache-control="public,max-age=31536000,immutable" >/dev/null || true
gc storage objects update "$bucket/index.html" \
  --cache-control="no-cache" >/dev/null
gc storage objects update "$bucket/confirm/index.html" \
  --content-type="text/html" --cache-control="no-cache" >/dev/null

log "invalidating CDN cache"
gc compute url-maps invalidate-cdn-cache "$URL_MAP" --path '/*' --async >/dev/null
log "done: https://$DOMAIN"
