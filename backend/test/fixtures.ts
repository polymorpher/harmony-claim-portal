/**
 * Synthetic rows (Hardhat dev addresses, made-up amounts). Mirrors the
 * injector's --fixture data set closely enough to exercise every branch.
 */
import type {
  AccountRow,
  ClaimRepository,
  DelegationRow,
  ExchangeRow,
  ExceptionRow,
  ReasonText,
  SnapshotMeta,
  VaultRow,
} from "../src/repository.js";

export const ONE = 10n ** 18n;
const one = (n: number | bigint) => (BigInt(n) * ONE).toString();

export const ADDR = {
  eoa: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  small: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  v1: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  v2: "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  excl: "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  partial: "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  safe: "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  wone: "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  gate: "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  exchange: "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
  onewallet: "0x1111111111111111111111111111111111111111",
  bridge: "0x2222222222222222222222222222222222222222",
  deducted: "0x3333333333333333333333333333333333333333",
  unknown: "0x4444444444444444444444444444444444444444",
  exchangeOnly: "0x5555555555555555555555555555555555555555",
} as const;

export function account(partial: Partial<AccountRow> & { address: string }): AccountRow {
  const wallet = partial.wallet_airdrop_atto ?? "0";
  const staked = partial.staked_to_vault_atto ?? "0";
  const nativeWallet = partial.native_wallet_airdrop_atto ?? wallet;
  const woneBalance = partial.wone_balance_atto ?? "0";
  const woneAirdrop = partial.wone_airdrop_atto ?? "0";
  const nativeTotal = partial.native_total_claim_atto ?? (BigInt(nativeWallet) + BigInt(staked)).toString();
  const qualification = partial.qualification_total_atto ?? (BigInt(nativeTotal) + BigInt(woneBalance)).toString();
  const total = partial.total_claim_atto ?? (BigInt(wallet) + BigInt(staked)).toString();
  return {
    secure_key: "00".repeat(32),
    address_resolved: true,
    account_category: "ordinary_eoa",
    code_bearing: false,
    contract_primary_category: null,
    contract_subcategory: null,
    contract_identity: null,
    contract_treatment: null,
    policy_category: BigInt(qualification) >= 1000n * ONE ? "automatic" : "deferred",
    liquid_shard0_atto: nativeWallet,
    liquid_shard1_atto: "0",
    active_staked_or_delegated_atto: staked,
    pending_undelegation_atto: "0",
    unclaimed_staking_reward_atto: "0",
    pending_cross_shard_atto: "0",
    native_wallet_airdrop_atto: nativeWallet,
    wone_balance_atto: woneBalance,
    wone_airdrop_atto: woneAirdrop,
    wallet_airdrop_atto: wallet,
    staked_to_vault_atto: staked,
    qualification_total_atto: qualification,
    native_total_claim_atto: nativeTotal,
    total_claim_atto: total,
    meets_threshold: BigInt(qualification) >= 1000n * ONE,
    last_activity_time_utc: null,
    last_activity_block: null,
    last_activity_shard: null,
    last_activity_type: null,
    last_activity_tx_hash: null,
    ...partial,
  };
}

export const accounts: AccountRow[] = [
  account({ address: ADDR.eoa, wallet_airdrop_atto: one(5000), staked_to_vault_atto: one(2000) }),
  account({ address: ADDR.small, wallet_airdrop_atto: one(7), staked_to_vault_atto: one(5) }),
  account({
    address: ADDR.v1,
    account_category: "validator_account",
    code_bearing: true,
    wallet_airdrop_atto: one(300),
    staked_to_vault_atto: one(10_000),
  }),
  account({
    address: ADDR.excl,
    account_category: "excluded",
    wallet_airdrop_atto: one(1000),
    staked_to_vault_atto: one(4000),
  }),
  account({ address: ADDR.partial, wallet_airdrop_atto: one(8000), staked_to_vault_atto: one(2000) }),
  account({
    address: ADDR.safe,
    account_category: "contract",
    code_bearing: true,
    contract_primary_category: "multisig-wallet",
    contract_subcategory: "gnosis-safe",
    contract_identity: "2-of-3 fixture Safe",
    contract_treatment: "multisig_next_stage",
    policy_category: "contract_review",
    wallet_airdrop_atto: one(50_000),
  }),
  account({
    address: ADDR.wone,
    native_wallet_airdrop_atto: one(800),
    wone_balance_atto: one(300),
    wone_airdrop_atto: one(300),
    wallet_airdrop_atto: one(1100),
    qualification_total_atto: one(1100),
    native_total_claim_atto: one(800),
    total_claim_atto: one(1100),
  }),
  account({ address: ADDR.gate, wallet_airdrop_atto: one(500) }),
  account({ address: ADDR.exchange, wallet_airdrop_atto: one(1500), policy_category: "excluded" }),
  account({
    address: ADDR.onewallet,
    account_category: "contract",
    code_bearing: true,
    contract_primary_category: "onewallet",
    contract_treatment: "onewallet_recovery",
    policy_category: "contract_review",
    wallet_airdrop_atto: one(2000),
  }),
  account({
    address: ADDR.bridge,
    account_category: "contract",
    code_bearing: true,
    contract_primary_category: "known-app",
    contract_treatment: "bridge_later_portal",
    policy_category: "contract_review",
    wallet_airdrop_atto: one(3000),
  }),
  account({ address: ADDR.deducted, wallet_airdrop_atto: one(5000) }),
];

export const delegations: DelegationRow[] = [
  { validator_address: ADDR.v1, delegator_address: ADDR.eoa, staked_to_vault_atto: one(2000), is_self_delegation: false, priority: true },
  { validator_address: ADDR.v1, delegator_address: ADDR.small, staked_to_vault_atto: one(5), is_self_delegation: false, priority: false },
  { validator_address: ADDR.v1, delegator_address: ADDR.v1, staked_to_vault_atto: one(10_000), is_self_delegation: true, priority: true },
  { validator_address: ADDR.v1, delegator_address: ADDR.excl, staked_to_vault_atto: one(3000), is_self_delegation: false, priority: true },
  { validator_address: ADDR.v2, delegator_address: ADDR.excl, staked_to_vault_atto: one(1000), is_self_delegation: false, priority: true },
  { validator_address: ADDR.v1, delegator_address: ADDR.partial, staked_to_vault_atto: one(2000), is_self_delegation: false, priority: true },
];

export const vaults: VaultRow[] = [
  { validator_address: ADDR.v1, vault_assets_atto: one(17_005), priority_staked_to_vault_atto: one(17_000), deferred_staked_to_vault_atto: one(5), delegation_rows: 5, governor_destination_id: null, governor_status: "ready", validator_name: "Fixture One" },
  { validator_address: ADDR.v2, vault_assets_atto: one(22_500), priority_staked_to_vault_atto: one(22_500), deferred_staked_to_vault_atto: "0", delegation_rows: 3, governor_destination_id: null, governor_status: "hold", validator_name: null },
];

const ex = (p: Partial<ExceptionRow> & Pick<ExceptionRow, "component" | "source_address" | "amount_atto" | "exception_type" | "destination_status">): ExceptionRow => ({
  source_category: "ordinary_eoa",
  validator_address: null,
  route_id: "r",
  route_priority: 100,
  destination_id: null,
  destination_address: null,
  reason: "",
  evidence: "",
  ...p,
});

export const exceptions: ExceptionRow[] = [
  ex({ component: "wallet_airdrop", source_address: ADDR.v1, amount_atto: one(300), exception_type: "validator_wrapper_same_address", destination_status: "ready", destination_address: ADDR.v1, reason: "verified validator wrapper same-address", source_category: "validator_account" }),
  ex({ component: "vault_shares", source_address: ADDR.v1, validator_address: ADDR.v1, amount_atto: one(10_000), exception_type: "validator_wrapper_same_address", destination_status: "ready", destination_address: ADDR.v1, reason: "verified validator wrapper same-address", source_category: "validator_account" }),
  ex({ component: "wallet_airdrop", source_address: ADDR.excl, amount_atto: one(1000), exception_type: "explicit_route", destination_status: "not_issuing", destination_id: "not-issuing", reason: "not_issuing_blacklisted_extra_mint_recipient", source_category: "excluded" }),
  ex({ component: "vault_shares", source_address: ADDR.excl, validator_address: ADDR.v1, amount_atto: one(3000), exception_type: "explicit_route", destination_status: "not_issuing", destination_id: "not-issuing", reason: "not_issuing_blacklisted_extra_mint_recipient", source_category: "excluded" }),
  ex({ component: "vault_shares", source_address: ADDR.excl, validator_address: ADDR.v2, amount_atto: one(1000), exception_type: "explicit_route", destination_status: "not_issuing", destination_id: "not-issuing", reason: "not_issuing_blacklisted_extra_mint_recipient", source_category: "excluded" }),
  ex({ component: "wallet_airdrop", source_address: ADDR.partial, amount_atto: one(5000), exception_type: "explicit_route", destination_status: "not_issuing", destination_id: "not-issuing", reason: "not_issuing_blacklisted_extra_mint_recipient" }),
  ex({ component: "wallet_airdrop", source_address: ADDR.safe, amount_atto: one(50_000), exception_type: "contract_review_hold", destination_status: "hold", reason: "contract_review", source_category: "contract_review", route_priority: 1_000_000 }),
  ex({ component: "wallet_airdrop", source_address: ADDR.deducted, amount_atto: one(5000), exception_type: "explicit_route", destination_status: "not_issuing", destination_id: "not-issuing", reason: "not_issuing_burn_or_inaccessible", source_category: "excluded" }),
];

export const exchangeWallets: ExchangeRow[] = [
  {
    exchange_id: "gate",
    display_name: "Gate",
    address: ADDR.gate,
    delivery_policy: "automatic_threshold",
    qualification_status: "below_threshold",
    planned_delivery_status: "below_threshold_not_airdropped",
    configured_destination: null,
    configured_destination_status: "not_required_same_address",
  },
  {
    exchange_id: "okx",
    display_name: "OKX",
    address: ADDR.exchange,
    delivery_policy: "manual_current_claim",
    qualification_status: "qualified",
    planned_delivery_status: "manual_exchange_route",
    configured_destination: ADDR.eoa,
    configured_destination_status: "ready",
  },
  {
    exchange_id: "mexc",
    display_name: "MEXC",
    address: ADDR.exchangeOnly,
    delivery_policy: "manual_current_claim",
    qualification_status: "below_threshold",
    planned_delivery_status: "no_cutoff_claim",
    configured_destination: ADDR.eoa,
    configured_destination_status: "ready",
  },
];

export const reasonTexts: Record<string, ReasonText> = {
  not_issuing_blacklisted_extra_mint_recipient: { title: "Deduction: extra-mint", user_text: "not returned" },
  not_issuing_burn_or_inaccessible: { title: "Deduction: inaccessible", user_text: "retained in reserve" },
  contract_review: { title: "Held: smart contract", user_text: "later phase" },
  "verified validator wrapper same-address": { title: "Verified validator account", user_text: "same address" },
};

export const snapshotMeta: SnapshotMeta = {
  cutoff: {
    requested_time_utc: "2026-09-10T14:00:00Z",
    shard0: { block: 93623067, timestamp_utc: "2026-09-10T14:00:00Z", hash: "0x11", state_root: "0x22" },
    shard1: { block: 95882100, timestamp_utc: "2026-09-10T14:00:00Z", hash: "0x33", state_root: "0x44" },
  },
  threshold_atto: one(1000),
  data_version: "fixture-test",
  loaded_at: "2026-09-15T00:00:00Z",
  fixture: true,
};

export class MemoryRepository implements ClaimRepository {
  failPing = false;
  async ping(): Promise<void> {
    if (this.failPing) throw new Error("down");
  }
  async getMeta(): Promise<SnapshotMeta> {
    return snapshotMeta;
  }
  async getAccount(a: string): Promise<AccountRow | null> {
    return accounts.find((r) => r.address === a) ?? null;
  }
  async getDelegations(a: string): Promise<DelegationRow[]> {
    return delegations.filter((d) => d.delegator_address === a);
  }
  async getExceptions(a: string): Promise<ExceptionRow[]> {
    return exceptions.filter((e) => e.source_address === a);
  }
  async getExchangeWallets(a: string): Promise<ExchangeRow[]> {
    return exchangeWallets.filter((e) => e.address === a);
  }
  async getVaults(vs: string[]): Promise<VaultRow[]> {
    return vaults.filter((v) => vs.includes(v.validator_address));
  }
  async getReasonTexts(): Promise<Record<string, ReasonText>> {
    return reasonTexts;
  }
  async close(): Promise<void> {}
}
