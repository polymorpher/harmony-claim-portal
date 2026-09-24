/**
 * Row shapes as read from PostgreSQL (numeric -> string) and the repository
 * interface the routes depend on. `PgRepository` is the production
 * implementation; tests provide an in-memory one.
 */
import pg from "pg";
import { assertPrivileges } from "./privileges.js";

export interface AccountRow {
  secure_key: string;
  address: string | null;
  address_resolved: boolean;
  account_category: "ordinary_eoa" | "validator_account" | "contract" | "excluded";
  code_bearing: boolean;
  contract_primary_category: string | null;
  contract_subcategory: string | null;
  contract_identity: string | null;
  contract_treatment: string | null;
  policy_category: string | null;
  stage_policy_applied: boolean;
  migration_stage: string | null;
  issuance_treatment: "issue" | "manual_from_reserve" | "not_issued";
  stage_reason: string | null;
  migration_wallet_allocation_atto: string;
  migration_staked_to_vault_atto: string;
  migration_allocation_atto: string;
  liquid_shard0_atto: string;
  liquid_shard1_atto: string;
  active_staked_or_delegated_atto: string;
  pending_undelegation_atto: string;
  unclaimed_staking_reward_atto: string;
  pending_cross_shard_atto: string;
  native_wallet_airdrop_atto: string;
  wone_balance_atto: string;
  wone_airdrop_atto: string;
  wallet_airdrop_atto: string;
  staked_to_vault_atto: string;
  qualification_total_atto: string;
  native_total_claim_atto: string;
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
  initial_assets_atto: string;
  exchange_manual_assets_atto: string;
  next_stage_assets_atto: string;
  qualified_deferred_assets_atto: string;
  manual_review_assets_atto: string;
  uncompiled_deferred_assets_atto: string;
  not_issued_assets_atto: string;
  post_policy_assets_atto: string;
}

export interface ExceptionRow {
  component: "wallet_airdrop" | "vault_shares";
  source_address: string;
  source_category: string;
  migration_stage: string | null;
  issuance_treatment: "issue" | "manual_from_reserve" | "not_issued" | "redistributed" | null;
  validator_address: string | null;
  amount_atto: string;
  exception_type: string;
  route_id: string;
  route_priority: string | number;
  destination_id: string | null;
  destination_address: string | null;
  destination_status: "ready" | "hold" | "exchange_manual" | "not_issuing" | "redistributed";
  reason: string;
  evidence: string;
}

export interface ExchangeRow {
  exchange_id: string;
  display_name: string;
  address: string;
  delivery_policy: string;
  qualification_status: string;
  migration_stage: string | null;
  issuance_treatment: string | null;
  planned_delivery_status: string;
  configured_destination: string | null;
  configured_destination_status: string;
  destination_mode: string | null;
  delivery_tier: string | null;
  planned_wallet_destination: string | null;
  planned_staking_destination: string | null;
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
  getExchangeWallets(addressLower: string): Promise<ExchangeRow[]>;
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

  async checkPrivileges(): Promise<void> {
    await assertPrivileges(this.pool, "read");
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
              contract_primary_category, contract_subcategory, contract_identity,
              contract_treatment, policy_category, stage_policy_applied,
              migration_stage, issuance_treatment, stage_reason,
              migration_wallet_allocation_atto::text,
              migration_staked_to_vault_atto::text,
              migration_allocation_atto::text,
              liquid_shard0_atto::text, liquid_shard1_atto::text,
              active_staked_or_delegated_atto::text, pending_undelegation_atto::text,
              unclaimed_staking_reward_atto::text, pending_cross_shard_atto::text,
              CASE WHEN qualification_total_atto = 0 AND total_claim_atto <> 0
                   THEN wallet_airdrop_atto ELSE native_wallet_airdrop_atto END::text
                AS native_wallet_airdrop_atto,
              wone_balance_atto::text,
              wone_airdrop_atto::text, wallet_airdrop_atto::text,
              staked_to_vault_atto::text,
              CASE WHEN qualification_total_atto = 0 AND total_claim_atto <> 0
                   THEN total_claim_atto ELSE qualification_total_atto END::text
                AS qualification_total_atto,
              CASE WHEN qualification_total_atto = 0 AND total_claim_atto <> 0
                   THEN total_claim_atto ELSE native_total_claim_atto END::text
                AS native_total_claim_atto,
              total_claim_atto::text,
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
      `SELECT component, source_address, source_category, migration_stage,
              issuance_treatment, validator_address,
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

  async getExchangeWallets(addressLower: string): Promise<ExchangeRow[]> {
    const res = await this.pool.query<ExchangeRow>(
      `SELECT exchange_id, display_name, address, delivery_policy,
              qualification_status, migration_stage, issuance_treatment,
              planned_delivery_status,
              configured_destination, configured_destination_status,
              destination_mode, delivery_tier,
              planned_wallet_destination, planned_staking_destination
         FROM exchange_wallets
        WHERE address = $1
        ORDER BY exchange_id`,
      [addressLower],
    );
    return res.rows.map((r) => ({
      ...r,
      address: r.address.trim(),
      configured_destination: trimChar(r.configured_destination),
      planned_wallet_destination: trimChar(r.planned_wallet_destination),
      planned_staking_destination: trimChar(r.planned_staking_destination),
    }));
  }

  async getVaults(validatorAddresses: string[]): Promise<VaultRow[]> {
    if (validatorAddresses.length === 0) return [];
    const res = await this.pool.query<VaultRow>(
      `SELECT validator_address, vault_assets_atto::text, priority_staked_to_vault_atto::text,
              deferred_staked_to_vault_atto::text, delegation_rows, governor_destination_id,
              governor_status, validator_name, initial_assets_atto::text,
              exchange_manual_assets_atto::text,
              next_stage_assets_atto::text, qualified_deferred_assets_atto::text,
              manual_review_assets_atto::text, uncompiled_deferred_assets_atto::text,
              not_issued_assets_atto::text, post_policy_assets_atto::text
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
