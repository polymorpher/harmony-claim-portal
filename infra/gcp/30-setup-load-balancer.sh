#!/usr/bin/env bash
# Global external HTTPS load balancer for $DOMAIN:
#   default          -> backend bucket (frontend, Cloud CDN)
#   /api/*           -> backend service -> unmanaged instance group -> VM:$API_PORT
#   :80              -> 301 to https
# Certificate: Certificate Manager, DNS authorization (works behind Cloudflare
# proxy). Prints the _acme-challenge CNAME records that
# infra/cloudflare/setup-dns.sh must create, then polls until the cert is ACTIVE.
#
#   infra/gcp/30-setup-load-balancer.sh [--no-wait]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$here/../lib.sh"
load_env
set_defaults
require_vars GCP_PROJECT GCP_ZONE VM_NAME FRONTEND_BUCKET DOMAIN API_PORT
require_tools gcloud jq

wait_cert=1
[ "${1:-}" = "--no-wait" ] && wait_cert=0

# --- global IP -----------------------------------------------------------------
gc_ensure "global ip $LB_IP_NAME" \
  compute addresses describe "$LB_IP_NAME" --global -- \
  compute addresses create "$LB_IP_NAME" --global --ip-version IPV4
lb_ip="$(gc compute addresses describe "$LB_IP_NAME" --global --format='value(address)')"

# --- frontend: backend bucket with CDN -----------------------------------------
gc_ensure "backend bucket $BACKEND_BUCKET" \
  compute backend-buckets describe "$BACKEND_BUCKET" -- \
  compute backend-buckets create "$BACKEND_BUCKET" \
    --gcs-bucket-name "$FRONTEND_BUCKET" --enable-cdn --cache-mode CACHE_ALL_STATIC \
    --default-ttl 3600 --max-ttl 86400 --client-ttl 3600

# --- api: health check, instance group, backend service ----------------------------
gc_ensure "health check $HEALTH_CHECK" \
  compute health-checks describe "$HEALTH_CHECK" --global -- \
  compute health-checks create http "$HEALTH_CHECK" --global \
    --port "$API_PORT" --request-path /api/health \
    --check-interval 10s --timeout 5s --healthy-threshold 2 --unhealthy-threshold 3

gc_ensure "instance group $INSTANCE_GROUP" \
  compute instance-groups unmanaged describe "$INSTANCE_GROUP" --zone "$GCP_ZONE" -- \
  compute instance-groups unmanaged create "$INSTANCE_GROUP" --zone "$GCP_ZONE"

gc compute instance-groups unmanaged set-named-ports "$INSTANCE_GROUP" --zone "$GCP_ZONE" \
  --named-ports "http:${API_PORT}"

if gc compute instance-groups unmanaged list-instances "$INSTANCE_GROUP" --zone "$GCP_ZONE" \
     --format='value(instance)' | grep -qx "$VM_NAME"; then
  log "instance group: $VM_NAME already a member"
else
  log "instance group: adding $VM_NAME"
  gc compute instance-groups unmanaged add-instances "$INSTANCE_GROUP" --zone "$GCP_ZONE" --instances "$VM_NAME"
fi

gc_ensure "backend service $BACKEND_SERVICE" \
  compute backend-services describe "$BACKEND_SERVICE" --global -- \
  compute backend-services create "$BACKEND_SERVICE" --global \
    --load-balancing-scheme EXTERNAL_MANAGED --protocol HTTP --port-name http \
    --health-checks "$HEALTH_CHECK" --global-health-checks \
    --timeout 30s --connection-draining-timeout 30s

if gc compute backend-services describe "$BACKEND_SERVICE" --global --format=json \
     | jq -e --arg g "$INSTANCE_GROUP" '.backends[]? | select(.group | endswith("/" + $g))' >/dev/null; then
  log "backend service: instance group already attached"
else
  log "backend service: attaching $INSTANCE_GROUP"
  gc compute backend-services add-backend "$BACKEND_SERVICE" --global \
    --instance-group "$INSTANCE_GROUP" --instance-group-zone "$GCP_ZONE" \
    --balancing-mode UTILIZATION --max-utilization 0.8
fi

# --- URL map: default -> bucket, /api/* -> api ------------------------------------
gc_ensure "url map $URL_MAP" \
  compute url-maps describe "$URL_MAP" --global -- \
  compute url-maps create "$URL_MAP" --global --default-backend-bucket "$BACKEND_BUCKET"

if gc compute url-maps describe "$URL_MAP" --global --format=json \
     | jq -e '.pathMatchers[]? | select(.name == "api")' >/dev/null; then
  log "url map: /api/* path matcher exists"
else
  log "url map: adding /api/* -> $BACKEND_SERVICE"
  gc compute url-maps add-path-matcher "$URL_MAP" --global \
    --path-matcher-name api \
    --default-backend-bucket "$BACKEND_BUCKET" \
    --backend-service-path-rules "/api/*=${BACKEND_SERVICE}" \
    --new-hosts "$(all_domains | paste -sd, -)"
fi

# --- Certificate Manager: DNS authorizations + managed cert + map -------------------------
declare -a auth_names=()
for d in $(all_domains); do
  auth="${LB_NAME}-dnsauth-$(name_from_domain "$d")"
  gc_ensure "dns authorization $auth ($d)" \
    certificate-manager dns-authorizations describe "$auth" -- \
    certificate-manager dns-authorizations create "$auth" --domain "$d"
  auth_names+=("$auth")
done

gc_ensure "managed certificate $CERT_NAME" \
  certificate-manager certificates describe "$CERT_NAME" -- \
  certificate-manager certificates create "$CERT_NAME" \
    --domains "$(all_domains | paste -sd, -)" \
    --dns-authorizations "$(printf '%s,' "${auth_names[@]}" | sed 's/,$//')"

gc_ensure "certificate map $CERT_MAP" \
  certificate-manager maps describe "$CERT_MAP" -- \
  certificate-manager maps create "$CERT_MAP"

for d in $(all_domains); do
  entry="${CERT_MAP}-$(name_from_domain "$d")"
  gc_ensure "certificate map entry $entry" \
    certificate-manager maps entries describe "$entry" --map "$CERT_MAP" -- \
    certificate-manager maps entries create "$entry" --map "$CERT_MAP" \
      --certificates "$CERT_NAME" --hostname "$d"
done

# --- HTTPS proxy + forwarding rule ---------------------------------------------------
# gcloud resolves the map ID in the configured project and global location.
cert_map_ref="$CERT_MAP"
gc_ensure "https proxy $LB_HTTPS_PROXY_NAME" \
  compute target-https-proxies describe "$LB_HTTPS_PROXY_NAME" --global -- \
  compute target-https-proxies create "$LB_HTTPS_PROXY_NAME" --global \
    --url-map "$URL_MAP" --certificate-map "$cert_map_ref"

gc_ensure "forwarding rule $HTTPS_RULE (:443)" \
  compute forwarding-rules describe "$HTTPS_RULE" --global -- \
  compute forwarding-rules create "$HTTPS_RULE" --global \
    --load-balancing-scheme EXTERNAL_MANAGED --network-tier PREMIUM \
    --address "$LB_IP_NAME" --target-https-proxy "$LB_HTTPS_PROXY_NAME" --ports 443

# --- HTTP -> HTTPS redirect ---------------------------------------------------------
if gc_exists compute url-maps describe "$REDIRECT_URL_MAP" --global; then
  log "redirect url map $REDIRECT_URL_MAP: exists"
else
  log "redirect url map $REDIRECT_URL_MAP: creating"
  tmp="$(mktemp)"
  cat >"$tmp" <<EOF
name: ${REDIRECT_URL_MAP}
defaultUrlRedirect:
  httpsRedirect: true
  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT
  stripQuery: false
EOF
  gc compute url-maps import "$REDIRECT_URL_MAP" --global --source "$tmp"
  rm -f "$tmp"
fi

gc_ensure "http proxy $LB_HTTP_PROXY_NAME" \
  compute target-http-proxies describe "$LB_HTTP_PROXY_NAME" --global -- \
  compute target-http-proxies create "$LB_HTTP_PROXY_NAME" --global --url-map "$REDIRECT_URL_MAP"

gc_ensure "forwarding rule $HTTP_RULE (:80)" \
  compute forwarding-rules describe "$HTTP_RULE" --global -- \
  compute forwarding-rules create "$HTTP_RULE" --global \
    --load-balancing-scheme EXTERNAL_MANAGED --network-tier PREMIUM \
    --address "$LB_IP_NAME" --target-http-proxy "$LB_HTTP_PROXY_NAME" --ports 80

# --- output for the Cloudflare step ------------------------------------------------------
log "load balancer IP: $lb_ip"
echo
echo "DNS records to create in Cloudflare (infra/cloudflare/setup-dns.sh does this):"
for d in $(all_domains); do
  echo "  A      $d -> $lb_ip (proxied)"
done
for auth in "${auth_names[@]}"; do
  rec="$(gc certificate-manager dns-authorizations describe "$auth" --format=json)"
  name="$(echo "$rec" | jq -r '.dnsResourceRecord.name' | sed 's/\.$//')"
  data="$(echo "$rec" | jq -r '.dnsResourceRecord.data' | sed 's/\.$//')"
  echo "  CNAME  $name -> $data (DNS only)"
done
echo

if [ "$wait_cert" -eq 1 ]; then
  log "waiting for certificate $CERT_NAME to become ACTIVE (run the Cloudflare script now; up to 30 min)"
  if wait_for 1800 30 ACTIVE gc certificate-manager certificates describe "$CERT_NAME" --format='value(managed.state)'; then
    log "certificate ACTIVE; https://$DOMAIN is served by the load balancer"
  else
    state="$(gc certificate-manager certificates describe "$CERT_NAME" --format=json | jq -c '.managed')"
    die "certificate not ACTIVE yet: $state"
  fi
fi
