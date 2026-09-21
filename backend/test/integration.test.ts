/**
 * Runs only when TEST_DATABASE_URL points at a database loaded with
 * `injector/inject_claims.py --fixture`. Verifies the SQL repository and the
 * end-to-end lookup against the synthetic rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { PgRepository } from "../src/repository.js";
import { ADDR } from "./fixtures.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("integration against fixture database", () => {
  let app: FastifyInstance;
  let repo: PgRepository;

  beforeAll(async () => {
    repo = new PgRepository(url!);
    app = await buildApp({
      config: { rateLimitMax: 1000, rateLimitWindow: "1 minute", exposeContractAmounts: false, logLevel: "silent", trustProxy: true },
      repo,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await repo.close();
  });

  it("meta comes from snapshot_meta", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/meta" });
    expect(res.statusCode).toBe(200);
    expect(res.json().fixture).toBe(true);
    expect(res.json().cutoff.shard0.block).toBe(93623067);
    expect(res.json().loaded_at).toBeTruthy();
  });

  it("excluded fixture account is fully not issued", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/claims/${ADDR.excl}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.account_type).toBe("excluded");
    expect(body.wallet_airdrop.issuable_atto).toBe("0");
    expect(body.eligibility.total_claim_atto).toBe("0");
    expect(body.eligibility.meets_threshold).toBe(true);
    expect(body.eligibility.status).toBe("not_issuing");
    expect(body.vault_positions).toHaveLength(2);
    for (const p of body.vault_positions) expect(p.expected_shares_atto).toBe("0");
    expect(body.adjustments.every((a: { kind: string }) => a.kind === "deduction")).toBe(true);
    expect(body.adjustments[0].title).toMatch(/extra-mint/);
  });

  it("validator fixture account resolves vault totals and same-address", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/claims/${ADDR.v1}` });
    const body = res.json();
    expect(body.account_type).toBe("validator_account");
    expect(body.vault_positions[0].vault.assets_one).toBe("17005");
    expect(body.wallet_airdrop.destination.address).toBe(ADDR.v1);
  });

  it("contract fixture account hides amounts", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/claims/${ADDR.safe}` });
    const body = res.json();
    expect(body.account_type).toBe("contract");
    expect(body.contract_category).toBe("multisig-wallet");
    expect(body.eligibility).toBeNull();
    expect(body.disposition.code).toBe("multisig_next_stage");
    expect(body.migration_policy.total_allocation_atto).toBeNull();
  });

  it("deferred fixture account with explicit route and hold remainder", async () => {
    const deferred = "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f";
    const res = await app.inject({ method: "GET", url: `/api/v1/claims/${deferred}` });
    const body = res.json();
    expect(body.eligibility.status).toBe("deferred");
    expect(body.wallet_airdrop.not_issued_one).toBe("200");
    expect(body.wallet_airdrop.held_one).toBe("300");
    expect(body.wallet_airdrop.issuable_one).toBe("0");
    expect(body.wallet_airdrop.destination.status).toBe("hold");
    expect(body.disposition.code).toBe("gate_deferred");
  });

  it("loads WONE component fields from the fixture", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/claims/${ADDR.eoa}` });
    const body = res.json();
    expect(body.components.wone_balance_one).toBe("250");
    expect(body.components.wone_airdrop_one).toBe("250");
    expect(body.components.native_wallet_airdrop_atto).not.toBe(body.wallet_airdrop.gross_atto);
  });

  it("loads exchange-controlled routing metadata", async () => {
    const exchange = "0xa0ee7a142d267c1f36714e4a8f75612f20a79720";
    const res = await app.inject({ method: "GET", url: `/api/v1/claims/${exchange}` });
    const body = res.json();
    expect(body.exchange_treatments[0].display_name).toBe("OKX");
    expect(body.migration_policy.stage).toBe("deferred");
    expect(body.disposition.code).toBe("deferred");
    expect(body.wallet_airdrop.issuable_atto).toBe("0");
  });

  it("does not assign an entitlement or destination to exchange-only inventory", async () => {
    const exchangeOnly = "0x5555555555555555555555555555555555555555";
    const res = await app.inject({ method: "GET", url: `/api/v1/claims/${exchangeOnly}` });
    const body = res.json();
    expect(body.found).toBe(false);
    expect(body.eligibility).toBeNull();
    expect(body.disposition.code).toBe("exchange_no_claim");
    expect(body.exchange_treatments[0].destination.status).toBe("none");
  });

  it("unknown address", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/claims/0x${"ab".repeat(20)}` });
    expect(res.json().found).toBe(false);
  });
});
