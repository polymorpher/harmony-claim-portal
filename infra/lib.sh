#!/usr/bin/env bash
# Shared helpers for the infra and deploy scripts. Source, do not execute.
#
#   source "$(dirname "$0")/../lib.sh"   # from infra/gcp/*.sh
#   load_env
#   require_tools gcloud jq
#
# Every script is idempotent: helpers check for existence before creating.

if [ -n "${HCP_LIB_LOADED:-}" ]; then return 0; fi
HCP_LIB_LOADED=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export REPO_ROOT

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Load KEY=VALUE pairs from the repo-root .env (or $HCP_ENV_FILE). The file is
# parsed, not sourced: no command substitution, no `source` of operator input.
load_env() {
  local env_file="${HCP_ENV_FILE:-$REPO_ROOT/.env}"
  if [ ! -f "$env_file" ]; then
    die "missing $env_file; copy .env.example to .env and fill it in"
  fi
  load_dotenv "$env_file"
}

# Assign and export KEY=VALUE lines. Blank lines and # comments are skipped.
# Quoted values keep spaces. $(...), backticks, and ${...} are rejected.
load_dotenv() {
  local env_file="$1"
  local line key value n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      ''|\#*) continue ;;
    esac
    if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      die "invalid .env line $n in $env_file (expected KEY=VALUE)"
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    # shellcheck disable=SC2016 # literal expansion markers are rejected
    case "$value" in
      *'$('*|*'`'*|*'${'*) die "refusing shell expansion in $env_file:$n ($key)" ;;
    esac
    if [[ "$value" =~ ^\"(.*)\"$ ]]; then
      value="${BASH_REMATCH[1]}"
    elif [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    printf -v "$key" '%s' "$value"
    # shellcheck disable=SC2163 # export the dynamically parsed variable name
    export "$key"
  done <"$env_file"
}

# require_vars GCP_PROJECT GCP_REGION ...
require_vars() {
  local missing=()
  local v
  for v in "$@"; do
    if [ -z "${!v:-}" ]; then missing+=("$v"); fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    die "unset required variables: ${missing[*]} (see .env.example)"
  fi
}

# require_tools gcloud jq curl ...
require_tools() {
  local t
  for t in "$@"; do
    command -v "$t" >/dev/null 2>&1 || die "required tool not found: $t"
  done
}

# gcloud wrapper pinned to the configured project.
gc() {
  gcloud --project "$GCP_PROJECT" --quiet "$@"
}

# gc_exists <complete describe command...>: true when it succeeds, e.g.
#   gc_exists compute instances describe "$VM_NAME" --zone "$GCP_ZONE"
gc_exists() {
  gc "$@" >/dev/null 2>&1
}

# gc_ensure <description> <complete describe command...> -- <complete create command...>
# Runs the create command only when the describe command fails, e.g.
#   gc_ensure "static ip" compute addresses describe NAME --region R -- \
#             compute addresses create NAME --region R
gc_ensure() {
  local desc="$1"; shift
  local check=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do check+=("$1"); shift; done
  [ "$#" -gt 0 ] && shift
  [ "${#check[@]}" -gt 0 ] || die "gc_ensure $desc: missing describe command"
  [ "$#" -gt 0 ] || die "gc_ensure $desc: missing create command"
  case " ${check[*]} " in
    *" describe "*) ;;
    *) die "gc_ensure $desc: describe command must contain 'describe' (got: ${check[*]})" ;;
  esac
  if gc_exists "${check[@]}"; then
    log "$desc: exists"
  else
    log "$desc: creating"
    gc "$@"
  fi
}

# Poll until a command's output matches a value.
# wait_for <timeout-seconds> <interval-seconds> <expected> <command...>
wait_for() {
  local timeout="$1" interval="$2" expected="$3"; shift 3
  local elapsed=0 out
  while [ "$elapsed" -lt "$timeout" ]; do
    out="$("$@" 2>/dev/null || true)"
    if [ "$out" = "$expected" ]; then return 0; fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
  return 1
}

# Default resource names derived from .env; override by exporting first.
set_defaults() {
  : "${GCP_REGION:=us-west1}"
  : "${GCP_ZONE:=us-west1-b}"
  : "${VM_NAME:=claim-portal-vm}"
  : "${VM_MACHINE_TYPE:=e2-medium}"
  : "${VM_DISK_GB:=30}"
  : "${VM_IMAGE_FAMILY:=debian-12}"
  : "${VM_IMAGE_PROJECT:=debian-cloud}"
  : "${VM_NETWORK:=default}"
  : "${VM_NETWORK_TAG:=claim-api}"
  : "${API_PORT:=8080}"
  : "${PG_MAJOR:=18}"
  : "${NODE_MAJOR:=22}"
  : "${DB_NAME:=claims}"
  : "${DB_USER:=claimapi}"
  : "${DB_TUNNEL_PORT:=5433}"
  : "${LB_NAME:=claim-portal}"
  : "${EXTRA_DOMAINS:=}"
  : "${VM_STATIC_IP_NAME:=${VM_NAME}-ip}"
  : "${LB_IP_NAME:=${LB_NAME}-ip}"
  : "${INSTANCE_GROUP:=${LB_NAME}-ig}"
  : "${HEALTH_CHECK:=${LB_NAME}-api-hc}"
  : "${BACKEND_SERVICE:=${LB_NAME}-api-backend}"
  : "${BACKEND_BUCKET:=${LB_NAME}-frontend-backend}"
  : "${URL_MAP:=${LB_NAME}-url-map}"
  : "${REDIRECT_URL_MAP:=${LB_NAME}-http-redirect}"
  # not HTTPS_PROXY/HTTP_PROXY: those are standard environment proxy variables
  # honoured by gcloud and curl
  : "${LB_HTTPS_PROXY_NAME:=${LB_NAME}-https-proxy}"
  : "${LB_HTTP_PROXY_NAME:=${LB_NAME}-http-proxy}"
  : "${HTTPS_RULE:=${LB_NAME}-https-rule}"
  : "${HTTP_RULE:=${LB_NAME}-http-rule}"
  : "${CERT_NAME:=${LB_NAME}-cert}"
  : "${CERT_MAP:=${LB_NAME}-cert-map}"
  : "${APP_DIR:=/opt/harmony-claim-api}"
  : "${APP_ENV_FILE:=/etc/harmony-claim-api.env}"
  : "${APP_USER:=claimapi}"
  : "${SERVICE_NAME:=harmony-claim-api}"
  export GCP_REGION GCP_ZONE VM_NAME VM_MACHINE_TYPE VM_DISK_GB VM_IMAGE_FAMILY VM_IMAGE_PROJECT \
    VM_NETWORK VM_NETWORK_TAG API_PORT PG_MAJOR NODE_MAJOR DB_NAME DB_USER DB_TUNNEL_PORT LB_NAME EXTRA_DOMAINS \
    VM_STATIC_IP_NAME LB_IP_NAME INSTANCE_GROUP HEALTH_CHECK BACKEND_SERVICE BACKEND_BUCKET URL_MAP \
    REDIRECT_URL_MAP LB_HTTPS_PROXY_NAME LB_HTTP_PROXY_NAME HTTPS_RULE HTTP_RULE CERT_NAME CERT_MAP APP_DIR APP_ENV_FILE \
    APP_USER SERVICE_NAME
}

# All hostnames covered by the certificate and DNS: DOMAIN plus EXTRA_DOMAINS.
all_domains() {
  local d
  echo "$DOMAIN"
  for d in $EXTRA_DOMAINS; do echo "$d"; done
}

# Lowercase, dash-separated resource-safe name from a hostname.
name_from_domain() {
  echo "$1" | tr '.' '-' | tr '[:upper:]' '[:lower:]'
}

# Run a command on the VM through IAP.
vm_ssh() {
  gc compute ssh "$VM_NAME" --zone "$GCP_ZONE" --tunnel-through-iap --command "$*"
}

# Copy files to the VM through IAP.  vm_scp <local...> <remote-path>
vm_scp() {
  gc compute scp --zone "$GCP_ZONE" --tunnel-through-iap "$@"
}
