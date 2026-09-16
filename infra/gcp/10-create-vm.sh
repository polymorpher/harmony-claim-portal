#!/usr/bin/env bash
# Static IP, firewall rules and the API/DB VM (Debian 12) with the bootstrap
# startup script. Waits until the bootstrap marker appears. Idempotent.
#   source infra/env.sh && infra/gcp/10-create-vm.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$here/../lib.sh"
load_env
set_defaults
require_vars GCP_PROJECT GCP_REGION GCP_ZONE VM_NAME VM_NETWORK VM_NETWORK_TAG API_PORT DB_NAME DB_USER
require_tools gcloud

bootstrap="$here/vm/bootstrap.sh"
[ -f "$bootstrap" ] || die "missing $bootstrap"

# --- static external IP (egress identity; ingress is via the LB) -------------
gc_ensure "static ip $VM_STATIC_IP_NAME" \
  compute addresses describe "$VM_STATIC_IP_NAME" --region "$GCP_REGION" -- \
  compute addresses create "$VM_STATIC_IP_NAME" --region "$GCP_REGION" --network-tier=PREMIUM
vm_ip="$(gc compute addresses describe "$VM_STATIC_IP_NAME" --region "$GCP_REGION" --format='value(address)')"

# --- firewall ----------------------------------------------------------------
# The VM carries a public IP (egress identity) and lives in $VM_NETWORK, whose
# default rules (e.g. default-allow-ssh, priority 65534) would expose port 22.
# A target-tagged DENY at priority 1000 shadows them; the IAP SSH and Google
# front-end/health-check allows sit above it at priority 900. Nothing else can
# reach the tagged VM from outside the VPC.
allow_priority=900
deny_priority=1000

gc_ensure "firewall allow-iap-ssh" \
  compute firewall-rules describe allow-iap-ssh -- \
  compute firewall-rules create allow-iap-ssh \
    --network "$VM_NETWORK" --direction INGRESS --action ALLOW --priority "$allow_priority" \
    --rules tcp:22 --source-ranges 35.235.240.0/20 --target-tags "$VM_NETWORK_TAG"

# 130.211.0.0/22 and 35.191.0.0/16 carry both health checks and proxied
# requests from the global external Application Load Balancer.
gc_ensure "firewall allow-lb-health-check" \
  compute firewall-rules describe allow-lb-health-check -- \
  compute firewall-rules create allow-lb-health-check \
    --network "$VM_NETWORK" --direction INGRESS --action ALLOW --priority "$allow_priority" \
    --rules "tcp:${API_PORT}" --source-ranges 130.211.0.0/22,35.191.0.0/16 --target-tags "$VM_NETWORK_TAG"

gc_ensure "firewall deny-public-ingress-${VM_NETWORK_TAG}" \
  compute firewall-rules describe "deny-public-ingress-${VM_NETWORK_TAG}" -- \
  compute firewall-rules create "deny-public-ingress-${VM_NETWORK_TAG}" \
    --network "$VM_NETWORK" --direction INGRESS --action DENY --priority "$deny_priority" \
    --rules all --source-ranges 0.0.0.0/0 --target-tags "$VM_NETWORK_TAG"

# priorities are not part of the exists-check; pin them on every run so a rule
# created earlier with the default priority cannot tie with (and lose to) the deny
gc compute firewall-rules update allow-iap-ssh --priority "$allow_priority" >/dev/null
gc compute firewall-rules update allow-lb-health-check --priority "$allow_priority" >/dev/null
gc compute firewall-rules update "deny-public-ingress-${VM_NETWORK_TAG}" --priority "$deny_priority" >/dev/null

# --- VM ----------------------------------------------------------------------
if gc_exists compute instances describe "$VM_NAME" --zone "$GCP_ZONE"; then
  log "vm $VM_NAME: exists"
else
  log "vm $VM_NAME: creating ($VM_MACHINE_TYPE, $VM_IMAGE_FAMILY, ${VM_DISK_GB}GB)"
  gc compute instances create "$VM_NAME" \
    --zone "$GCP_ZONE" \
    --machine-type "$VM_MACHINE_TYPE" \
    --image-family "$VM_IMAGE_FAMILY" --image-project "$VM_IMAGE_PROJECT" \
    --boot-disk-size "${VM_DISK_GB}GB" --boot-disk-type pd-balanced \
    --network "$VM_NETWORK" \
    --address "$vm_ip" \
    --tags "$VM_NETWORK_TAG" \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --scopes logging-write,monitoring-write \
    --metadata "enable-oslogin=TRUE,pg-major=${PG_MAJOR},node-major=${NODE_MAJOR},db-name=${DB_NAME},db-user=${DB_USER},api-port=${API_PORT},app-user=${APP_USER},app-dir=${APP_DIR},app-env-file=${APP_ENV_FILE},service-name=${SERVICE_NAME}" \
    --metadata-from-file "startup-script=${bootstrap}"
fi

# --- wait for bootstrap ------------------------------------------------------
log "waiting for bootstrap marker on $VM_NAME (up to 15 minutes)"
deadline=$((SECONDS + 900))
until vm_ssh "test -f /var/lib/harmony-claim-api/bootstrap.done" >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    die "bootstrap did not finish; inspect: gcloud compute instances get-serial-port-output $VM_NAME --zone $GCP_ZONE"
  fi
  sleep 15
done
log "vm ready: $VM_NAME ($vm_ip); PostgreSQL ${PG_MAJOR} and Node ${NODE_MAJOR} installed"
