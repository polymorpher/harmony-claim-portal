#!/usr/bin/env bash
# Build the SPA and publish it to the frontend bucket behind the load balancer.
#   source infra/env.sh && frontend/deploy/deploy-frontend.sh
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

log "syncing frontend/dist -> $bucket"
gc storage rsync frontend/dist "$bucket" --recursive --delete-unmatched-destination-objects

log "setting cache-control"
# hashed assets are immutable; html must always be revalidated
gc storage objects update "$bucket/assets/**" \
  --cache-control="public,max-age=31536000,immutable" >/dev/null || true
gc storage objects update "$bucket/index.html" \
  --cache-control="no-cache" >/dev/null

log "invalidating CDN cache"
gc compute url-maps invalidate-cdn-cache "$URL_MAP" --path '/*' --async >/dev/null
log "done: https://$DOMAIN"
