/**
 * Transaction archive (/history): a fixed record of Harmony transactions of at
 * least 1 ONE, kept after the Harmony explorer shut down. Lookups by one
 * address (newest first, keyset-paginated by record id) or by one transaction
 * hash (Harmony or Ethereum-style). There are no list or search endpoints.
 */
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import {
  attoToOne,
  type ArchiveAddressResponse,
  type ArchiveBranch,
  type ArchiveCoverage,
  type ArchiveMetaResponse,
  type ArchiveRecord,
  type ArchiveRecordType,
  type ArchiveTxResponse,
} from "@hcp/shared";
import { addressForms, normalizeAddress } from "./address.js";

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 100;
const MAX_TX_RECORDS = 1000;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const CURSOR_RE = /^[1-9]\d{0,18}$/;

export interface ArchiveRow {
  id: string;
  record_type: ArchiveRecordType;
  kind: string;
  shard: number;
  to_shard: number | null;
  rolled_back: boolean;
  block_number: string | number;
  block_hash: string;
  block_time: Date | string;
  tx_index: number;
  trace_address: string | null;
  tx_hash: string;
  eth_hash: string | null;
  from_addr: string;
  to_addr: string | null;
  value_atto: string;
  fee_atto: string | null;
  status: number;
  method: string | null;
  ancestor_reverted: boolean | null;
  dest_status: string | null;
  dest_block_number: string | number | null;
  dest_block_hash: string | null;
  dest_time: Date | string | null;
}

export type ArchiveMeta = Record<string, unknown>;

export interface ArchiveRepository {
  getArchiveMeta(): Promise<ArchiveMeta | null>;
  /** Records sent or received by the address with id < before, newest first, at most `limit`. */
  getArchiveByAddress(addressLower: string, before: bigint | null, limit: number): Promise<ArchiveRow[]>;
  /** Every record whose tx_hash or eth_hash equals the hash, oldest first. */
  getArchiveByHash(hashLower: string, limit: number): Promise<ArchiveRow[]>;
}

const COLUMNS = `
  id::text, record_type, kind, shard, to_shard, rolled_back, block_number::text,
  '0x' || encode(block_hash, 'hex') AS block_hash, block_time, tx_index, trace_address,
  '0x' || encode(tx_hash, 'hex') AS tx_hash, '0x' || encode(eth_hash, 'hex') AS eth_hash,
  '0x' || encode(from_addr, 'hex') AS from_addr, '0x' || encode(to_addr, 'hex') AS to_addr,
  value_atto::text, fee_atto::text, status, '0x' || encode(method, 'hex') AS method,
  ancestor_reverted, dest_status, dest_block_number::text,
  '0x' || encode(dest_block_hash, 'hex') AS dest_block_hash, dest_time`;

const MAX_ID = "9223372036854775807";

export class PgArchiveQueries implements ArchiveRepository {
  private metaCache: { at: number; value: ArchiveMeta | null } | null = null;

  constructor(private pool: pg.Pool) {}

  async getArchiveMeta(): Promise<ArchiveMeta | null> {
    const now = Date.now();
    if (this.metaCache && now - this.metaCache.at < 15_000) return this.metaCache.value;
    let value: ArchiveMeta | null = null;
    try {
      const res = await this.pool.query<{ key: string; value: unknown }>("SELECT key, value FROM archive_meta");
      if (res.rows.length > 0) {
        value = {};
        for (const row of res.rows) value[row.key] = row.value;
      }
    } catch (err) {
      if ((err as { code?: string }).code !== "42P01") throw err; // archive not migrated yet
    }
    this.metaCache = { at: now, value };
    return value;
  }

  async getArchiveByAddress(addressLower: string, before: bigint | null, limit: number): Promise<ArchiveRow[]> {
    const res = await this.pool.query<ArchiveRow>(
      `SELECT ${COLUMNS} FROM (
         (SELECT * FROM archive_records
           WHERE from_addr = decode($1, 'hex') AND id < $2
           ORDER BY id DESC LIMIT $3)
         UNION ALL
         (SELECT * FROM archive_records
           WHERE to_addr = decode($1, 'hex') AND from_addr <> decode($1, 'hex') AND id < $2
           ORDER BY id DESC LIMIT $3)
       ) r
       ORDER BY id DESC
       LIMIT $3`,
      [addressLower.slice(2), before === null ? MAX_ID : before.toString(), limit],
    );
    return res.rows;
  }

  async getArchiveByHash(hashLower: string, limit: number): Promise<ArchiveRow[]> {
    const res = await this.pool.query<ArchiveRow>(
      `SELECT ${COLUMNS} FROM archive_records
        WHERE tx_hash = decode($1, 'hex') OR eth_hash = decode($1, 'hex')
        ORDER BY id
        LIMIT $2`,
      [hashLower.slice(2), limit],
    );
    return res.rows;
  }
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function num(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

export function toArchiveRecord(row: ArchiveRow): ArchiveRecord {
  return {
    id: row.id,
    record_type: row.record_type,
    kind: row.kind,
    shard: row.shard,
    to_shard: row.to_shard,
    branch: row.rolled_back ? "rolled_back" : "canonical",
    block_number: Number(row.block_number),
    block_hash: row.block_hash,
    time_utc: iso(row.block_time) ?? "",
    tx_index: row.tx_index,
    trace_address: row.trace_address,
    tx_hash: row.tx_hash,
    eth_hash: row.eth_hash,
    from: row.from_addr,
    to: row.to_addr,
    value_atto: row.value_atto,
    value_one: attoToOne(row.value_atto),
    fee_atto: row.fee_atto,
    status: row.status === 1 ? "success" : "failed",
    method: row.method,
    ancestor_reverted: row.ancestor_reverted,
    destination:
      row.record_type === "cross_shard" && row.dest_status !== null
        ? {
            status: row.dest_status,
            block_number: num(row.dest_block_number),
            block_hash: row.dest_block_hash,
            time_utc: iso(row.dest_time),
          }
        : null,
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function buildArchiveMeta(meta: ArchiveMeta | null): ArchiveMetaResponse {
  if (!meta) {
    return {
      available: false,
      min_value_atto: null,
      min_value_one: null,
      data_version: null,
      loaded_at: null,
      fixture: false,
      coverage: [],
      notes: [],
      row_counts: {},
    };
  }
  const min = typeof meta.min_value_atto === "string" ? meta.min_value_atto : null;
  const coverage: ArchiveCoverage[] = asArray(meta.coverage).map((item) => {
    const c = item as Record<string, unknown>;
    return {
      shard: Number(c.shard),
      branch: (c.branch === "rolled_back" ? "rolled_back" : "canonical") as ArchiveBranch,
      start_block: Number(c.start_block),
      end_block: Number(c.end_block),
      start_time_utc: typeof c.start_time_utc === "string" ? c.start_time_utc : null,
      end_time_utc: typeof c.end_time_utc === "string" ? c.end_time_utc : null,
    };
  });
  const counts = (meta.row_counts ?? {}) as Record<string, unknown>;
  return {
    available: true,
    min_value_atto: min,
    min_value_one: min === null ? null : attoToOne(min),
    data_version: typeof meta.data_version === "string" ? meta.data_version : null,
    loaded_at: typeof meta.loaded_at === "string" ? meta.loaded_at : null,
    fixture: meta.fixture === true,
    coverage,
    notes: asArray(meta.notes).filter((n): n is string => typeof n === "string"),
    row_counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])),
  };
}

function badRequest(message: string) {
  return { statusCode: 400, error: "Bad Request", message };
}

export function registerArchiveRoutes(app: FastifyInstance, archive: ArchiveRepository): void {
  app.get("/api/v1/archive/meta", async () => buildArchiveMeta(await archive.getArchiveMeta()));

  app.get<{ Params: { address: string }; Querystring: { before?: string; limit?: string } }>(
    "/api/v1/archive/address/:address",
    async (req, reply) => {
      const address = normalizeAddress(req.params.address);
      const { before, limit } = req.query;
      if (before !== undefined && !CURSOR_RE.test(before)) {
        return reply.code(400).send(badRequest("before must be a record id"));
      }
      let size = DEFAULT_PAGE;
      if (limit !== undefined) {
        size = /^\d{1,3}$/.test(limit) ? Number(limit) : 0;
        if (size < 1 || size > MAX_PAGE) {
          return reply.code(400).send(badRequest(`limit must be between 1 and ${MAX_PAGE}`));
        }
      }
      const rows = await archive.getArchiveByAddress(address, before ? BigInt(before) : null, size + 1);
      const page = rows.slice(0, size).map(toArchiveRecord);
      const body: ArchiveAddressResponse = {
        address: addressForms(address),
        records: page,
        next_before: rows.length > size ? page[page.length - 1].id : null,
      };
      return body;
    },
  );

  app.get<{ Params: { hash: string } }>("/api/v1/archive/tx/:hash", async (req, reply) => {
    const hash = req.params.hash.trim();
    if (!HASH_RE.test(hash)) {
      return reply.code(400).send(badRequest("hash must be 0x followed by 64 hex digits"));
    }
    const rows = await archive.getArchiveByHash(hash.toLowerCase(), MAX_TX_RECORDS);
    if (rows.length === 0) {
      return reply.code(404).send({ statusCode: 404, error: "Not Found", message: "no archived record for this hash" });
    }
    const body: ArchiveTxResponse = { hash: hash.toLowerCase(), records: rows.map(toArchiveRecord) };
    return body;
  });
}
