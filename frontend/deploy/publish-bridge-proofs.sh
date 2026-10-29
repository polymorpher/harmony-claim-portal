#!/usr/bin/env bash
# Publish the /bridge page's proof files to the public claims bucket, next to the
# run's claim lists, then check them anonymously against the local build.
#   python3 injector/build_bridge_proofs.py build --claims-dir ... --deploy-record ...   # first
#   frontend/deploy/publish-bridge-proofs.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../infra/lib.sh
source "$here/../../infra/lib.sh"
load_env
set_defaults
require_vars GCP_PROJECT BRIDGE_CLAIMS_BUCKET DOMAIN
require_tools gcloud python3

cd "$REPO_ROOT"
deployments=frontend/src/bridge/deployments.json
run="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["run"])' "$deployments")"
src="injector/out/bridge-proofs/$run/proofs"
dest="gs://$BRIDGE_CLAIMS_BUCKET/$run"
[ -f "$src/index.json" ] || die "$src is missing; build it with: python3 injector/build_bridge_proofs.py build"

log "checking $src against its SHA256SUMS and $deployments"
python3 - "$src" "$deployments" <<'PY' || die "$src is not the build that wrote $deployments"
import hashlib, json, pathlib, sys
src, deployments = pathlib.Path(sys.argv[1]), json.load(open(sys.argv[2], encoding="utf-8"))
for line in (src / "SHA256SUMS").read_text(encoding="ascii").splitlines():
    digest, name = line.split("  ", 1)
    if hashlib.sha256((src / name).read_bytes()).hexdigest() != digest:
        sys.exit(f"{name} does not match SHA256SUMS")
index = json.loads((src / "index.json").read_text(encoding="utf-8"))
pick = lambda c: (c["label"], c["chain_id"], c["address"].lower(), c["root"].lower(), c["claim_count"], c["list_sha256"])
if (index["run"], index["prefix_digits"], index["published_index_sha256"], [pick(c) for c in index["contracts"]]) != (
    deployments["run"], deployments["proof_prefix_digits"], deployments["published_index_sha256"], [pick(c) for c in deployments["contracts"]]
):
    sys.exit("index.json and deployments.json describe different runs or contracts")
print(f"{len(list(src.iterdir())) - 1} files match")
PY

# Stored gzip-encoded: browsers receive them compressed, other clients decompressed.
# The upload adds no-transform to Cache-Control, which stops that decompression,
# so the header is set again afterwards.
log "uploading $src -> $dest/proofs"
gc storage cp --recursive --gzip-local-all "$src" "$dest/"
gc storage objects update "$dest/proofs/**" --cache-control="public, max-age=3600" >/dev/null
gc storage objects update "$dest/proofs/SHA256SUMS" --content-type="text/plain; charset=utf-8" >/dev/null
gc storage objects update "$dest/proofs/README.md" --content-type="text/markdown; charset=utf-8" >/dev/null

log "checking the public copy"
python3 injector/build_bridge_proofs.py verify-published --origin "https://$DOMAIN"
log "done: https://storage.googleapis.com/$BRIDGE_CLAIMS_BUCKET/$run/proofs/README.md"
