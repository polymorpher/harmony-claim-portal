# shellcheck shell=bash
# Copy to infra/env.sh (gitignored), fill in, then `source infra/env.sh`.
# Every infra and deploy script reads its configuration from these variables.

# --- GCP -------------------------------------------------------------------
# Dedicated project id (already created for this deployment).
export GCP_PROJECT="harmony-migration"
# Billing account to link when 00-create-project.sh has to create the project:
# `gcloud billing accounts list`. Leave empty when the project already exists.
export BILLING_ACCOUNT=""
# Optional parent for project creation (one of the two, or neither).
export GCP_ORGANIZATION=""
export GCP_FOLDER=""
export GCP_REGION="us-west1"
export GCP_ZONE="us-west1-b"

# --- VM (API server + PostgreSQL) -------------------------------------------
export VM_NAME="claim-portal-vm"
export VM_MACHINE_TYPE="e2-medium"
export VM_DISK_GB="30"
export VM_IMAGE_FAMILY="debian-12"
export VM_IMAGE_PROJECT="debian-cloud"
# VPC network for the VM. A tagged DENY rule (priority 1000) shadows the
# network's broad default-allow rules for this VM; only IAP SSH and the load
# balancer ranges are allowed (priority 900).
export VM_NETWORK="default"
export VM_NETWORK_TAG="claim-api"
export API_PORT="8080"
export PG_MAJOR="18"
export NODE_MAJOR="22"

# --- Database ----------------------------------------------------------------
export DB_NAME="claims"
export DB_USER="claimapi"
# Local port used by backend/deploy/tunnel-db.sh for the IAP SSH tunnel.
export DB_TUNNEL_PORT="5433"

# --- Frontend bucket + load balancer ------------------------------------------
# Globally unique GCS bucket name that holds the built frontend.
export FRONTEND_BUCKET="migration-country-frontend"
export FRONTEND_BUCKET_LOCATION="US"
export DOMAIN="migration.country"
# Space separated additional hostnames covered by the certificate and DNS.
export EXTRA_DOMAINS="www.migration.country"
# Prefix for load balancer resources (IP, backends, URL maps, proxies, cert).
export LB_NAME="claim-portal"

# --- Cloudflare ---------------------------------------------------------------
# API token with Zone.DNS:Edit, Zone.Zone Settings:Edit, Zone.Zone:Read on the zone.
export CF_API_TOKEN=""
export CF_ZONE_NAME="migration.country"
# Optional edge rate limit (setup-dns.sh --rate-limit): requests per period per IP on /api/*.
export CF_RATE_LIMIT_REQUESTS="60"
export CF_RATE_LIMIT_PERIOD="60"

# --- Frontend build ----------------------------------------------------------------
# Optional WalletConnect Cloud project id; injected connectors work without it.
export VITE_WALLETCONNECT_PROJECT_ID=""

# --- Backend runtime (defaults written to /etc/harmony-claim-api.env by bootstrap) ---
export RATE_LIMIT_MAX="30"
export RATE_LIMIT_WINDOW="1 minute"
export EXPOSE_CONTRACT_AMOUNTS="false"
