#!/usr/bin/env bash
# Cloudflare API v4 helpers (curl + jq). Source after infra/lib.sh + load_env.
# Requires CF_API_TOKEN (Zone.DNS:Edit, Zone.Zone Settings:Edit, Zone.Zone:Read)
# and CF_ZONE_NAME.

if [ -n "${HCP_CF_LIB_LOADED:-}" ]; then return 0; fi
HCP_CF_LIB_LOADED=1

CF_API="${CF_API:-https://api.cloudflare.com/client/v4}"

cf_require() {
  require_tools curl jq
  if [ -z "${CF_API_TOKEN:-}" ]; then
    die "CF_API_TOKEN is unset; create a token with Zone.DNS:Edit + Zone.Zone Settings:Edit + Zone.Zone:Read and put it in .env"
  fi
  require_vars CF_ZONE_NAME
}

# cf_api <METHOD> <path> [json-body]  -> prints the "result" object, dies on errors
cf_api() {
  local method="$1" path="$2" body="${3:-}"
  local resp
  if [ -n "$body" ]; then
    resp="$(curl -fsS -X "$method" "${CF_API}${path}" \
      -H "Authorization: Bearer ${CF_API_TOKEN}" -H 'Content-Type: application/json' \
      --data "$body")" || die "cloudflare $method $path failed"
  else
    resp="$(curl -fsS -X "$method" "${CF_API}${path}" \
      -H "Authorization: Bearer ${CF_API_TOKEN}")" || die "cloudflare $method $path failed"
  fi
  if [ "$(echo "$resp" | jq -r '.success')" != "true" ]; then
    die "cloudflare $method $path: $(echo "$resp" | jq -c '.errors')"
  fi
  echo "$resp" | jq -c '.result'
}

cf_verify_token() {
  if (cf_api GET /user/tokens/verify | jq -e '.status == "active"') >/dev/null 2>&1; then
    return 0
  fi
  # Account-owned tokens are valid for zone APIs but are rejected by the
  # user-token verification endpoint. Verify their configured-zone access.
  if [ -n "${CF_ZONE_NAME:-}" ] && \
     (cf_api GET "/zones?name=${CF_ZONE_NAME}&status=active" | jq -e 'length > 0') >/dev/null 2>&1; then
    log "cloudflare token: zone access verified"
    return 0
  fi
  die "CF_API_TOKEN is not active or cannot access zone ${CF_ZONE_NAME:-<unset>}"
}

# Zone id for CF_ZONE_NAME (cached in CF_ZONE_ID).
cf_zone_id() {
  if [ -z "${CF_ZONE_ID:-}" ]; then
    CF_ZONE_ID="$(cf_api GET "/zones?name=${CF_ZONE_NAME}&status=active" | jq -r '.[0].id // empty')"
    [ -n "$CF_ZONE_ID" ] || die "zone $CF_ZONE_NAME not found or not active for this token"
    export CF_ZONE_ID
  fi
  echo "$CF_ZONE_ID"
}

# cf_upsert_record <type> <name> <content> <proxied true|false> [ttl]
# Idempotent by (type, name): creates, or updates when content/proxied differ.
cf_upsert_record() {
  local type="$1" name="$2" content="$3" proxied="$4" ttl="${5:-1}"
  local zone existing id cur_content cur_proxied body
  zone="$(cf_zone_id)"
  existing="$(cf_api GET "/zones/${zone}/dns_records?type=${type}&name=${name}")"
  id="$(echo "$existing" | jq -r '.[0].id // empty')"
  body="$(jq -nc --arg t "$type" --arg n "$name" --arg c "$content" --argjson p "$proxied" --argjson ttl "$ttl" \
    '{type:$t, name:$n, content:$c, proxied:$p, ttl:$ttl}')"
  if [ -z "$id" ]; then
    log "dns $type $name -> $content (proxied=$proxied): creating"
    cf_api POST "/zones/${zone}/dns_records" "$body" >/dev/null
  else
    cur_content="$(echo "$existing" | jq -r '.[0].content' | sed 's/\.$//')"
    cur_proxied="$(echo "$existing" | jq -r '.[0].proxied')"
    if [ "$cur_content" = "${content%.}" ] && [ "$cur_proxied" = "$proxied" ]; then
      log "dns $type $name -> $content (proxied=$proxied): up to date"
    else
      log "dns $type $name -> $content (proxied=$proxied): updating"
      cf_api PUT "/zones/${zone}/dns_records/${id}" "$body" >/dev/null
    fi
  fi
}

# cf_set_setting <setting-id> <value-json>   e.g. cf_set_setting ssl '"strict"'
cf_set_setting() {
  local id="$1" value="$2" zone current
  zone="$(cf_zone_id)"
  current="$(cf_api GET "/zones/${zone}/settings/${id}" | jq -c '.value')"
  if [ "$current" = "$value" ]; then
    log "setting $id = $value: up to date"
  else
    log "setting $id: $current -> $value"
    cf_api PATCH "/zones/${zone}/settings/${id}" "{\"value\":${value}}" >/dev/null
  fi
}
