import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bytesToHex, getAddress, hexToBytes, keccak256, pad, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { normalizeVaultName, vaultNameMessage } from "@hcp/shared";
import { buildApp } from "../src/app.js";
import { buildConfirmApp } from "../src/confirm/app.js";
import { MemoryRepository } from "./fixtures.js";
import {
  isAuditedVaultCode,
  MAINNET_VAULT_RUNTIME,
  SEPOLIA_VAULT_RUNTIME,
  VaultChainError,
  type VaultChain,
} from "../src/vault/chain.js";
import { VaultNameService } from "../src/vault/service.js";
import type { ApplyNameResult, VaultMetadataStore, VaultNameChange, VaultNameRow } from "../src/vault/store.js";

const key = generatePrivateKey();
const governor = privateKeyToAccount(key);
const other = privateKeyToAccount(generatePrivateKey());
const vault = getAddress("0x0000000000000000000000000000000000000abc");

class MemoryNames implements VaultMetadataStore {
  rows = new Map<string, VaultNameRow & { signature: string; issuedAt: string }>();

  async list(): Promise<VaultNameRow[]> {
    return [...this.rows.values()].map(({ vault: address, name, updated_at }) => ({ vault: address, name, updated_at }));
  }

  async apply(change: VaultNameChange): Promise<ApplyNameResult> {
    const existing = this.rows.get(change.vault);
    if (existing) {
      if (existing.signature.toLowerCase() === change.signature.toLowerCase()) {
        return { ok: true, row: { vault: existing.vault, name: existing.name, updated_at: existing.updated_at } };
      }
      if (Date.parse(existing.issuedAt) >= Date.parse(change.issuedAt)) return { ok: false, reason: "stale" };
    }
    const row = {
      vault: change.vault,
      name: change.name,
      updated_at: change.issuedAt,
      signature: change.signature,
      issuedAt: change.issuedAt,
    };
    this.rows.set(change.vault, row);
    return { ok: true, row: { vault: row.vault, name: row.name, updated_at: row.updated_at } };
  }

  async close(): Promise<void> {}
}

class FakeChain implements VaultChain {
  governor: Address | null = governor.address;
  fail = false;
  async governorOf(): Promise<Address | null> {
    if (this.fail) throw new VaultChainError();
    return this.governor;
  }
}

describe("audited vault bytecode", () => {
  it("rejects empty code and names the two deployed token builds", () => {
    expect(isAuditedVaultCode("0x")).toBe(false);
    expect(isAuditedVaultCode("0x00")).toBe(false);
    expect(MAINNET_VAULT_RUNTIME).toMatch(/^0x[0-9a-f]{64}$/);
    expect(SEPOLIA_VAULT_RUNTIME).not.toBe(MAINNET_VAULT_RUNTIME);
  });

  const artifact = fileURLToPath(new URL("../../../harmony-migration/airdrop/vault/GovernorDelegator.json", import.meta.url));
  const check = existsSync(artifact) ? it : it.skip;
  check("matches the audited artifact with the ONE token patched in", () => {
    const info = JSON.parse(readFileSync(artifact, "utf8")) as {
      runtime_template: Hex;
      asset_immutable_offsets: number[];
    };
    const hash = (token: Address) => {
      const code = hexToBytes(info.runtime_template);
      const word = hexToBytes(pad(token, { size: 32 }));
      for (const start of info.asset_immutable_offsets) code.set(word, start);
      return keccak256(bytesToHex(code));
    };
    expect(hash("0xFf74317E948695297acb79Cb2De06111F5Cc16b3")).toBe(MAINNET_VAULT_RUNTIME);
    expect(hash("0x6dF02e9a623f9d11d6c73B1fc2aBfAbb63f11E72")).toBe(SEPOLIA_VAULT_RUNTIME);
  });
});

describe("vault name changes", () => {
  const store = new MemoryNames();
  const chain = new FakeChain();
  let now = new Date("2026-10-21T18:00:00.000Z");
  let app: FastifyInstance;
  let readApp: FastifyInstance;

  beforeAll(async () => {
    const names = new VaultNameService(store, chain, {
      domain: "migrate.country",
      challengeTtlSeconds: 600,
      now: () => now,
    });
    app = await buildConfirmApp({
      config: {
        rateLimitMax: 100,
        rateLimitWindow: "1 minute",
        logLevel: "silent",
        trustProxy: true,
        domain: "migrate.country",
        challengeTtlSeconds: 600,
      },
      store: {
        async ping() {},
        async checkPrivileges() {},
        async findCandidate() { return null; },
        async findConfirmation() { return null; },
        async insertConfirmation() { return { ok: false, reason: "candidate_missing" }; },
        async close() {},
      },
      names,
      now: () => now,
    });
    readApp = await buildApp({
      config: {
        rateLimitMax: 100,
        rateLimitWindow: "1 minute",
        exposeContractAmounts: false,
        logLevel: "silent",
        trustProxy: true,
      },
      repo: new MemoryRepository(),
      vaultNames: names,
    });
    await app.ready();
    await readApp.ready();
  });

  afterAll(async () => {
    await app.close();
    await readApp.close();
  });

  async function challenge(name = "Fortune Validator", address = vault) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vault-metadata/name-challenges",
      payload: { vault: address, name },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { vault: string; name: string; message: string; nonce: string; issued_at: string };
  }

  it("rejects a name that would change the signed message", () => {
    expect(normalizeVaultName("  Fortune  ")).toBe("Fortune");
    expect(normalizeVaultName("line\nbreak")).toBeNull();
    expect(normalizeVaultName("hide\u202Ereal")).toBeNull();
    expect(normalizeVaultName("")).toBeNull();
    expect(normalizeVaultName("x".repeat(81))).toBeNull();
  });

  it("stores a name signed by the current governor and serves it on the read API", async () => {
    const body = await challenge();
    expect(body.message).toBe(vaultNameMessage({
      domain: "migrate.country",
      vault: body.vault,
      name: body.name,
      issuedAt: body.issued_at,
      nonce: body.nonce,
    }));
    expect(body.vault).toBe(vault);
    const signature = await governor.signMessage({ message: body.message });
    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/vault-metadata/names",
      payload: { vault, name: body.name, nonce: body.nonce, issued_at: body.issued_at, signature },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ vault: vault.toLowerCase(), name: "Fortune Validator" });

    const listed = await readApp.inject({ method: "GET", url: "/api/v1/vault-metadata" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().vaults).toEqual([saved.json()]);

    const again = await app.inject({
      method: "POST",
      url: "/api/v1/vault-metadata/names",
      payload: { vault, name: body.name, nonce: body.nonce, issued_at: body.issued_at, signature },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().name).toBe("Fortune Validator");
  });

  it("refuses another wallet, a stale signature, and an address that is not a vault", async () => {
    now = new Date("2026-10-21T18:05:00.000Z");
    const body = await challenge("Renamed");
    const wrong = await other.signMessage({ message: body.message });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/vault-metadata/names",
      payload: { vault, name: body.name, nonce: body.nonce, issued_at: body.issued_at, signature: wrong },
    });
    expect(rejected.statusCode).toBe(400);

    const signature = await governor.signMessage({ message: body.message });
    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/vault-metadata/names",
      payload: { vault, name: body.name, nonce: body.nonce, issued_at: body.issued_at, signature },
    });
    expect(saved.statusCode).toBe(200);

    now = new Date("2026-10-21T18:06:00.000Z");
    const newer = await challenge("Newest");
    const newerSignature = await governor.signMessage({ message: newer.message });
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/vault-metadata/names",
      payload: { vault, name: newer.name, nonce: newer.nonce, issued_at: newer.issued_at, signature: newerSignature },
    })).statusCode).toBe(200);
    const stale = await app.inject({
      method: "POST",
      url: "/api/v1/vault-metadata/names",
      payload: { vault, name: body.name, nonce: body.nonce, issued_at: body.issued_at, signature },
    });
    expect(stale.statusCode).toBe(409);

    chain.governor = null;
    now = new Date("2026-10-21T18:07:00.000Z");
    const missing = await challenge("Nope");
    const missingSignature = await governor.signMessage({ message: missing.message });
    const notVault = await app.inject({
      method: "POST",
      url: "/api/v1/vault-metadata/names",
      payload: { vault, name: missing.name, nonce: missing.nonce, issued_at: missing.issued_at, signature: missingSignature },
    });
    expect(notVault.statusCode).toBe(400);
    expect(notVault.json().message).toMatch(/not a deployed governor vault/);
    chain.governor = governor.address;
  });
});
