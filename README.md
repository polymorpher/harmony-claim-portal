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
db/migrations/005_confirm_schema.sql   confirmation candidates and append-only signatures
db/migrations/006_confirm_signature_scheme.sql   records how each confirmation was signed
db/ops/                        role split, candidate load, confirmed-wallets report, export, review, backup (see db/ops/README.md)
db/seed/reason_texts.json      reason_code -> user-facing title/text (+ apply-reason-texts.sh)
injector/                      Python loader: harmony-migration CSVs -> Postgres (COPY + atomic swap)
backend/                       lookup API, confirmation API, and the proxy in front of them
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
  `account_type`, snapshot `eligibility`, separate `migration_policy`,
  native/WONE `components`,
  `wallet_airdrop` (gross, not_issued, redistributed, held, net, manual
  delivery, deliverable, destination), `vault_positions[]`,
  `exchange_treatments[]`, a user-facing `disposition`, `adjustments[]`, and
  `notes[]`. The migration policy separates the six-month initial stage, later
  stages, exchange manual delivery, and terminal non-issuance from destination
  readiness. Exchange wallets are never airdropped: their whole entitlement,
  including stake released from the validator vaults, is stage
  `exchange_manual` with treatment `manual_from_reserve`, sent separately from
  the 2050 reserve to the destination(s) the exchange confirmed (consolidation
  address, split wallet/staking addresses, the same address, or Gate's tiers).
  Smart-contract amounts remain hidden unless
  `EXPOSE_CONTRACT_AMOUNTS=true`, while reviewed next-stage or not-issued
  treatment is still shown.

Rate limit: 30 requests/minute per browser (client IP plus User-Agent) and
300/minute per IP. The client IP is `CF-Connecting-IP`, then the first
`X-Forwarded-For` hop, then the socket. The looked-up address is not part of
the limit. 429 includes `Retry-After`. Helmet headers, `Cache-Control: no-store`.
The confirmation process uses the same rule with its own lower per-browser cap.

`/confirm` is the only page that asks for a signature. It is for key-controlled
wallets deferred because their last indexed activity is outside the six-month
window, or because no activity was indexed. It records current control for a
later batch. It does not change the cutoff ledger, and a stored row is not
itself authorization: the export has to be recovered and checked before a
wallet is promoted.

Ways to sign:

- Browser wallet (MetaMask and other extensions, including MetaMask with a Ledger): `personal_sign`.
- WalletConnect: phone wallets and Ledger Wallet (formerly Ledger Live), `personal_sign`. Needs `VITE_WALLETCONNECT_PROJECT_ID`. Harmony (`eip155:1666600000`) is requested as an optional chain next to Ethereum mainnet. Ledger Wallet only holds Ethereum-app accounts (`44'/60'`).
- Ledger over USB (WebHID, Chrome, Edge, or Brave on a computer), talking to the device directly:
  - 2025 Harmony app (Ledger's Ethereum-app build for Harmony, `44'/1023'/0'/0/N`): `personal_sign`, shown on the device.
  - Ethereum app (`44'/60'`, Ledger Wallet, MetaMask, and legacy MyEtherWallet paths): `personal_sign`.
  - Pre-2025 Harmony app ("Harmony One", Nano S era, `44'/1023'/0'/0/0` only): this app cannot sign messages. It signs a Harmony transaction that sends 0 ONE from the address to itself with gas price 0 and gas limit 0, with the confirmation message as data. Harmony nodes reject any transaction below intrinsic gas, so it cannot be broadcast. Stored as `harmony_ledger_tx`; `shared/src/harmony-ledger-tx.ts` builds the signed bytes.

Confirmation routes:

- `GET /api/v1/confirmations/:address` - eligibility and whether a signature is already stored
- `POST /api/v1/confirmations/challenges` - a random nonce and the exact message to sign; nothing is stored
- `POST /api/v1/confirmations` - the signature, nonce, issued time, and `signature_scheme` (`personal_sign`, the default, or `harmony_ledger_tx`). The server rebuilds the message, checks it is still inside the time window, and verifies the signature under that scheme

The lookup process uses the `claim_read` role. The confirmation process uses
`claim_confirm` and cannot write the claim tables. The owner role used by
migrations and the injector is not in either process. See `db/ops/README.md`.

## Development

```sh
pnpm install
pnpm --filter @hcp/shared build

scripts/dev-postgres.sh start                      # PostgreSQL 18 on port 5434
scripts/dev-postgres.sh createdb claims
for f in db/migrations/*.sql; do
  psql "$(scripts/dev-postgres.sh url claims)" -v ON_ERROR_STOP=1 -q -f "$f"
done
db/seed/apply-reason-texts.sh "$(scripts/dev-postgres.sh url claims)"

# synthetic data (Hardhat dev addresses, made-up amounts)
python3 -m venv injector/.venv && injector/.venv/bin/pip install -e injector
injector/.venv/bin/python injector/inject_claims.py --fixture \
  --dsn "$(scripts/dev-postgres.sh url claims)" --data-version fixture-1

# roles, then lookup :8081, confirm :8082, proxy :8080, frontend :5173
db/ops/setup-roles.sh --local
pnpm --filter @hcp/backend dev
pnpm --filter @hcp/backend dev:confirm
pnpm --filter @hcp/backend dev:proxy
pnpm --filter @hcp/frontend dev

# synthetic confirmation candidate (fixture address only; uses the local owner URL)
psql "$(grep '^DATABASE_URL=' backend/.env.owner | cut -d= -f2-)" -v ON_ERROR_STOP=1 -f db/ops/fixture-candidates.sql

# checks
pnpm --filter @hcp/backend test                                        # unit + http tests
pnpm --filter @hcp/frontend test                                       # Ledger framing and signing against emulated apps
pnpm test:ops                                                          # candidate selection
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
   1. `backend/deploy/deploy-backend.sh` - builds locally, uploads over IAP, applies pending `db/migrations/*.sql`, seeds reason texts, runs `db/ops/setup-roles.sh --vm`, installs the lookup, confirmation, and proxy units, restarts, health-checks.
   2. `frontend/deploy/deploy-frontend.sh` - builds, `gcloud storage rsync` to the bucket, cache headers, CDN invalidation.
4. Data:
   - Until the embargo is lifted, load only synthetic data on the public VM:
     `backend/deploy/tunnel-db.sh` (keep open), then
     `python3 injector/inject_claims.py --fixture --dsn "$(backend/deploy/tunnel-db.sh --print-dsn)" --data-version fixture-1`.
   - Release step (only after global routing, routing initial-stage, and the
     materialized initial-stage summary all report `ready`): with the tunnel open,
     `python3 injector/inject_claims.py --migration-repo ~/git/harmony-migration --dsn "$(backend/deploy/tunnel-db.sh --print-dsn)" --data-version 2026-09-17 --validator-names`.
     Run `--dry-run` first. The injector refuses a real load while any release
     gate is held unless `--allow-held-routing` is passed; the site then shows
     the held routing status and its preview banner. A load is a staging-schema
     swap, so the API never sees partial data.
   - After a data load that changes the exchange inventory, reload the
     confirmation candidates (`db/ops/load-candidates.sh`, see
     `db/ops/README.md`) so newly listed exchange wallets cannot sign.
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
