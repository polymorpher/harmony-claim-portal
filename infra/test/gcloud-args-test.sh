#!/usr/bin/env bash
# Offline argument test for the gcloud scripts. A stub `gcloud` on PATH records
# every invocation; `describe` without --format fails (resource absent) so the
# create branches run too. Every recorded command must have the shape
# `<group...> <verb> ...` that the real CLI accepts. Creates no cloud resources.
#   infra/test/gcloud-args-test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export GCLOUD_STUB_LOG="$work/gcloud.log"
: >"$GCLOUD_STUB_LOG"

cat >"$work/gcloud" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$GCLOUD_STUB_LOG"
args=" $* "
case "$args" in
  *" describe "*)
    case "$args" in
      *"--format=json"*)
        case "$args" in
          *dns-authorizations*) echo '{"dnsResourceRecord":{"name":"_acme-challenge.example.test.","data":"abc.authorize.certificatemanager.goog."}}' ;;
          *) echo '{}' ;;
        esac
        exit 0 ;;
      *"--format=value(address)"*) echo 203.0.113.10; exit 0 ;;
      *"--format="*) echo stub; exit 0 ;;
      *) exit 1 ;;   # resource does not exist -> create branch
    esac ;;
  *" list-instances "*) exit 0 ;;
  *" ssh "*) exit 0 ;;
esac
exit 0
EOF
chmod +x "$work/gcloud"

cp "$root/infra/env.example.sh" "$work/env.sh"
export HCP_ENV_FILE="$work/env.sh"
export PATH="$work:$PATH"

fail=0
check() {
  if "$@"; then echo "ok   $*"; else echo "FAIL $*"; fail=1; fi
}

# --- unit: gc_ensure / gc_exists -----------------------------------------------
# shellcheck source=../lib.sh
source "$root/infra/lib.sh"
load_env; set_defaults

gc_ensure "thing" compute addresses describe thing-ip --region us-west1 -- \
  compute addresses create thing-ip --region us-west1 >/dev/null 2>&1
check grep -qx -- "--project $GCP_PROJECT --quiet compute addresses describe thing-ip --region us-west1" "$GCLOUD_STUB_LOG"
check grep -qx -- "--project $GCP_PROJECT --quiet compute addresses create thing-ip --region us-west1" "$GCLOUD_STUB_LOG"

# describe succeeds (stub returns 0 when --format is present) -> no create
: >"$GCLOUD_STUB_LOG"
gc_ensure "present" compute addresses describe present --format=value\(name\) -- \
  compute addresses create present >/dev/null 2>&1
check test "$(wc -l <"$GCLOUD_STUB_LOG" | tr -d ' ')" = 1
check bash -c "! grep -q ' create ' '$GCLOUD_STUB_LOG'"

# malformed check (no describe verb) must die instead of silently "creating"
check bash -c '( source "'"$root"'/infra/lib.sh"; load_env; set_defaults; gc_ensure "bad" compute addresses x -- compute addresses create x ) >/dev/null 2>&1; [ $? -ne 0 ]'

# --- integration: run the real scripts against the stub ------------------------------
: >"$GCLOUD_STUB_LOG"
check "$root/infra/gcp/10-create-vm.sh"
check "$root/infra/gcp/20-setup-frontend-bucket.sh"
check "$root/infra/gcp/30-setup-load-balancer.sh" --no-wait

group='compute (addresses|firewall-rules|instances|backend-buckets|health-checks|backend-services|url-maps|target-https-proxies|target-http-proxies|forwarding-rules|instance-groups unmanaged|ssh|scp)|certificate-manager (dns-authorizations|certificates|maps entries|maps)|storage (buckets|objects)|services|projects|billing projects'
verb='describe|create|update|delete|list|list-instances|set-named-ports|add-instances|add-backend|add-path-matcher|import|enable|add-iam-policy-binding|link|rsync|invalidate-cdn-cache'
bad=0
while IFS= read -r line; do
  cmd="${line#--project * --quiet }"
  case "$cmd" in
    "compute ssh "*|"compute scp "*) continue ;;
  esac
  if ! [[ "$cmd" =~ ^($group)\ ($verb)(\ |$) ]]; then
    echo "  malformed gcloud invocation: $cmd"; bad=1
  fi
done <"$GCLOUD_STUB_LOG"
check test "$bad" = 0
echo "recorded $(wc -l <"$GCLOUD_STUB_LOG" | tr -d ' ') gcloud invocations"

# every resource the scripts manage must be probed with describe before create
recorded=()
while IFS= read -r line; do recorded+=("$line"); done <"$GCLOUD_STUB_LOG"
for line in "${recorded[@]}"; do
  cmd="${line#--project * --quiet }"
  [[ "$cmd" =~ ^(.*)\ create\ ([^ ]+) ]] || continue
  grp="${BASH_REMATCH[1]}"; name="${BASH_REMATCH[2]}"
  # `health-checks create http NAME`: skip the protocol subtype token
  if [ "$name" = "http" ]; then name="$(echo "$cmd" | awk '{print $5}')"; fi
  case "$grp" in compute\ instances) continue ;; esac  # instances use gc_exists + if
  if ! printf '%s\n' "${recorded[@]}" | grep -q -- "--quiet $grp describe $name"; then
    echo "  create without preceding describe: $grp $name"; fail=1
  fi
done

if [ "$fail" -ne 0 ]; then echo "gcloud argument test FAILED"; exit 1; fi
echo "gcloud argument test passed"
