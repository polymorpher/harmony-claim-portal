# harmony-claim-portal

Claim lookup portal for the Harmony to Ethereum ERC-20 migration: a
PostgreSQL database holding per-wallet cutoff claims and routing decisions, a
rate-limited single-address lookup API, a wallet-connect frontend at
`https://migrate.country`, and the GCP and Cloudflare scripts that deploy them.

## Layout

```text
.env.example                   every variable the scripts read; copy to .env (gitignored)
infra/lib.sh                   shared helpers (env loading, idempotent gcloud wrappers)
infra/gcp/00-create-project.sh project (skip-if-exists), billing link, APIs
infra/gcp/10-create-vm.sh      static IP, firewall (IAP SSH, LB health checks), VM + bootstrap
infra/gcp/vm/bootstrap.sh      runs on the VM: PostgreSQL 18 (PGDG), Node 22, pnpm, app user, env file
infra/gcp/20-setup-frontend-bucket.sh   public GCS bucket with SPA fallback
infra/gcp/30-setup-load-balancer.sh     global HTTPS LB, /api/* -> VM, Certificate Manager cert, 80 -> 443
infra/cloudflare/{lib,setup-dns}.sh     proxied A records, _acme-challenge CNAMEs, strict SSL, HTTPS-only
db/migrations/001_schema.sql   schema (amounts NUMERIC(78,0) in atto-ONE)
db/seed/reason_texts.json      reason_code -> user-facing title/text (+ apply-reason-texts.sh)
injector/                      Python loader: harmony-migration CSVs -> Postgres (COPY + atomic swap)
backend/                       Fastify + TypeScript API, systemd unit, deploy/tunnel/logs scripts
frontend/                      Vite + React + wagmi/viem UI, deploy script
shared/                        @hcp/shared: API types, BigInt atto formatting, one1 bech32
scripts/dev-postgres.sh        user-owned local PostgreSQL 18 for development
```

## API

Single-address lookups only; there are no list, search or aggregate endpoints.

- `GET /api/health` - liveness + DB ping (used by the LB health check)
- `GET /api/v1/meta` - cutoff blocks/time, threshold, data version, loaded_at
- `GET /api/v1/claims/:address` - `0x...` (any case, EIP-55 validated when
  mixed case) or `one1...`; returns the address in hex/checksum/bech32 forms,
  `account_type`, post-deduction `eligibility`, native/WONE `components`,
  `wallet_airdrop` (gross, not_issued, redistributed, held, net, deliverable,
  destination), `vault_positions[]`, `exchange_treatments[]`, a user-facing
  `disposition`, `adjustments[]`, and `notes[]`. Smart-contract amounts remain
  hidden unless `EXPOSE_CONTRACT_AMOUNTS=true`, while their reviewed next-stage
  treatment is still shown.

Rate limit: 30 requests/minute per client (`CF-Connecting-IP`, then first
`X-Forwarded-For`, then socket IP); 429 with `Retry-After`. Helmet headers,
`Cache-Control: no-store`.

## Development

```sh
pnpm install
pnpm --filter @hcp/shared build

scripts/dev-postgres.sh start                      # PostgreSQL 18 on port 5434
scripts/dev-postgres.sh createdb claims
psql "$(scripts/dev-postgres.sh url claims)" -f db/migrations/001_schema.sql
db/seed/apply-reason-texts.sh "$(scripts/dev-postgres.sh url claims)"

# synthetic data (Hardhat dev addresses, made-up amounts)
python3 -m venv injector/.venv && injector/.venv/bin/pip install -e injector
injector/.venv/bin/python injector/inject_claims.py --fixture \
  --dsn "$(scripts/dev-postgres.sh url claims)" --data-version fixture-1

# API on :8080, frontend on :5173 (proxies /api to :8080)
DATABASE_URL="$(scripts/dev-postgres.sh url claims)" pnpm --filter @hcp/backend dev
pnpm --filter @hcp/frontend dev

# checks
pnpm --filter @hcp/backend test                                        # unit + http tests
TEST_DATABASE_URL="$(scripts/dev-postgres.sh url claims)" pnpm --filter @hcp/backend test   # + integration
pnpm build                                                             # shared, backend, frontend
pnpm shellcheck
pnpm test:infra                                                        # gcloud scripts against a stub gcloud (offline)
injector/.venv/bin/python injector/inject_claims.py --migration-repo ~/git/harmony-migration --dry-run
```

## Runbook (production)

All scripts are idempotent bash over `gcloud`/`curl`; re-running is safe.

1. `cp .env.example .env` and fill in values. Scripts load `.env` themselves.
2. Infrastructure, in order:
   1. `infra/gcp/00-create-project.sh` - reuses `GCP_PROJECT` if it exists, links billing when `BILLING_ACCOUNT` is set, enables APIs.
   2. `infra/gcp/10-create-vm.sh` - waits for the bootstrap marker (PostgreSQL, Node, app user, `/etc/harmony-claim-api.env` with a generated DB password).
   3. `infra/gcp/20-setup-frontend-bucket.sh`
   4. `infra/gcp/30-setup-load-balancer.sh --no-wait` - creates the load balancer and Certificate Manager DNS authorizations.
   5. `infra/cloudflare/setup-dns.sh --acme-only` - creates only the DNS-only `_acme-challenge` CNAMEs.
   6. `infra/gcp/30-setup-load-balancer.sh` - waits for the certificate to report `ACTIVE` without sending traffic to an unready origin.
3. Application:
   1. `backend/deploy/deploy-backend.sh` - builds locally, uploads over IAP, applies pending `db/migrations/*.sql`, seeds reason texts, installs the unit, restarts, health-checks.
   2. `frontend/deploy/deploy-frontend.sh` - builds, `gcloud storage rsync` to the bucket, cache headers, CDN invalidation.
4. Data:
   - Until the embargo is lifted, load only synthetic data on the public VM:
     `backend/deploy/tunnel-db.sh` (keep open), then
     `python3 injector/inject_claims.py --fixture --dsn "$(backend/deploy/tunnel-db.sh --print-dsn)" --data-version fixture-1`.
   - Embargo-lift step (operator decision): with the tunnel open,
     `python3 injector/inject_claims.py --migration-repo ~/git/harmony-migration --dsn "$(backend/deploy/tunnel-db.sh --print-dsn)" --data-version 2026-09-17 --validator-names`.
     Run `--dry-run` first. The load is a staging-schema swap, so the API never sees partial data.
5. Public cutover:
   1. `infra/cloudflare/setup-dns.sh --cutover [--rate-limit]` - creates proxied A records, keeps the ACME CNAMEs DNS-only, and applies SSL Full (strict), Always Use HTTPS, and TLS 1.2+.
   2. Verify `curl -fsS https://$DOMAIN/api/health` and a known approved fixture or real claim.

Operations: `backend/deploy/logs.sh` tails the API journal; `backend/deploy/tunnel-db.sh` opens `localhost:5433 -> VM:5432`.

## Data source and embargo

Claim amounts and routing come from the
[harmony-migration](https://github.com/polymorpher/harmony-migration) toolkit
outputs. This repo contains no claim data; the injector reads it from a local
checkout given by `--migration-repo`. Per-address numbers are under the
numerical embargo described in that repo's `docs/numerical-embargo.md`: the
portal exposes only single-address lookups, tests use synthetic fixtures, and
loading real data into the public VM is a deliberate operator step.
