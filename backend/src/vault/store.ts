import pg from "pg";

export interface VaultNameRow {
  vault: string;
  name: string;
  updated_at: string;
}

export interface VaultNameChange {
  /** Lowercase vault address. */
  vault: string;
  name: string;
  message: string;
  signature: string;
  /** Lowercase signer. */
  signer: string;
  /** Canonical UTC timestamp. */
  issuedAt: string;
}

export type ApplyNameResult = { ok: true; row: VaultNameRow } | { ok: false; reason: "stale" };

export interface VaultMetadataStore {
  list(): Promise<VaultNameRow[]>;
  apply(change: VaultNameChange): Promise<ApplyNameResult>;
  close(): Promise<void>;
}

interface CurrentRow {
  name: string;
  issued_at: Date;
  signature: string;
  updated_at: Date;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

function rowOf(vault: string, name: string, updatedAt: Date): VaultNameRow {
  return { vault: vault.trim().toLowerCase(), name, updated_at: updatedAt.toISOString() };
}

export class PgVaultMetadataStore implements VaultMetadataStore {
  private pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
    });
  }

  async list(): Promise<VaultNameRow[]> {
    const res = await this.pool.query<{ vault_address: string; name: string; updated_at: Date }>(
      `SELECT vault_address, name, updated_at
         FROM vault.metadata
        ORDER BY vault_address`,
    );
    return res.rows.map((row) => rowOf(row.vault_address, row.name, row.updated_at));
  }

  async apply(change: VaultNameChange): Promise<ApplyNameResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [change.vault]);
      const current = await client.query<CurrentRow>(
        `SELECT name, issued_at, signature, updated_at
           FROM vault.metadata
          WHERE vault_address = $1
          FOR UPDATE`,
        [change.vault],
      );
      const existing = current.rows[0];
      if (existing) {
        const sameSignature = existing.signature.toLowerCase() === change.signature.toLowerCase();
        if (sameSignature) {
          await client.query("ROLLBACK");
          return { ok: true, row: rowOf(change.vault, existing.name, existing.updated_at) };
        }
        if (existing.issued_at.getTime() >= Date.parse(change.issuedAt)) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "stale" };
        }
      }
      await client.query(
        `INSERT INTO vault.metadata_changes
           (vault_address, name, message, signature, signer, issued_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [change.vault, change.name, change.message, change.signature, change.signer, change.issuedAt],
      );
      const saved = await client.query<{ updated_at: Date }>(
        `INSERT INTO vault.metadata (vault_address, name, signer, signature, issued_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (vault_address) DO UPDATE
           SET name = EXCLUDED.name,
               signer = EXCLUDED.signer,
               signature = EXCLUDED.signature,
               issued_at = EXCLUDED.issued_at,
               updated_at = now()
         RETURNING updated_at`,
        [change.vault, change.name, change.signer, change.signature, change.issuedAt],
      );
      await client.query("COMMIT");
      return { ok: true, row: rowOf(change.vault, change.name, saved.rows[0].updated_at) };
    } catch (err) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(err)) {
        const again = await this.list();
        const row = again.find((item) => item.vault === change.vault);
        if (row?.name === change.name) return { ok: true, row };
        return { ok: false, reason: "stale" };
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
