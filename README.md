# harmony-claim-portal

Claim lookup portal for the Harmony to Ethereum ERC-20 migration: a
PostgreSQL database holding per-wallet cutoff claims and routing decisions, a
rate-limited single-address lookup API, a wallet-connect frontend at
`https://migrate.country` (including `/bridge`, which claims the LayerZero
bridge collateral on five chains), and the GCP and Cloudflare scripts that
deploy them.

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
db/migrations/009_tx_archive.sql   transaction archive for /history (archive_meta, archive_records)
db/migrations/010_tx_archive_calldata.sql   calldata and function names for the archive (archive_methods)
db/migrations/011_vault_metadata.sql   governor vault display names (schema vault)
db/ops/                        role split, candidate load, confirmed-wallets report, export, review, backup (see db/ops/README.md)
db/seed/reason_texts.json      reason_code -> user-facing title/text (+ apply-reason-texts.sh)
injector/                      Python loaders: harmony-migration CSVs -> Postgres (COPY + atomic swap) for claims and the transaction archive; vault catalog builder; bridge claim proof files
backend/                       lookup API, confirmation API, and the proxy in front of them
frontend/                      Vite + React + wagmi/viem UI, deploy scripts (site, bridge claim proofs)
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
  including stake released from the governor vaults, is stage
  `exchange_manual` with treatment `manual_from_reserve`, sent separately from
  the 2050 reserve to the destination(s) the exchange confirmed (consolidation
  address, split wallet/staking addresses, the same address, or Gate's tiers).
  Smart-contract amounts remain hidden unless
  `EXPOSE_CONTRACT_AMOUNTS=true`, while reviewed next-stage or not-issued
  treatment is still shown.

Transaction archive (`/history`), served by the same lookup process and role:

- `GET /api/v1/archive/meta` - archive coverage (shard, branch, block range and
  times), minimum value, coverage notes, data version, row counts;
  `available: false` before the first load
- `GET /api/v1/archive/address/:address?before=<id>&limit=<1..100>` - records
  sent or received by one address, newest first, 50 per page; pass
  `next_before` as `before` for the next page. Self-transfers appear once.
- `GET /api/v1/archive/tx/:hash` - every record of one transaction, by Harmony
  hash or Ethereum-style hash: the transaction, its internal transfers, its
  cross-shard receipt with the destination credit, or its staking operation,
  on both branches when a rolled-back transaction was included again. 404 when
  nothing is archived.

Each record carries `record_type` (`transaction`, `internal`, `cross_shard`,
`staking`), `kind`, `shard`/`to_shard`, `branch` (`canonical` or
`rolled_back`, the blocks abandoned by the August 2026 rollback), block number
and hash, time, both hashes, `from`/`to`, `value_atto`/`value_one`, `fee_atto`,
`status` (`failed` also marks an internal transfer inside a reverted call),
`method`, and for cross-shard receipts `ancestor_reverted` and `destination`.

Rate limit: 30 requests/minute per browser (client IP plus User-Agent) and
300/minute per IP. The client IP is `CF-Connecting-IP`, then the first
`X-Forwarded-For` hop, then the socket. The looked-up address is not part of
the limit. 429 includes `Retry-After`. Helmet headers, `Cache-Control: no-store`.
The confirmation process uses the same rule with its own lower per-browser cap.

The lookup page shows what has been delivered without asking the API: the
browser reads Ethereum for the reserve's ONE transfers to the wallet part's
destination, and its `Deposit` events crediting each vault position's
delegator in that validator's governor vault from the vault catalog. Each part
shows its allocation, what was received, and the transaction and date; "Not
sent yet" only when the read succeeded. Exchange wallets, which are paid
separately, show nothing. A wallet that can confirm on `/confirm` shows when it
confirmed instead of the button, from `GET /api/v1/confirmations/:address`.
The endpoints are the `/vault` page's (`VITE_ETH_RPC_URLS`), so the looked-up
address goes to them.

`/confirm` is the only page that asks for a signature. It is for key-controlled
wallets deferred because their last indexed activity is outside the six-month
window, or because no activity was indexed. It records current control for a
later batch. It does not change the cutoff ledger, and a stored row is not
itself authorization: the export has to be recovered and checked before a
wallet is promoted.

Ways to sign:

- Browser wallet (MetaMask and other extensions, including MetaMask with a Ledger): `personal_sign`.
- WalletConnect: phone wallets, hardware wallet apps, and Ledger Wallet (formerly Ledger Live), `personal_sign`. Needs `VITE_WALLETCONNECT_PROJECT_ID`. Harmony (`eip155:1666600000`) is requested as an optional chain next to Ethereum mainnet. Ledger Wallet only holds Ethereum-app accounts (`44'/60'`).
  - WalletConnect has no way for a page to ask for a derivation path; the wallet picks the key behind each chain's account. A wallet that keeps Harmony addresses on Harmony's path (`44'/1023'`) can share one for Harmony and a different `44'/60'` one for Ethereum. wagmi only exposes the accounts of the session's current chain, so `frontend/src/useWallet.ts` reads every `eip155` account in the session, defaults to the first one shared on Harmony, lets the user pick another (`WalletAccounts`), and sends `personal_sign` on a chain the session shares the chosen address on. The signature must recover to that address before it is submitted.
  - An address the wallet does not share at all cannot be used over WalletConnect. When a connected browser wallet or WalletConnect address is not eligible and has no claim (`found: false`), the confirm page suggests choosing the Harmony address, or selecting the Harmony network or account in the wallet and reconnecting. Only as a last resort does it point to the offline key tool on `/ledger`, with the warning that the recovery phrase is then exposed.
- Ledger over USB (WebHID, Chrome, Edge, or Brave on a computer), talking to the device directly:
  - 2025 Harmony app (Ledger's Ethereum-app build for Harmony, `44'/1023'/0'/0/N`): `personal_sign`, shown on the device.
  - Ethereum app (`44'/60'`, Ledger Wallet, MetaMask, and legacy MyEtherWallet paths): `personal_sign`.
  - Pre-2025 Harmony app ("Harmony One", Nano S era, `44'/1023'/0'/0/0` only): this app cannot sign messages. It signs a Harmony transaction that sends 0 ONE from the address to itself with gas price 0 and gas limit 0, with the confirmation message as data. Harmony nodes reject any transaction below intrinsic gas, so it cannot be broadcast. Stored as `harmony_ledger_tx`; `shared/src/harmony-ledger-tx.ts` builds the signed bytes.

Confirmation routes:

- `GET /api/v1/confirmations/:address` - eligibility and whether a signature is already stored
- `POST /api/v1/confirmations/challenges` - a random nonce and the exact message to sign; nothing is stored
- `POST /api/v1/confirmations` - the signature, nonce, issued time, and `signature_scheme` (`personal_sign`, the default, or `harmony_ledger_tx`). The server rebuilds the message, checks it is still inside the time window, and verifies the signature under that scheme

Governor vault names (off-chain; the contract is unchanged):

- `GET /api/v1/vault-metadata` - every stored display name. The lookup process serves this. A vault with no row keeps the name from the catalog.
- `POST /api/v1/vault-metadata/name-challenges` - body `{ vault, name }`. Returns the exact message to sign. Nothing is stored.
- `POST /api/v1/vault-metadata/names` - body `{ vault, name, nonce, issued_at, signature, signature_scheme }`. The confirmation process rebuilds the message, checks the time window, reads `governor()` on Ethereum, and accepts the signature only when it is the current governor of an audited vault. The latest name is updated and the signed change is appended.

`signature_scheme` is `personal_sign` or `harmony_ledger_tx`, the same two ways `/confirm` signs. A name is 1 to 80 characters with no line breaks. `fields` on the metadata row is reserved for later off-chain values; this API does not write it.

## Transaction history (`/history`)

The Harmony explorer is shut down. `/history` keeps a fixed record of every
Harmony transaction that moved at least 1 ONE from 2025-01-01 until the chain
stopped: plain transactions (failed ones marked), internal transfers made by
contracts, cross-shard receipts (including those created inside reverted
calls before the epoch-2964 fix), and staking amounts, on shards 0 and 1, plus
the blocks that the August 2026 rollback abandoned, labeled as never final.

Enter an address (`0x…` or `one1…`) or a transaction hash. `/history?address=<address>`
lists the address's records newest first; `/history?tx=<hash>` shows one
transaction. Links use the query string so that every link loads the real
`/history` object from the bucket. The older `/history/address/…` and
`/history/tx/…` forms still render. The footer shows the archive's block coverage and its notes (for
example, a range known to hold no transactions).

The archive is built by harmony-migration (`docs/tx-archive.md`, `make
tx-archive`) and loaded with `injector/inject_archive.py`. It is chain data,
not claim results, and is not under the numerical embargo. The 2026-10-21
archive has 1.12 million records: about 650 MB in PostgreSQL (280 MB table,
370 MB indexes), and a load takes about 15 seconds. Address pages and hash
lookups are index scans that take well under a millisecond, even for the
busiest address.

## Governor Vaults (`/vault`)

Each Harmony validator's delegated stake at the cutoff is held in a governor
vault on Ethereum (`GovernorDelegator` in harmony-migration), with the
validator as its governor. `/vault` lists the deployed governor vaults and
`/vault/<vault address>` shows one. It loads one static file,
`/vault-catalog.json`, reads chain state on Ethereum and Base, and reads
display names from `GET /api/v1/vault-metadata`. A vault was deployed only
for a validator with at least 10,000 ONE. Validators below that are listed
only when the page is asked to include them. Vaults whose governors have
signed the governor agreement are listed first. The others stay in a collapsed
section unless a search matches them.

- From the catalog: each planned vault's validator, its Harmony name and
  commission at the cutoff, the initial governor, and per-vault totals of the
  cutoff delegations by stage (initial, inactive, under 1,000 ONE, exchange,
  next stage, not issued). It has no delegator list. The page accepts the
  catalog only if its creation code hashes to the audited build and every
  vault address is that code's CREATE2 address for its validator and governor.
- From Ethereum: whether each vault is deployed, its size, governor and
  `feeBps`, and every `Deposit`, `Withdraw`, `GovernorTransferred` and
  `FeeUpdated` event since the first vault deployment. Delegators now, what the
  reserve Safe has credited, the governor and fee history, and recent activity
  are computed from those events. Inactive delegators still waiting are the
  inactive total at the cutoff minus the reserve's credits beyond the initial
  stage.
- From Base: whether the validator signed its governor agreement on
  [governors.country](https://governors.country/). The catalog holds each
  validator's agreement id (from governors.country's `agreements.json`) and a
  snapshot of its status; the page reads the live signature count from the
  MetaLeX CyberAgreementRegistry (`0xa9E808B8eCBB60Bb19abF026B5b863215BC4c134`,
  `agreements(bytes32)`) in one multicall, and shows the snapshot until that
  answers or if it fails. A renewed agreement has a new id, so after
  governors.country renews agreements, refresh the catalog's ids with
  `build_vault_catalog.py --agreements-only` and redeploy the frontend;
  until then the page reads the old agreements.

A `feeBps` of 0 means the validator's Harmony commission at the cutoff applies;
the page shows that commission and, once a governor sets a fee, the change.

With a connected wallet the page withdraws (to the connected address by
default; another address takes a second confirmation), deposits from the
connected wallet (an exact-amount approval, then `deposit`), and, for the
governor, sets the fee or transfers the role. Before the first withdrawal from
an address the signer must agree to the release text in
`frontend/src/vault/release.ts`; the browser remembers it per address in
`localStorage`.

The connected governor can set the vault's public name by signing the message
from `POST /api/v1/vault-metadata/name-challenges`. That signature does not
send a transaction. The Harmony Ledger apps can sign it; they still cannot
send an Ethereum transaction. The name is the validator's name at the cutoff
until a governor changes it.

Wallets: browser wallets, WalletConnect, and Ledger over USB. The Ledger
Ethereum app signs EIP-1559 transactions (`44'/60'` paths; contract calls need
Blind signing on). The two Harmony Ledger apps connect but cannot send: the
2025 app is Ledger's Ethereum app built for chain 1666600000 and refuses any
other chain ID, and the older app only signs Harmony transactions. Neither has
the Ethereum app's paths, so an address on `44'/1023'` cannot sign Ethereum
transactions from a Ledger; the page shows it view-only. Likewise an address a
WalletConnect session shares only for Harmony is view-only on Ethereum: the
wallet would sign there with its Ethereum account. It can still sign the
vault-name message.

Build the catalog from a harmony-migration checkout before deploying the
frontend (it needs the Harmony archive RPC for names and commissions):

```sh
# the newest approved confirmed-wallets export (db/ops/confirmed-wallets.sh --decision approved --csv)
E=data/confirmed-wallets/confirmed-wallets-<time>-decision-approved-vault-pending-vault-shares.csv
python3 injector/build_vault_catalog.py --migration-repo ~/git/harmony-migration --portal-export $E
# Sepolia rehearsal vaults, for development:
python3 injector/build_vault_catalog.py --chain-id 11155111 --portal-export $E --out frontend/public/vault-catalog.sepolia.json
VITE_VAULT_CATALOG_URL=/vault-catalog.sepolia.json pnpm --filter @hcp/frontend dev
# after governors.country renews agreements: only the agreement ids and their status
python3 injector/build_vault_catalog.py --agreements-only
```

`--portal-export` moves delegators approved on the portal out of "inactive":
before their vault is funded they show as approved and waiting for funding. A
vault with no reserve deposit yet shows "Waiting for funding" and what its
funding will credit; once funded it shows its size against the amount funded.

The catalog's per-vault totals are numbers under harmony-migration's numerical
embargo; the file is git-ignored and is published by deploying it. RPC
endpoints come from `VITE_ETH_RPC_URLS` (see `.env.example`).

The lookup process uses the `claim_read` role. The confirmation process uses
`claim_confirm` and cannot write the claim tables. The owner role used by
migrations and the injector is not in either process. See `db/ops/README.md`.

The Governor and fee section lists the latest three governor and fee changes,
newest first, and the rest on request.

## Harmony addresses on a Ledger (`/ledger`)

A Ledger's Harmony apps can show a `44'/1023'` address on `/vault` but cannot
send Ethereum transactions for it, and neither the ONE token nor the vaults
accept anything but a transaction from the address. `/ledger`, linked from
the vault page's view-only notices, explains this and how to recover the
address's private key offline and import it into an Ethereum wallet. It also
covers other wallets that keep Harmony addresses on `44'/1023'` and give sites
only their Ethereum address, and it presents key recovery as the last resort.
The confirm page links there in its no-claim hint.

It links to `ledger-key-tool.html`, built from `frontend/ledger-key-tool.html`
and `frontend/src/keytool/` by `vite.keytool.config.ts` as one self-contained
file. Its Content-Security-Policy allows only its own inline script (by hash)
and inline styles, so it can make no network request. It checks the BIP-39
checksum and derives `m/44'/1023'/0'/0/N` with an optional passphrase
(`src/keytool/derive.test.ts` has vectors from Foundry's `cast`). The build
writes `ledger-key-tool.html.sha256` beside it, `/ledger` shows that hash, and
a rebuild from the same source gives the same file.

## Bridge claims (`/bridge`)

The LayerZero bridge collateral is paid by one immutable `BridgeClaims`
contract per chain (harmony-migration `bridge-claims/`) on Ethereum, BNB Chain,
Arbitrum, Base, and Linea. Each contract pays a fixed list from the custody Safe's
approvals, once per row and always to the row's address, and anyone may
submit a row. `/bridge?address=<0x… or one1…>` shows an address's rows on
every chain and claims them. It needs no API and stores nothing. Until claims
open, its "Bridge claims" tab is unlisted: it shows only on `/bridge`, so no
other page links there. Remove `unlisted` from its entry in
`frontend/src/Nav.tsx` to list it.

- The page trusts only `frontend/src/bridge/deployments.json`: each contract's
  chain, address, root, row count, list hash, runtime code hash, and assets.
  `src/bridge/bridge.test.ts` pins the addresses, roots, and code hashes to the
  audit's deployment commitments, so a regenerated file for another run fails
  the tests until they are updated with it.
- It loads the address's rows and proofs from one file in the public claims
  bucket, `<run>/proofs/<first four hex digits>.json`. It refuses the file
  unless every row names a listed asset and its proof leads to that
  contract's root. A wrong file can only leave rows out, and the contract
  pays the row's address whatever the page sends.
- On each chain it checks that the contract's runtime code hashes to the
  recorded value (the code embeds all six immutables), then reads `isClaimed`
  and `available` in one multicall. A row is "Ready" when the custody Safe's
  approval and balance cover it, and "Not open yet" before that.
- "Claim N assets on <chain>" simulates `claimMany` with every payable row,
  then sends it from the connected wallet (which is asked to switch networks)
  or a Ledger's Ethereum app over USB. Rows not open yet are left out, since
  one failed transfer would revert the batch. The sender pays the fee and need
  not be the payee, so another wallet can claim for a Harmony Ledger address.

Reads use `VITE_ETH_RPC_URLS` for Ethereum and `VITE_BSC_RPC_URLS`,
`VITE_ARBITRUM_RPC_URLS`, `VITE_BASE_RPC_URLS`, and `VITE_LINEA_RPC_URLS` for
the other chains. Empty values select public endpoints that allow browser
requests.

To publish a run's claims once its contracts are deployed:

```sh
R=~/git/harmony-migration/bridge-claims/runs/bridge-allocations-20261029
injector/.venv/bin/python injector/build_bridge_proofs.py build \
  --claims-dir $R --deploy-record $R/deploy-20261029T081859Z/deployments.json \
  --allocations-dir ~/git/harmony-migration/artifacts/bridge-allocations-20261018/allocations-20261028
pnpm --filter @hcp/frontend test           # deployments.json still names the audited contracts
frontend/deploy/publish-bridge-proofs.sh   # proofs/ beside the run in the public bucket, then an anonymous check
frontend/deploy/deploy-frontend.sh         # the page with that deployments.json
```

`build` refuses the run unless:

- every file in the run's public `SHA256SUMS` hashes the same locally;
- each manifest agrees with `summary.json`;
- every row of `claims.csv` is well formed, sorted, and adds up to its
  asset's total;
- the tree rebuilt from the rows has the manifest's root and tree-file hash,
  and gives the proofs in `samples.json`;
- the deployment record shows each contract at its address with the expected
  runtime code and immutables;
- the allocation summary is the one the claim run records, and the snapshot
  plan and bridge state beside it are the ones that summary records, with
  every asset's pools on a recorded snapshot block.

From the last two it also records, for the page's explanation of amounts,
every chain's block at the cutoff, before Harmony's August 2026 rollback, and
where escrows were read, and which holders and moment each asset's rows
start from.

It writes `deployments.json`, which holds no address-level data and is
committed. It also writes 65,536 proof files with `index.json`, `README.md`,
and `SHA256SUMS` under `injector/out/bridge-proofs/<run>/proofs/`, which is
ignored. The files total 1.3 GB, about 18 KB each, and are uploaded
gzip-encoded. With pycryptodome (the injector venv) a build takes about 20
seconds. `verify-published` repeats the anonymous check of the bucket
against the local build.

A fork test claims one payee's rows with the page's own code after approving
them from the impersonated custody Safe, and checks the payee's balances. It
is skipped unless a fork is given:

```sh
anvil --fork-url "$BSC_RPC" --port 8545
BRIDGE_FORK_LABEL=bsc BRIDGE_FORK_RPC_URL=http://127.0.0.1:8545 \
  BRIDGE_FORK_PROOFS=$PWD/injector/out/bridge-proofs/<run>/proofs \
  pnpm --filter @hcp/frontend exec vitest run src/bridge/fork.test.ts   # BRIDGE_FORK_PAYEE=0x… picks the payee
```

During development the page reads the published proofs. Before a run is
published, set `VITE_BRIDGE_PROOFS_URL` to a server for the local
`proofs/` folder that sends `Access-Control-Allow-Origin`.
`deploy-frontend.sh` refuses to build while it is set.

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
injector/.venv/bin/python injector/inject_archive.py --fixture \
  --dsn "$(scripts/dev-postgres.sh url claims)" --data-version archive-fixture-1

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
pnpm --filter @hcp/frontend test                                       # Ledger framing and signing against emulated apps, vault and bridge logic
pnpm test:ops                                                          # candidate selection, review, vault catalog, bridge proofs
TEST_DATABASE_URL="$(scripts/dev-postgres.sh url claims)" pnpm --filter @hcp/backend test   # + integration (claims and archive fixtures)
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
   1. `backend/deploy/deploy-backend.sh` - builds locally, uploads over IAP, applies pending `db/migrations/*.sql`, seeds reason texts, runs `db/ops/setup-roles.sh --vm`, installs the lookup, confirmation, and proxy units, restarts, health-checks. When `VAULT_ETH_RPC_URLS` is set, it is written into the confirm process env so a governor can change a vault's name.
   2. `python3 injector/build_vault_catalog.py --migration-repo ~/git/harmony-migration --portal-export <approved vault-shares export>` - writes `frontend/public/vault-catalog.json` for `/vault`. It lists every planned vault, so new deployments and fundings need no rerun; rerun when the migration's vault inputs change or after approving more confirmations. After governors.country renews agreements, `--agreements-only` re-reads just the agreement ids and their status into the existing catalog.
   3. For `/bridge`, once per claim run: `injector/build_bridge_proofs.py build` and `frontend/deploy/publish-bridge-proofs.sh` (see "Bridge claims").
   4. `frontend/deploy/deploy-frontend.sh` - builds, `gcloud storage rsync` to the bucket, cache headers, CDN invalidation.
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
   - Transaction archive (independent of the claim release gates): with the
     tunnel open, `python3 injector/inject_archive.py --archive-dir <harmony-migration tx-archive output>
     --dsn "$(backend/deploy/tunnel-db.sh --print-dsn)" --data-version <archive date>`.
     Run `--dry-run` first; it verifies every file against `manifest.json`.
     Needs `db/migrations/009_tx_archive.sql` and `010_tx_archive_calldata.sql`, which `deploy-backend.sh` applies.
   - After a data load that changes the exchange inventory, reload the
     confirmation candidates (`db/ops/load-candidates.sh`, see
     `db/ops/README.md`) so newly listed exchange wallets cannot sign.
5. Public cutover:
   1. `infra/cloudflare/setup-dns.sh --cutover [--rate-limit]` - creates proxied A records, keeps the ACME CNAMEs DNS-only, and applies SSL Full (strict), Always Use HTTPS, and TLS 1.2+.
   2. Verify `curl -fsS https://$DOMAIN/api/health` and a known approved fixture or real claim.

Operations: `backend/deploy/logs.sh` tails the API journal; `backend/deploy/tunnel-db.sh` opens `localhost:5433 -> VM:5432`.

Node security releases: bootstrap installs Node once and unattended upgrades
cover Debian only, so Node on the VM changes only through the deploy scripts.
Raise `NODE_MIN_VERSION` in `.env`, then run `backend/deploy/upgrade-node.sh`.
It upgrades the NodeSource package, restarts the units still running the old
binary, and health-checks without shipping a release. `deploy-backend.sh`
applies the same floor before it installs a release.

## Data source and embargo

Claim amounts and routing come from the
[harmony-migration](https://github.com/polymorpher/harmony-migration) toolkit
outputs. This repo contains no claim data; the injector reads it from a local
checkout given by `--migration-repo`. Per-address numbers are under the
numerical embargo described in that repo's `docs/numerical-embargo.md`: the
portal exposes only single-address lookups, tests use synthetic fixtures, and
loading real data into the public VM is a deliberate operator step.
