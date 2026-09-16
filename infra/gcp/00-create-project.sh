#!/usr/bin/env bash
# Create (or reuse) the GCP project, link billing and enable the APIs the
# portal needs. Idempotent.
#   source infra/env.sh && infra/gcp/00-create-project.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$here/../lib.sh"
load_env
set_defaults
require_vars GCP_PROJECT
require_tools gcloud

if gcloud projects describe "$GCP_PROJECT" >/dev/null 2>&1; then
  log "project $GCP_PROJECT: exists"
else
  require_vars BILLING_ACCOUNT
  log "project $GCP_PROJECT: creating"
  create_args=(projects create "$GCP_PROJECT" --name="$GCP_PROJECT" --quiet)
  if [ -n "${GCP_ORGANIZATION:-}" ]; then create_args+=(--organization="$GCP_ORGANIZATION"); fi
  if [ -n "${GCP_FOLDER:-}" ]; then create_args+=(--folder="$GCP_FOLDER"); fi
  gcloud "${create_args[@]}"
fi

if [ -n "${BILLING_ACCOUNT:-}" ]; then
  current="$(gcloud billing projects describe "$GCP_PROJECT" --format='value(billingAccountName)' 2>/dev/null || true)"
  if [ "$current" = "billingAccounts/$BILLING_ACCOUNT" ]; then
    log "billing: already linked to $BILLING_ACCOUNT"
  else
    log "billing: linking $BILLING_ACCOUNT"
    gcloud billing projects link "$GCP_PROJECT" --billing-account="$BILLING_ACCOUNT"
  fi
else
  warn "BILLING_ACCOUNT unset; skipping billing link (APIs will fail to enable without billing)"
fi

log "enabling APIs"
gc services enable \
  compute.googleapis.com \
  certificatemanager.googleapis.com \
  iap.googleapis.com \
  storage.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com \
  oslogin.googleapis.com

log "project ready: $GCP_PROJECT"
