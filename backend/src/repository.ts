/**
 * Row shapes as read from PostgreSQL (numeric -> string) and the repository
 * interface the routes depend on. `PgRepository` is the production
 * implementation; tests provide an in-memory one.
 */
import pg from "pg";

export interface AccountRow {
  secure_key: string;
  address: string | null;
  address_resolved: boolean;
  account_category: "ordinary_eoa" | "validator_account" | "contract" | "excluded";
  code_bearing: boolean;
  contract_primary_category: string | null;
  liquid_shard0_atto: string;
  liquid_shard1_atto: string;
  active_staked_or_delegated_atto: string;
  pending_undelegation_atto: string;
  unclaimed_staking_reward_atto: string;
  pending_cross_shard_atto: string;
  wallet_airdrop_atto: string;
  staked_to_vault_atto: string;
  total_claim_atto: string;
  meets_threshold: boolean;
  last_activity_time_utc: string | Date | null;
  last_activity_block: string | number | null;
  last_activity_shard: number | null;
  last_activity_type: string | null;
  last_activity_tx_hash: string | null;
}

export interface DelegationRow {
  validator_address: string;
  delegator_address: string;
  staked_to_vault_atto: string;
  is_self_delegation: boolean;
  priority: boolean;
}

export interface VaultRow {
  validator_address: string;
  vault_assets_atto: string;
  priority_staked_to_vault_atto: string;
  deferred_staked_to_vault_atto: string;
  delegation_rows: number;
  governor_destination_id: string | null;
  governor_status: string;
  validator_name: string | null;
}

export interface ExceptionRow {
  component: "wallet_airdrop" | "vault_shares";
  source_address: string;
  source_category: string;
  validator_address: string | null;
  amount_atto: string;
  exception_type: string;
  route_id: string;
  route_priority: string | number;
  destination_id: string | null;
  destination_address: string | null;
  destination_status: "ready" | "hold" | "not_issuing";
  reason: string;
  evidence: string;
}

export interface ReasonText {
  title: string;
  user_text: string;
}

export type SnapshotMeta = Record<string, unknown>;

export interface ClaimRepository {
  ping(): Promise<void>;
  getMeta(): Promise<SnapshotMeta>;
  getAccount(addressLower: string): Promise<AccountRow | null>;
  getDelegations(addressLower: string): Promise<DelegationRow[]>;
  getExceptions(addressLower: string): Promise<ExceptionRow[]>;
  getVaults(validatorAddresses: string[]): Promise<VaultRow[]>;
  getReasonTexts(): Promise<Record<string, ReasonText>>;
  close(): Promise<void>;
}

const trimChar = (v: string | null): string | null => (v === null ? null : v.trim());

export class PgRepository implements ClaimRepository {
  private pool: pg.Pool;
  private reasonCache: { at: number; value: Record<string, ReasonText> } | null = null;
  private metaCache: { at: number; value: SnapshotMeta } | null = null;

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

  async getMeta(): Promise<SnapshotMeta> {
    const now = Date.now();
    if (this.metaCache && now - this.metaCache.at < 15_000) return this.metaCache.value;
    const res = await this.pool.query<{ key: string; value: unknown }>(
      "SELECT key, value FROM snapshot_meta",
    );
    const value: SnapshotMeta = {};
    for (const row of res.rows) value[row.key] = row.value;
    this.metaCache = { at: now, value };
    return value;
  }

  async getAccount(addressLower: string): Promise<AccountRow | null> {
    const res = await this.pool.query<AccountRow>(
      `SELECT secure_key, address, address_resolved, account_category, code_bearing,
              contract_primary_category,
              liquid_shard0_atto::text, liquid_shard1_atto::text,
              active_staked_or_delegated_atto::text, pending_undelegation_atto::text,
              unclaimed_staking_reward_atto::text, pending_cross_shard_atto::text,
              wallet_airdrop_atto::text, staked_to_vault_atto::text, total_claim_atto::text,
              meets_threshold, last_activity_time_utc, last_activity_block,
              last_activity_shard, last_activity_type, last_activity_tx_hash
         FROM accounts
        WHERE lower(address) = $1
        LIMIT 1`,
      [addressLower],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { ...row, address: trimChar(row.address) };
  }

  async getDelegations(addressLower: string): Promise<DelegationRow[]> {
    const res = await this.pool.query<DelegationRow>(
      `SELECT validator_address, delegator_address, staked_to_vault_atto::text,
              is_self_delegation, priority
         FROM delegations
        WHERE delegator_address = $1
        ORDER BY staked_to_vault_atto DESC, validator_address`,
      [addressLower],
    );
    return res.rows.map((r) => ({
      ...r,
      validator_address: r.validator_address.trim(),
      delegator_address: r.delegator_address.trim(),
    }));
  }

  async getExceptions(addressLower: string): Promise<ExceptionRow[]> {
    const res = await this.pool.query<ExceptionRow>(
      `SELECT component, source_address, source_category, validator_address,
              amount_atto::text, exception_type, route_id, route_priority,
              destination_id, destination_address, destination_status, reason, evidence
         FROM routing_exceptions
        WHERE source_address = $1
        ORDER BY component, route_priority, route_id, id`,
      [addressLower],
    );
    return res.rows.map((r) => ({
      ...r,
      source_address: r.source_address.trim(),
      validator_address: trimChar(r.validator_address),
      destination_address: trimChar(r.destination_address),
    }));
  }

  async getVaults(validatorAddresses: string[]): Promise<VaultRow[]> {
    if (validatorAddresses.length === 0) return [];
    const res = await this.pool.query<VaultRow>(
      `SELECT validator_address, vault_assets_atto::text, priority_staked_to_vault_atto::text,
              deferred_staked_to_vault_atto::text, delegation_rows, governor_destination_id,
              governor_status, validator_name
         FROM validator_vaults
        WHERE validator_address = ANY($1::text[])`,
      [validatorAddresses],
    );
    return res.rows.map((r) => ({ ...r, validator_address: r.validator_address.trim() }));
  }

  async getReasonTexts(): Promise<Record<string, ReasonText>> {
    const now = Date.now();
    if (this.reasonCache && now - this.reasonCache.at < 60_000) return this.reasonCache.value;
    const res = await this.pool.query<{ reason_code: string; title: string; user_text: string }>(
      "SELECT reason_code, title, user_text FROM reason_texts",
    );
    const value: Record<string, ReasonText> = {};
    for (const row of res.rows) value[row.reason_code] = { title: row.title, user_text: row.user_text };
    this.reasonCache = { at: now, value };
    return value;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
