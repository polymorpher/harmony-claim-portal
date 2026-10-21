import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hexToBech32 } from "@hcp/shared";
import { buildApp } from "../src/app.js";
import { buildArchiveMeta, type ArchiveMeta, type ArchiveRepository, type ArchiveRow } from "../src/archive.js";
import { MemoryRepository } from "./fixtures.js";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const ETH = (n: number) => `0x${(n + 0xe000).toString(16).padStart(64, "0")}`;

function row(id: number, partial: Partial<ArchiveRow>): ArchiveRow {
  return {
    id: String(id),
    record_type: "transaction",
    kind: "transfer",
    shard: 0,
    to_shard: 0,
    rolled_back: false,
    block_number: String(67_500_000 + id),
    block_hash: H(1000 + id),
    block_time: new Date(Date.UTC(2025, 0, 1, 0, 0, id)),
    tx_index: 0,
    trace_address: null,
    tx_hash: H(id),
    eth_hash: ETH(id),
    from_addr: ALICE,
    to_addr: BOB,
    value_atto: "1500000000000000000",
    fee_atto: "2100000000000000",
    status: 1,
    method: null,
    method_name: null,
    method_verified: null,
    ancestor_reverted: null,
    dest_status: null,
    dest_block_number: null,
    dest_block_hash: null,
    dest_time: null,
    ...partial,
  };
}

const ROWS: ArchiveRow[] = [
  row(1, {}),
  row(2, { from_addr: BOB, to_addr: ALICE, value_atto: "2000000000000000000" }),
  row(3, { kind: "call", to_addr: POOL, method: "0xd0e30db0", method_name: "deposit()", method_verified: true, status: 0 }),
  row(4, {
    record_type: "internal", kind: "call", tx_hash: H(3), eth_hash: ETH(3), trace_address: "0.1",
    from_addr: POOL, to_addr: ALICE, fee_atto: null, status: 0,
  }),
  row(5, { from_addr: ALICE, to_addr: ALICE }),
  row(6, {
    record_type: "cross_shard", kind: "precompile", to_shard: 1, tx_hash: H(6), eth_hash: null, fee_atto: null,
    ancestor_reverted: true, dest_status: "credited", dest_block_number: "95000000", dest_block_hash: H(7777),
    dest_time: new Date(Date.UTC(2025, 0, 1, 0, 1, 0)),
  }),
  row(7, { rolled_back: true, tx_hash: H(1), eth_hash: ETH(1), shard: 1, to_shard: 1 }),
  row(8, { record_type: "staking", kind: "Delegate", to_addr: POOL, eth_hash: null }),
];

class MemoryArchive implements ArchiveRepository {
  meta: ArchiveMeta | null = {
    min_value_atto: "1000000000000000000",
    data_version: "fixture-archive",
    loaded_at: "2026-10-21T00:00:00Z",
    fixture: true,
    coverage: [{ shard: 0, branch: "canonical", start_block: 67492436, end_block: 93624315,
                 start_time_utc: "2025-01-01T00:00:01Z", end_time_utc: "2026-09-10T14:41:43Z" }],
    notes: ["shard 1 has no transactions after block 94978278"],
    row_counts: { archive_records: ROWS.length },
  };
  async getArchiveMeta() {
    return this.meta;
  }
  async getArchiveByAddress(address: string, before: bigint | null, limit: number) {
    return ROWS.filter((r) => (r.from_addr === address || r.to_addr === address) && (before === null || BigInt(r.id) < before))
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, limit);
  }
  async getArchiveByHash(hash: string, limit: number) {
    return ROWS.filter((r) => r.tx_hash === hash || r.eth_hash === hash).slice(0, limit)
      .map((r) => ({ ...r, input: r.method ? `${r.method}00` : null }));
  }
}

let app: FastifyInstance;
const archive = new MemoryArchive();
let ip = 0;
const get = (url: string) => app.inject({ method: "GET", url, headers: { "cf-connecting-ip": `10.9.0.${++ip}` } });

beforeAll(async () => {
  app = await buildApp({
    config: { rateLimitMax: 100, rateLimitWindow: "1 minute", exposeContractAmounts: false, logLevel: "silent", trustProxy: true },
    repo: new MemoryRepository(),
    archive,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("archive meta", () => {
  it("reports coverage and notes", async () => {
    const res = await get("/api/v1/archive/meta");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(true);
    expect(body.min_value_one).toBe("1");
    expect(body.coverage[0]).toMatchObject({ shard: 0, branch: "canonical", end_block: 93624315 });
    expect(body.notes).toHaveLength(1);
  });

  it("is unavailable before a load", () => {
    expect(buildArchiveMeta(null)).toMatchObject({ available: false, coverage: [], notes: [] });
  });
});

describe("archive by address", () => {
  it("lists sent and received records newest first, self-transfers once", async () => {
    const res = await get(`/api/v1/archive/address/${hexToBech32(ALICE)}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.address.hex).toBe(ALICE);
    expect(body.records.map((r: { id: string }) => r.id)).toEqual(["8", "7", "6", "5", "4", "3", "2", "1"]);
    expect(body.next_before).toBeNull();
  });

  it("paginates with before and limit", async () => {
    const first = (await get(`/api/v1/archive/address/${ALICE}?limit=3`)).json();
    expect(first.records.map((r: { id: string }) => r.id)).toEqual(["8", "7", "6"]);
    expect(first.next_before).toBe("6");
    const second = (await get(`/api/v1/archive/address/${ALICE}?limit=3&before=${first.next_before}`)).json();
    expect(second.records.map((r: { id: string }) => r.id)).toEqual(["5", "4", "3"]);
    const last = (await get(`/api/v1/archive/address/${ALICE}?limit=3&before=3`)).json();
    expect(last.records.map((r: { id: string }) => r.id)).toEqual(["2", "1"]);
    expect(last.next_before).toBeNull();
  });

  it("shapes records", async () => {
    const body = (await get(`/api/v1/archive/address/${ALICE}`)).json();
    const byId = Object.fromEntries(body.records.map((r: { id: string }) => [r.id, r]));
    expect(byId["1"]).toMatchObject({ record_type: "transaction", branch: "canonical", value_one: "1.5", status: "success",
                                     block_number: 67500001, time_utc: "2025-01-01T00:00:01.000Z", destination: null });
    expect(byId["3"]).toMatchObject({ status: "failed", method: "0xd0e30db0", method_name: "deposit()", method_verified: true });
    expect(byId["3"]).not.toHaveProperty("input");
    expect(byId["4"]).toMatchObject({ record_type: "internal", trace_address: "0.1", tx_hash: H(3) });
    expect(byId["6"]).toMatchObject({ record_type: "cross_shard", to_shard: 1, ancestor_reverted: true,
                                     destination: { status: "credited", block_number: 95000000 } });
    expect(byId["7"]).toMatchObject({ branch: "rolled_back", shard: 1 });
  });

  it("rejects bad input", async () => {
    expect((await get("/api/v1/archive/address/nope")).statusCode).toBe(400);
    expect((await get(`/api/v1/archive/address/${ALICE}?limit=0`)).statusCode).toBe(400);
    expect((await get(`/api/v1/archive/address/${ALICE}?limit=101`)).statusCode).toBe(400);
    expect((await get(`/api/v1/archive/address/${ALICE}?before=-1`)).statusCode).toBe(400);
    expect((await get(`/api/v1/archive/address/${ALICE}?before=abc`)).statusCode).toBe(400);
  });

  it("returns an empty page for an address without records", async () => {
    const body = (await get(`/api/v1/archive/address/0x${"9".repeat(40)}`)).json();
    expect(body.records).toEqual([]);
    expect(body.next_before).toBeNull();
  });
});

describe("archive by hash", () => {
  it("finds a transaction and its internal transfers by Harmony or Ethereum hash", async () => {
    for (const hash of [H(3), ETH(3).toUpperCase().replace("0X", "0x")]) {
      const res = await get(`/api/v1/archive/tx/${hash}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().records.map((r: { record_type: string }) => r.record_type)).toEqual(["transaction", "internal"]);
    }
  });

  it("includes calldata and the function name", async () => {
    const [call, internal] = (await get(`/api/v1/archive/tx/${H(3)}`)).json().records;
    expect(call).toMatchObject({ method: "0xd0e30db0", method_name: "deposit()", method_verified: true, input: "0xd0e30db000" });
    expect(internal).toMatchObject({ method: null, method_name: null, input: null });
  });

  it("returns both branches when a hash was rolled back and included again", async () => {
    const body = (await get(`/api/v1/archive/tx/${H(1)}`)).json();
    expect(body.records.map((r: { branch: string }) => r.branch)).toEqual(["canonical", "rolled_back"]);
  });

  it("404s an unknown hash and 400s a malformed one", async () => {
    expect((await get(`/api/v1/archive/tx/${H(999)}`)).statusCode).toBe(404);
    expect((await get("/api/v1/archive/tx/0x1234")).statusCode).toBe(400);
  });
});

describe("without an archive repository", () => {
  it("has no archive routes", async () => {
    const bare = await buildApp({
      config: { rateLimitMax: 100, rateLimitWindow: "1 minute", exposeContractAmounts: false, logLevel: "silent", trustProxy: true },
      repo: new MemoryRepository(),
    });
    const res = await bare.inject({ method: "GET", url: "/api/v1/archive/meta" });
    expect(res.statusCode).toBe(404);
    await bare.close();
  });
});
