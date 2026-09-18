#!/usr/bin/env bash
# Public GCS bucket that serves the built SPA (behind the LB + Cloud CDN).
#   infra/gcp/20-setup-frontend-bucket.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$here/../lib.sh"
load_env
set_defaults
require_vars GCP_PROJECT FRONTEND_BUCKET
require_tools gcloud

bucket="gs://$FRONTEND_BUCKET"

if gc storage buckets describe "$bucket" >/dev/null 2>&1; then
  log "bucket $bucket: exists"
else
  log "bucket $bucket: creating"
  gc storage buckets create "$bucket" \
    --location="${FRONTEND_BUCKET_LOCATION:-US}" \
    --uniform-bucket-level-access \
    --no-public-access-prevention
fi

log "bucket: public read (allUsers:objectViewer)"
gc storage buckets add-iam-policy-binding "$bucket" \
  --member=allUsers --role=roles/storage.objectViewer >/dev/null

log "bucket: SPA website config (main=index.html, error=index.html)"
gc storage buckets update "$bucket" --web-main-page-suffix=index.html --web-error-page=index.html >/dev/null

log "bucket ready: $bucket"
