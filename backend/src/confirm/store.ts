import pg from "pg";
import type { SignatureScheme } from "@hcp/shared";
import { assertPrivileges } from "../privileges.js";

export interface CandidateRow {
  address: string;
  account_category: string;
  stage_reason: string;
  data_version: string;
  policy_version: string;
  cutoff_time_utc: string;
}

export interface ConfirmationRow {
  address: string;
  data_version: string;
  policy_version: string;
  stage_reason: string;
  message: string;
  signature: string;
  signature_scheme: SignatureScheme;
  signer: string;
  created_at: string;
}

export interface ConfirmationInsert {
  address: string;
  dataVersion: string;
  policyVersion: string;
  stageReason: string;
  message: string;
  signature: string;
  signatureScheme: SignatureScheme;
  signer: string;
}

export type InsertResult =
  | { ok: true; created_at: string }
  | { ok: false; reason: "candidate_missing" | "version_mismatch" | "conflict" };

export interface ConfirmStore {
  ping(): Promise<void>;
  checkPrivileges(): Promise<void>;
  findCandidate(address: string): Promise<CandidateRow | null>;
  findConfirmation(address: string, dataVersion: string, policyVersion: string): Promise<ConfirmationRow | null>;
  insertConfirmation(input: ConfirmationInsert): Promise<InsertResult>;
  close(): Promise<void>;
}

const trim = (value: string) => value.trim();

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class PgConfirmStore implements ConfirmStore {
  private pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
    });
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async checkPrivileges(): Promise<void> {
    await assertPrivileges(this.pool, "confirm");
  }

  async findCandidate(address: string): Promise<CandidateRow | null> {
    const res = await this.pool.query<CandidateRow>(
      `SELECT address, account_category, stage_reason, data_version, policy_version,
              cutoff_time_utc
         FROM confirm.candidates
        WHERE address = $1`,
      [address],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { ...row, address: trim(row.address), cutoff_time_utc: iso(row.cutoff_time_utc) };
  }

  async findConfirmation(address: string, dataVersion: string, policyVersion: string): Promise<ConfirmationRow | null> {
    const res = await this.pool.query<ConfirmationRow>(
      `SELECT address, data_version, policy_version, stage_reason, message, signature,
              signature_scheme, signer, created_at
         FROM confirm.confirmations
        WHERE address = $1 AND data_version = $2 AND policy_version = $3`,
      [address, dataVersion, policyVersion],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { ...row, address: trim(row.address), signer: trim(row.signer), created_at: iso(row.created_at) };
  }

  async insertConfirmation(input: ConfirmationInsert): Promise<InsertResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Plain SELECT takes ACCESS SHARE, which waits out the loader's TRUNCATE.
      const candidate = await client.query<{ data_version: string; policy_version: string }>(
        `SELECT data_version, policy_version
           FROM confirm.candidates
          WHERE address = $1`,
        [input.address],
      );
      const row = candidate.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "candidate_missing" };
      }
      if (row.data_version !== input.dataVersion || row.policy_version !== input.policyVersion) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "version_mismatch" };
      }
      const inserted = await client.query<{ created_at: Date }>(
        `INSERT INTO confirm.confirmations
           (address, data_version, policy_version, stage_reason, message, signature, signature_scheme, signer)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (address, data_version, policy_version) DO NOTHING
         RETURNING created_at`,
        [
          input.address,
          input.dataVersion,
          input.policyVersion,
          input.stageReason,
          input.message,
          input.signature,
          input.signatureScheme,
          input.signer,
        ],
      );
      if (inserted.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "conflict" };
      }
      await client.query("COMMIT");
      return { ok: true, created_at: iso(inserted.rows[0].created_at) };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
