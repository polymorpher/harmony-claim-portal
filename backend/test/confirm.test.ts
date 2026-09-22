import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hexToBech32 } from "@hcp/shared";
import type { FastifyInstance } from "fastify";
import { buildConfirmApp } from "../src/confirm/app.js";
import { CONFIRM_PURPOSE } from "../src/confirm/message.js";
import type {
  CandidateRow,
  ConfirmationRow,
  ConfirmStore,
  InsertResult,
} from "../src/confirm/store.js";

const key = generatePrivateKey();
const account = privateKeyToAccount(key);
const other = privateKeyToAccount(generatePrivateKey());
const address = account.address.toLowerCase();

class MemoryConfirmStore implements ConfirmStore {
  candidates = new Map<string, CandidateRow>();
  confirmations: ConfirmationRow[] = [];
  failPing = false;

  async ping(): Promise<void> {
    if (this.failPing) throw new Error("down");
  }
  async checkPrivileges(): Promise<void> {}
  async findCandidate(addr: string): Promise<CandidateRow | null> {
    return this.candidates.get(addr) ?? null;
  }
  async findConfirmation(addr: string, dataVersion: string, policyVersion: string): Promise<ConfirmationRow | null> {
    return this.confirmations.find((row) =>
      row.address === addr && row.data_version === dataVersion && row.policy_version === policyVersion) ?? null;
  }
  async insertConfirmation(input: {
    address: string;
    dataVersion: string;
    policyVersion: string;
    stageReason: string;
    message: string;
    signature: string;
    signer: string;
  }): Promise<InsertResult> {
    const candidate = this.candidates.get(input.address);
    if (!candidate) return { ok: false, reason: "candidate_missing" };
    if (candidate.data_version !== input.dataVersion || candidate.policy_version !== input.policyVersion) {
      return { ok: false, reason: "version_mismatch" };
    }
    if (this.confirmations.some((row) =>
      row.address === input.address && row.data_version === input.dataVersion && row.policy_version === input.policyVersion)) {
      return { ok: false, reason: "conflict" };
    }
    const created_at = new Date().toISOString();
    this.confirmations.push({
      address: input.address,
      data_version: input.dataVersion,
      policy_version: input.policyVersion,
      stage_reason: input.stageReason,
      message: input.message,
      signature: input.signature,
      signer: input.signer,
      created_at,
    });
    return { ok: true, created_at };
  }
  async close(): Promise<void> {}
}

function candidate(addr: string, reason = "wallet activity predates initial window"): CandidateRow {
  return {
    address: addr,
    account_category: "ordinary_eoa",
    stage_reason: reason,
    data_version: "2026-09-17",
    policy_version: "migration-policy-20260917",
    cutoff_time_utc: "2026-09-10T14:00:00.000Z",
  };
}

describe("confirmation API", () => {
  const store = new MemoryConfirmStore();
  let now = new Date("2026-09-21T12:00:00.000Z");
  let app: FastifyInstance;

  beforeAll(async () => {
    store.candidates.set(address, candidate(address));
    app = await buildConfirmApp({
      config: {
        rateLimitMax: 50,
        rateLimitWindow: "1 minute",
        logLevel: "silent",
        trustProxy: true,
        domain: "migrate.country",
        challengeTtlSeconds: 600,
      },
      store,
      now: () => now,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function issueAndSign(addr = address, signer = account) {
    const challenge = await app.inject({
      method: "POST",
      url: "/api/v1/confirmations/challenges",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
      payload: { address: addr },
    });
    expect(challenge.statusCode).toBe(200);
    const body = challenge.json();
    const signature = await signer.signMessage({ message: body.message });
    return { body, signature };
  }

  it("describes an ineligible address without a signature", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/confirmations/${other.address}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().eligible).toBe(false);
    expect(res.json().confirmation).toBeNull();
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("refuses a challenge for an address that is not a candidate", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/confirmations/challenges",
      headers: { "content-type": "application/json" },
      payload: { address: other.address },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/cannot be confirmed here/);
    expect(res.json().message).toMatch(/no Harmony activity in the six months/);
  });

  it("issues a personal_sign message bound to the candidate version", async () => {
    const { body } = await issueAndSign();
    expect(body.message).toContain("Domain: migrate.country");
    expect(body.message).toContain(`Address: ${account.address}`);
    expect(body.message).toContain(CONFIRM_PURPOSE);
    expect(body.message).toContain("does not transfer funds or authorize a transaction");
    expect(body.message).not.toContain("guarantee inclusion");
    expect(body.message).toContain(`Issued: ${body.issued_at}`);
    expect(body.message).toContain(`Nonce: ${body.nonce}`);
    expect(body.message).toContain("Cutoff: 2026-09-10T14:00:00.000Z");
    expect(body.message).toContain("Policy version: migration-policy-20260917");
    expect(body.message).toContain("Data version: 2026-09-17");
    expect(body.message).not.toContain("eth_sign");
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/confirmations/challenges",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.17" },
      payload: { address },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().nonce).not.toBe(body.nonce);
    expect(again.json().nonce).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts a bech32 address and records one confirmation", async () => {
    const { signature, body } = await issueAndSign(hexToBech32(address));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/confirmations",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.11" },
      payload: { address: hexToBech32(address), nonce: body.nonce, issued_at: body.issued_at, signature },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("recorded");
    expect(res.json().data_version).toBe("2026-09-17");
    expect(store.confirmations).toHaveLength(1);

    const again = await app.inject({
      method: "POST",
      url: "/api/v1/confirmations",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.12" },
      payload: { address, nonce: body.nonce, issued_at: body.issued_at, signature },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().recorded_at).toBe(res.json().recorded_at);
    expect(store.confirmations).toHaveLength(1);

    const status = await app.inject({ method: "GET", url: `/api/v1/confirmations/${address}` });
    expect(status.json().eligible).toBe(true);
    expect(status.json().confirmation.recorded_at).toBe(res.json().recorded_at);
    expect(status.json().stage_reason).toBe("wallet activity predates initial window");
    expect(status.json().confirmation.signature).toBeUndefined();

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/confirmations/challenges",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.16" },
      payload: { address },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().message).toBe("This wallet has already confirmed activity.");
  });

  it("rejects a signature from a different key", async () => {
    const fresh = privateKeyToAccount(generatePrivateKey());
    const addr = fresh.address.toLowerCase();
    store.candidates.set(addr, candidate(addr));
    const challenge = await app.inject({
      method: "POST",
      url: "/api/v1/confirmations/challenges",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.13" },
      payload: { address: addr },
    });
    const signature = await other.signMessage({ message: challenge.json().message });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/confirmations",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.13" },
      payload: { address: addr, nonce: challenge.json().nonce, issued_at: challenge.json().issued_at, signature },
    });
    expect(res.statusCode).toBe(400);
    expect(store.confirmations.filter((row) => row.address === addr)).toHaveLength(0);
  });

  it("keeps the first signature when a different one is submitted later", async () => {
    const first = store.confirmations[0].signature;
    const otherSignature = `0x${"ab".repeat(65)}`;
    expect(otherSignature.toLowerCase()).not.toBe(first.toLowerCase());
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/confirmations",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.14" },
      payload: { address, nonce: "0".repeat(64), issued_at: "2026-09-21T12:00:00.000Z", signature: otherSignature },
    });
    expect(res.statusCode).toBe(409);
    expect(store.confirmations).toHaveLength(1);
    expect(store.confirmations[0].signature).toBe(first);
  });

  it("rejects an expired challenge", async () => {
    const fresh = privateKeyToAccount(generatePrivateKey());
    const addr = fresh.address.toLowerCase();
    store.candidates.set(addr, candidate(addr, "no indexed wallet activity"));
    const { body, signature } = await issueAndSign(addr, fresh);
    now = new Date("2026-09-21T13:00:00.000Z");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/confirmations",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.15" },
      payload: { address: addr, nonce: body.nonce, issued_at: body.issued_at, signature },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/expired/i);
    expect(store.confirmations.filter((row) => row.address === addr)).toHaveLength(0);
    now = new Date("2026-09-21T12:00:00.000Z");
  });

  it("says the confirmation set changed when the signed version is no longer current", async () => {
    const fresh = privateKeyToAccount(generatePrivateKey());
    const addr = fresh.address.toLowerCase();
    store.candidates.set(addr, candidate(addr));
    const { body, signature } = await issueAndSign(addr, fresh);
    store.candidates.set(addr, { ...candidate(addr), data_version: "2026-09-18" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/confirmations",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.18" },
      payload: {
        address: addr,
        nonce: body.nonce,
        issued_at: body.issued_at,
        signature,
        data_version: body.data_version,
        policy_version: body.policy_version,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/migration data was updated/);
    expect(store.confirmations.filter((row) => row.address === addr)).toHaveLength(0);
  });
});
