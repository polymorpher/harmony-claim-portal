/**
 * Wire types for the claim portal API. Every amount is a pair of fields: a
 * decimal atto-ONE string (`*_atto`) and an exact ONE display string (`*_one`).
 */

export type AccountType = "ordinary_eoa" | "validator_account" | "contract" | "excluded";
export type EligibilityStatus = "prioritized" | "deferred" | "not_issuing" | "handled_by_exchange";
export type DestinationStatus = "ready" | "hold" | "not_issuing" | "redistributed" | "none";
export type AdjustmentKind = "deduction" | "redistribution" | "hold" | "redirect" | "same_address";
export type Component = "wallet_airdrop" | "vault_shares";
export type DispositionCode =
  | "automatic_same_address"
  | "deferred"
  | "not_issuing"
  | "handled_by_exchange"
  | "exchange_no_claim"
  | "gate_aggregate_pending"
  | "multisig_next_stage"
  | "onewallet_recovery"
  | "bridge_later_portal"
  | "contract_recovery"
  | "hold";

export interface AddressForms {
  /** lowercase 0x hex */
  hex: string;
  /** EIP-55 checksum */
  checksum: string;
  /** one1... bech32 */
  bech32: string;
}

export interface CutoffShard {
  block: number;
  timestamp_utc: string | null;
  hash: string | null;
  state_root: string | null;
}

export interface MetaResponse {
  cutoff: {
    requested_time_utc: string | null;
    shard0: CutoffShard | null;
    shard1: CutoffShard | null;
  };
  threshold_atto: string;
  threshold_one: string;
  data_version: string | null;
  loaded_at: string | null;
  fixture: boolean;
  routing_status: string | null;
  pending_policy_decisions: string[];
}

export interface Eligibility {
  /** Post-deduction claim. Kept under the original field name for API compatibility. */
  total_claim_atto: string;
  total_claim_one: string;
  gross_total_claim_atto: string;
  gross_total_claim_one: string;
  not_issued_atto: string;
  not_issued_one: string;
  redistributed_atto: string;
  redistributed_one: string;
  qualification_total_atto: string;
  qualification_total_one: string;
  meets_threshold: boolean;
  status: EligibilityStatus;
}

export interface Components {
  liquid_shard0_atto: string;
  liquid_shard0_one: string;
  liquid_shard1_atto: string;
  liquid_shard1_one: string;
  active_staked_or_delegated_atto: string;
  active_staked_or_delegated_one: string;
  pending_undelegation_atto: string;
  pending_undelegation_one: string;
  unclaimed_staking_reward_atto: string;
  unclaimed_staking_reward_one: string;
  pending_cross_shard_atto: string;
  pending_cross_shard_one: string;
  native_wallet_airdrop_atto: string;
  native_wallet_airdrop_one: string;
  wone_balance_atto: string;
  wone_balance_one: string;
  wone_airdrop_atto: string;
  wone_airdrop_one: string;
  wallet_airdrop_atto: string;
  wallet_airdrop_one: string;
  staked_to_vault_atto: string;
  staked_to_vault_one: string;
  qualification_total_atto: string;
  qualification_total_one: string;
  native_total_claim_atto: string;
  native_total_claim_one: string;
}

export interface Destination {
  address: string | null;
  status: DestinationStatus;
}

export interface WalletAirdrop {
  gross_atto: string;
  gross_one: string;
  not_issued_atto: string;
  not_issued_one: string;
  redistributed_atto: string;
  redistributed_one: string;
  held_atto: string;
  held_one: string;
  net_atto: string;
  net_one: string;
  issuable_atto: string;
  issuable_one: string;
  destination: Destination;
}

export interface VaultTotals {
  assets_atto: string;
  assets_one: string;
  priority_staked_atto: string;
  priority_staked_one: string;
  deferred_staked_atto: string;
  deferred_staked_one: string;
  delegation_rows: number;
  governor_status: string;
  governor_destination_id: string | null;
}

export interface VaultPosition {
  validator: AddressForms;
  validator_name: string | null;
  is_self_delegation: boolean;
  priority: boolean;
  staked_atto: string;
  staked_one: string;
  not_issued_atto: string;
  not_issued_one: string;
  redistributed_atto: string;
  redistributed_one: string;
  held_atto: string;
  held_one: string;
  /** 1:1 with net principal (staked - not_issued) at vault seeding */
  expected_shares_atto: string;
  expected_shares_one: string;
  status: DestinationStatus;
  destination: Destination;
  vault: VaultTotals | null;
}

export interface Adjustment {
  kind: AdjustmentKind;
  component: Component;
  validator_address: string | null;
  amount_atto: string;
  amount_one: string;
  exception_type: string;
  reason_code: string;
  title: string;
  user_text: string;
  destination_id: string | null;
  destination_address: string | null;
  destination_status: DestinationStatus;
  evidence: string;
}

export interface ExchangeTreatment {
  exchange_id: string;
  display_name: string;
  delivery_policy: string;
  qualification_status: string;
  planned_delivery_status: string;
  destination: Destination;
}

export interface Disposition {
  code: DispositionCode;
  title: string;
  detail: string;
  destination: Destination;
}

export interface ClaimResponse {
  found: boolean;
  address: AddressForms;
  account_type: AccountType | null;
  contract_category: string | null;
  code_bearing: boolean;
  eligibility: Eligibility | null;
  components: Components | null;
  wallet_airdrop: WalletAirdrop | null;
  vault_positions: VaultPosition[];
  adjustments: Adjustment[];
  exchange_treatments: ExchangeTreatment[];
  disposition: Disposition | null;
  notes: string[];
  last_activity: {
    time_utc: string | null;
    block: number | null;
    shard: number | null;
    type: string | null;
    tx_hash: string | null;
  } | null;
  meta: MetaResponse;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}
