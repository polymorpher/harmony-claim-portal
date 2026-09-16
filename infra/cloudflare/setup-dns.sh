#!/usr/bin/env bash
# Cloudflare DNS + TLS settings for the portal. Run after
# infra/gcp/30-setup-load-balancer.sh has created the LB IP and the
# Certificate Manager DNS authorizations.
#
#   source infra/env.sh && infra/cloudflare/setup-dns.sh [--rate-limit]
#
# - A records for DOMAIN and EXTRA_DOMAINS -> LB IP, proxied (orange cloud)
# - _acme-challenge CNAMEs from Certificate Manager, DNS only (grey cloud)
# - ssl=strict, always_use_https=on, min_tls_version=1.2, automatic_https_rewrites=on
# - confirms Universal SSL is enabled
# - --rate-limit: optional rate-limiting rule on /api/* (needs the ruleset
#   phase available on the zone plan; skipped with a warning otherwise)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$here/../lib.sh"
# shellcheck source=./lib.sh
source "$here/lib.sh"
load_env
set_defaults
require_vars GCP_PROJECT DOMAIN CF_ZONE_NAME
require_tools gcloud jq curl
cf_require
cf_verify_token

with_rate_limit=0
[ "${1:-}" = "--rate-limit" ] && with_rate_limit=1

zone="$(cf_zone_id)"
log "zone $CF_ZONE_NAME ($zone)"

# --- A records -> load balancer IP -------------------------------------------------
lb_ip="$(gc compute addresses describe "$LB_IP_NAME" --global --format='value(address)' 2>/dev/null || true)"
[ -n "$lb_ip" ] || die "load balancer IP $LB_IP_NAME not found; run infra/gcp/30-setup-load-balancer.sh first"
for d in $(all_domains); do
  case "$d" in
    "$CF_ZONE_NAME"|*."$CF_ZONE_NAME") ;;
    *) die "$d is not inside zone $CF_ZONE_NAME" ;;
  esac
  cf_upsert_record A "$d" "$lb_ip" true
done

# --- _acme-challenge CNAMEs from Certificate Manager (DNS only) ----------------------
for d in $(all_domains); do
  auth="${LB_NAME}-dnsauth-$(name_from_domain "$d")"
  rec="$(gc certificate-manager dns-authorizations describe "$auth" --format=json 2>/dev/null || true)"
  [ -n "$rec" ] || die "dns authorization $auth missing; run infra/gcp/30-setup-load-balancer.sh first"
  name="$(echo "$rec" | jq -r '.dnsResourceRecord.name' | sed 's/\.$//')"
  data="$(echo "$rec" | jq -r '.dnsResourceRecord.data' | sed 's/\.$//')"
  cf_upsert_record CNAME "$name" "$data" false
done

# --- TLS / HTTPS settings ------------------------------------------------------------
cf_set_setting ssl '"strict"'
cf_set_setting always_use_https '"on"'
cf_set_setting min_tls_version '"1.2"'
cf_set_setting automatic_https_rewrites '"on"'

universal="$(cf_api GET "/zones/${zone}/ssl/universal/settings" | jq -r '.enabled')"
if [ "$universal" = "true" ]; then
  log "universal ssl: enabled"
else
  log "universal ssl: enabling"
  cf_api PATCH "/zones/${zone}/ssl/universal/settings" '{"enabled":true}' >/dev/null
fi

# --- optional rate limit on /api/* ---------------------------------------------------
# cf_api exits the shell through die() on any API error, so every call in this
# optional block runs in a subshell `( ... )`; a failure only skips the block.
if [ "$with_rate_limit" -eq 1 ]; then
  phase="http_ratelimit"
  rules_desc="claim-portal-api-rate-limit"
  rule="$(jq -nc --arg d "$rules_desc" \
    --argjson req "${CF_RATE_LIMIT_REQUESTS:-60}" --argjson period "${CF_RATE_LIMIT_PERIOD:-60}" \
    '{description:$d, expression:"(starts_with(http.request.uri.path, \"/api/\"))", action:"block",
      ratelimit:{characteristics:["ip.src","cf.colo.id"], period:$period, requests_per_period:$req, mitigation_timeout:60}}')"
  # 404 when the zone has no entrypoint ruleset for the phase yet
  ruleset="$( (cf_api GET "/zones/${zone}/rulesets/phases/${phase}/entrypoint") 2>/dev/null || true)"
  if [ -n "$ruleset" ] && echo "$ruleset" | jq -e --arg d "$rules_desc" '.rules[]? | select(.description == $d)' >/dev/null 2>&1; then
    log "rate limit rule: exists"
  elif [ -n "$ruleset" ]; then
    log "rate limit rule: adding to existing $phase entrypoint (${CF_RATE_LIMIT_REQUESTS:-60} req / ${CF_RATE_LIMIT_PERIOD:-60}s per IP on /api/*)"
    if ! (cf_api POST "/zones/${zone}/rulesets/phases/${phase}/entrypoint/rules" "$rule") >/dev/null 2>&1; then
      warn "could not add the rate-limit rule (plan or token permissions); the API enforces its own limit"
    fi
  else
    log "rate limit rule: creating $phase entrypoint ruleset with the rule"
    ruleset_body="$(jq -nc --arg p "$phase" --argjson r "$rule" \
      '{name:"claim-portal rate limits", description:"created by infra/cloudflare/setup-dns.sh", kind:"zone", phase:$p, rules:[$r]}')"
    if ! (cf_api POST "/zones/${zone}/rulesets" "$ruleset_body") >/dev/null 2>&1; then
      warn "could not create the $phase ruleset (plan or token permissions); the API enforces its own limit"
    fi
  fi
fi

log "done. Verify: dig +short $DOMAIN; curl -I https://$DOMAIN/api/health"
