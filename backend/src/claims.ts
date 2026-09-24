/**
 * Pure construction of the /api/v1/claims/:address response from database
 * rows. No I/O here so the shape is unit-testable with synthetic rows.
 */
import {
  attoToOne,
  formatOne,
  toBigInt,
  type Adjustment,
  type AdjustmentKind,
  type ClaimResponse,
  type Components,
  type Destination,
  type DestinationStatus,
  type Disposition,
  type ExchangeTreatment,
  type MetaResponse,
  type MigrationPolicy,
  type MigrationStage,
  type VaultPosition,
  type WalletAirdrop,
} from "@hcp/shared";
import { addressForms } from "./address.js";
import type {
  AccountRow,
  DelegationRow,
  ExchangeRow,
  ExceptionRow,
  ReasonText,
  SnapshotMeta,
  VaultRow,
} from "./repository.js";

export interface BuildOptions {
  exposeContractAmounts: boolean;
}

/** Decimal atto string, exact ONE display string. */
export function amountPair(value: string | bigint): [string, string] {
  const atto = toBigInt(value);
  return [atto.toString(), attoToOne(atto)];
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function sentenceCase(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

function shard(v: unknown) {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const block = asNumber(o.block);
  if (block === null) return null;
  return {
    block,
    timestamp_utc: asString(o.timestamp_utc),
    hash: asString(o.hash),
    state_root: asString(o.state_root),
  };
}

export function buildMeta(meta: SnapshotMeta): MetaResponse {
  const cutoff = (meta.cutoff ?? {}) as Record<string, unknown>;
  const routing = (meta.routing ?? {}) as Record<string, unknown>;
  const pending = routing.pending_policy_decisions;
  const [threshold_atto, threshold_one] = amountPair(
    asString(meta.threshold_atto) ?? "1000000000000000000000",
  );
  return {
    cutoff: {
      requested_time_utc: asString(cutoff.requested_time_utc),
      shard0: shard(cutoff.shard0),
      shard1: shard(cutoff.shard1),
    },
    threshold_atto,
    threshold_one,
    data_version: asString(meta.data_version),
    loaded_at: asString(meta.loaded_at),
    fixture: meta.fixture === true,
    routing_status: asString(routing.status),
    initial_stage_status: asString(routing.initial_stage_status),
    pending_policy_decisions: Array.isArray(pending)
      ? pending.filter((value): value is string => typeof value === "string")
      : [],
  };
}

function reasonFor(
  ex: ExceptionRow,
  texts: Record<string, ReasonText>,
): { code: string; title: string; user_text: string } {
  const code = ex.reason || ex.exception_type;
  const t = texts[code] ?? texts[ex.exception_type];
  if (t) return { code, title: t.title, user_text: t.user_text };
  const fallbackTitle: Record<DestinationStatus, string> = {
    not_issuing: "Deduction: not issued",
    redistributed: "WONE reserve redistributed to holders",
    hold: "Held pending a policy decision",
    exchange_manual: "Sent separately by exchange arrangement",
    ready: "Routed",
    none: "",
  };
  return { code, title: fallbackTitle[ex.destination_status], user_text: code.replace(/_/g, " ") };
}

function kindOf(ex: ExceptionRow): AdjustmentKind {
  if (ex.destination_status === "not_issuing") return "deduction";
  if (ex.destination_status === "redistributed") return "redistribution";
  if (ex.destination_status === "hold") return "hold";
  if (ex.destination_status === "exchange_manual") return "manual_delivery";
  if (ex.exception_type === "validator_wrapper_same_address") return "same_address";
  if (ex.destination_address && ex.destination_address.toLowerCase() === ex.source_address.toLowerCase()) {
    return "same_address";
  }
  return "redirect";
}

function destinationFor(s: Split, sameAddress: string): Destination {
  const issuable = s.gross - s.notIssued - s.redistributed - s.held - s.manual;
  if (s.gross === 0n) return { address: null, status: "none" };
  if (issuable > 0n) {
    const redirects = new Set(
      s.ready
        .map((r) => r.destination_address?.toLowerCase() ?? null)
        .filter((a): a is string => a !== null && a !== sameAddress),
    );
    if (redirects.size === 1) return { address: [...redirects][0], status: "ready" };
    return { address: sameAddress, status: "ready" };
  }
  if (s.held > 0n) return { address: null, status: "hold" };
  if (s.manual > 0n) {
    const targets = new Set(
      s.manualRows
        .map((r) => r.destination_address?.toLowerCase() ?? null)
        .filter((a): a is string => a !== null),
    );
    return { address: targets.size === 1 ? [...targets][0] : null, status: "exchange_manual" };
  }
  if (s.redistributed > 0n && s.notIssued === 0n) return { address: null, status: "redistributed" };
  return { address: null, status: "not_issuing" };
}

interface Split {
  gross: bigint;
  notIssued: bigint;
  redistributed: bigint;
  held: bigint;
  manual: bigint;
  ready: ExceptionRow[];
  manualRows: ExceptionRow[];
}

function splitExceptions(gross: bigint, rows: ExceptionRow[]): Split {
  let notIssued = 0n;
  let redistributed = 0n;
  let held = 0n;
  let manual = 0n;
  const ready: ExceptionRow[] = [];
  const manualRows: ExceptionRow[] = [];
  for (const ex of rows) {
    const a = toBigInt(ex.amount_atto);
    if (ex.destination_status === "not_issuing") notIssued += a;
    else if (ex.destination_status === "redistributed") redistributed += a;
    else if (ex.destination_status === "hold") held += a;
    else if (ex.destination_status === "exchange_manual") {
      manual += a;
      manualRows.push(ex);
    } else ready.push(ex);
  }
  return { gross, notIssued, redistributed, held, manual, ready, manualRows };
}

function walletBreakdown(account: AccountRow, exceptions: ExceptionRow[]): WalletAirdrop {
  const s = splitExceptions(
    toBigInt(account.wallet_airdrop_atto),
    exceptions.filter((e) => e.component === "wallet_airdrop"),
  );
  const net = s.gross - s.notIssued - s.redistributed;
  const issuable = net - s.held - s.manual;
  const [gross_atto, gross_one] = amountPair(s.gross);
  const [not_issued_atto, not_issued_one] = amountPair(s.notIssued);
  const [redistributed_atto, redistributed_one] = amountPair(s.redistributed);
  const [held_atto, held_one] = amountPair(s.held);
  const [net_atto, net_one] = amountPair(net < 0n ? 0n : net);
  const [manual_delivery_atto, manual_delivery_one] = amountPair(s.manual);
  const destination = destinationFor(s, account.address ?? "");
  const initialStage = account.stage_policy_applied
    ? account.migration_stage === "initial"
      ? toBigInt(account.migration_wallet_allocation_atto)
      : 0n
    : 0n;
  const deliverable = destination.status === "ready"
    ? initialStage
    : 0n;
  const [initial_stage_atto, initial_stage_one] = amountPair(initialStage);
  const [issuable_atto, issuable_one] = amountPair(
    deliverable < issuable ? deliverable : issuable,
  );
  return {
    gross_atto,
    gross_one,
    not_issued_atto,
    not_issued_one,
    redistributed_atto,
    redistributed_one,
    held_atto,
    held_one,
    net_atto,
    net_one,
    manual_delivery_atto,
    manual_delivery_one,
    initial_stage_atto,
    initial_stage_one,
    issuable_atto,
    issuable_one,
    destination,
  };
}

function vaultPositions(
  account: AccountRow,
  delegations: DelegationRow[],
  exceptions: ExceptionRow[],
  vaults: VaultRow[],
): VaultPosition[] {
  const vaultByAddr = new Map(vaults.map((v) => [v.validator_address.toLowerCase(), v]));
  return delegations.map((d) => {
    const validator = d.validator_address.toLowerCase();
    const s = splitExceptions(
      toBigInt(d.staked_to_vault_atto),
      exceptions.filter(
        (e) => e.component === "vault_shares" && (e.validator_address ?? "").toLowerCase() === validator,
      ),
    );
    const net = s.gross - s.notIssued - s.redistributed - s.manual;
    const destination = destinationFor(s, account.address ?? "");
    const v = vaultByAddr.get(validator);
    const [staked_atto, staked_one] = amountPair(s.gross);
    const [not_issued_atto, not_issued_one] = amountPair(s.notIssued);
    const [redistributed_atto, redistributed_one] = amountPair(s.redistributed);
    const [held_atto, held_one] = amountPair(s.held);
    const [manual_delivery_atto, manual_delivery_one] = amountPair(s.manual);
    const [expected_shares_atto, expected_shares_one] = amountPair(net < 0n ? 0n : net);
    const initialShares = account.stage_policy_applied
      ? account.migration_stage === "initial"
        ? (net < 0n ? 0n : net)
        : 0n
      : 0n;
    const [initial_stage_shares_atto, initial_stage_shares_one] = amountPair(initialShares);
    let vault: VaultPosition["vault"] = null;
    if (v) {
      const [assets_atto, assets_one] = amountPair(v.vault_assets_atto);
      const [priority_staked_atto, priority_staked_one] = amountPair(v.priority_staked_to_vault_atto);
      const [deferred_staked_atto, deferred_staked_one] = amountPair(v.deferred_staked_to_vault_atto);
      const [initial_assets_atto, initial_assets_one] = amountPair(v.initial_assets_atto);
      const [exchange_manual_assets_atto, exchange_manual_assets_one] = amountPair(
        v.exchange_manual_assets_atto,
      );
      const [next_stage_assets_atto, next_stage_assets_one] = amountPair(v.next_stage_assets_atto);
      const [qualified_deferred_assets_atto, qualified_deferred_assets_one] = amountPair(
        v.qualified_deferred_assets_atto,
      );
      const [manual_review_assets_atto, manual_review_assets_one] = amountPair(v.manual_review_assets_atto);
      const [not_issued_assets_atto, not_issued_assets_one] = amountPair(v.not_issued_assets_atto);
      const [post_policy_assets_atto, post_policy_assets_one] = amountPair(v.post_policy_assets_atto);
      vault = {
        assets_atto,
        assets_one,
        priority_staked_atto,
        priority_staked_one,
        deferred_staked_atto,
        deferred_staked_one,
        delegation_rows: Number(v.delegation_rows),
        governor_status: v.governor_status,
        governor_destination_id: v.governor_destination_id,
        initial_assets_atto,
        initial_assets_one,
        exchange_manual_assets_atto,
        exchange_manual_assets_one,
        next_stage_assets_atto,
        next_stage_assets_one,
        qualified_deferred_assets_atto,
        qualified_deferred_assets_one,
        manual_review_assets_atto,
        manual_review_assets_one,
        not_issued_assets_atto,
        not_issued_assets_one,
        post_policy_assets_atto,
        post_policy_assets_one,
      };
    }
    return {
      validator: addressForms(validator),
      validator_name: v?.validator_name ?? null,
      is_self_delegation: d.is_self_delegation,
      initial_stage: initialShares > 0n,
      priority: d.priority,
      staked_atto,
      staked_one,
      not_issued_atto,
      not_issued_one,
      redistributed_atto,
      redistributed_one,
      held_atto,
      held_one,
      manual_delivery_atto,
      manual_delivery_one,
      expected_shares_atto,
      expected_shares_one,
      initial_stage_shares_atto,
      initial_stage_shares_one,
      status: destination.status,
      destination,
      vault,
    };
  });
}

function components(account: AccountRow): Components {
  const [liquid_shard0_atto, liquid_shard0_one] = amountPair(account.liquid_shard0_atto);
  const [liquid_shard1_atto, liquid_shard1_one] = amountPair(account.liquid_shard1_atto);
  const [active_staked_or_delegated_atto, active_staked_or_delegated_one] = amountPair(
    account.active_staked_or_delegated_atto,
  );
  const [pending_undelegation_atto, pending_undelegation_one] = amountPair(account.pending_undelegation_atto);
  const [unclaimed_staking_reward_atto, unclaimed_staking_reward_one] = amountPair(
    account.unclaimed_staking_reward_atto,
  );
  const [pending_cross_shard_atto, pending_cross_shard_one] = amountPair(account.pending_cross_shard_atto);
  const [native_wallet_airdrop_atto, native_wallet_airdrop_one] = amountPair(account.native_wallet_airdrop_atto);
  const [wone_balance_atto, wone_balance_one] = amountPair(account.wone_balance_atto);
  const [wone_airdrop_atto, wone_airdrop_one] = amountPair(account.wone_airdrop_atto);
  const [wallet_airdrop_atto, wallet_airdrop_one] = amountPair(account.wallet_airdrop_atto);
  const [staked_to_vault_atto, staked_to_vault_one] = amountPair(account.staked_to_vault_atto);
  const [qualification_total_atto, qualification_total_one] = amountPair(account.qualification_total_atto);
  const [native_total_claim_atto, native_total_claim_one] = amountPair(account.native_total_claim_atto);
  return {
    liquid_shard0_atto,
    liquid_shard0_one,
    liquid_shard1_atto,
    liquid_shard1_one,
    active_staked_or_delegated_atto,
    active_staked_or_delegated_one,
    pending_undelegation_atto,
    pending_undelegation_one,
    unclaimed_staking_reward_atto,
    unclaimed_staking_reward_one,
    pending_cross_shard_atto,
    pending_cross_shard_one,
    native_wallet_airdrop_atto,
    native_wallet_airdrop_one,
    wone_balance_atto,
    wone_balance_one,
    wone_airdrop_atto,
    wone_airdrop_one,
    wallet_airdrop_atto,
    wallet_airdrop_one,
    staked_to_vault_atto,
    staked_to_vault_one,
    qualification_total_atto,
    qualification_total_one,
    native_total_claim_atto,
    native_total_claim_one,
  };
}

function toIso(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : v;
}

function exchangeTreatments(rows: ExchangeRow[]): ExchangeTreatment[] {
  return rows.map((row) => {
    const status: DestinationStatus =
      row.planned_delivery_status === "exchange_manual"
        ? "exchange_manual"
        : row.planned_delivery_status === "hold"
          ? "hold"
          : "none";
    const walletAddress = status === "exchange_manual"
      ? row.planned_wallet_destination?.toLowerCase() ?? null
      : null;
    const stakingAddress = status === "exchange_manual"
      ? row.planned_staking_destination?.toLowerCase() ?? null
      : null;
    return {
      exchange_id: row.exchange_id,
      display_name: row.display_name,
      delivery_policy: row.delivery_policy,
      qualification_status: row.qualification_status,
      migration_stage: row.migration_stage,
      issuance_treatment: row.issuance_treatment,
      planned_delivery_status: row.planned_delivery_status,
      destination_mode: row.destination_mode,
      delivery_tier: row.delivery_tier,
      destination: { address: walletAddress, status },
      staking_destination:
        stakingAddress && stakingAddress !== walletAddress
          ? { address: stakingAddress, status }
          : null,
    };
  });
}

function asMigrationStage(value: string | null): MigrationStage {
  if (
    value === "initial" ||
    value === "exchange_manual" ||
    value === "next_stage" ||
    value === "deferred" ||
    value === "manual_review" ||
    value === "below_threshold"
  ) {
    return value;
  }
  return null;
}

function reviewedContractIsNotIssued(account: AccountRow): boolean {
  return (
    account.account_category === "contract" &&
    account.policy_category === "contract_review" &&
    !["multisig_next_stage", "onewallet_recovery", "bridge_later_portal"].includes(
      account.contract_treatment ?? "",
    )
  );
}

function migrationPolicyFor(account: AccountRow): MigrationPolicy {
  const manual = account.issuance_treatment === "manual_from_reserve";
  const issuance: MigrationPolicy["issuance_treatment"] = manual
    ? "manual_from_reserve"
    : account.issuance_treatment === "not_issued" || reviewedContractIsNotIssued(account)
      ? "not_issued"
      : "issue";
  const fallbackStage: MigrationStage = !account.meets_threshold
    ? "below_threshold"
    : null;
  const stage = manual
    ? "exchange_manual"
    : account.stage_policy_applied
      ? asMigrationStage(account.migration_stage)
      : issuance === "not_issued"
        ? null
        : fallbackStage;
  const hasAllocation = account.stage_policy_applied || manual;
  const wallet = hasAllocation
    ? toBigInt(account.migration_wallet_allocation_atto)
    : 0n;
  const staked = hasAllocation
    ? toBigInt(account.migration_staked_to_vault_atto)
    : 0n;
  const total = hasAllocation
    ? toBigInt(account.migration_allocation_atto)
    : wallet + staked;
  const [wallet_allocation_atto, wallet_allocation_one] = amountPair(wallet);
  const [staked_to_vault_atto, staked_to_vault_one] = amountPair(staked);
  const [total_allocation_atto, total_allocation_one] = amountPair(total);
  return {
    stage_policy_applied: account.stage_policy_applied,
    snapshot_qualified: account.meets_threshold,
    stage,
    issuance_treatment: issuance,
    stage_reason: account.stage_reason,
    wallet_allocation_atto,
    wallet_allocation_one,
    staked_to_vault_atto,
    staked_to_vault_one,
    total_allocation_atto,
    total_allocation_one,
  };
}

function redactMigrationAmounts(policy: MigrationPolicy): MigrationPolicy {
  return {
    ...policy,
    wallet_allocation_atto: null,
    wallet_allocation_one: null,
    staked_to_vault_atto: null,
    staked_to_vault_one: null,
    total_allocation_atto: null,
    total_allocation_one: null,
  };
}

function leftOutOfInitialAirdrop(
  account: { account_category: string } | null,
  reason: string | null | undefined,
): string | null {
  if (!account) return null;
  if (account.account_category !== "ordinary_eoa" && account.account_category !== "validator_account") return null;
  if (reason === "wallet activity predates initial window") {
    return "This wallet's last activity on Harmony was more than six months before the cutoff. Wallets like this are left out to keep dead and inaccessible wallets out of the migrated supply.";
  }
  if (reason === "no indexed wallet activity") {
    return "No activity on Harmony was found for this wallet before the cutoff. Wallets like this are left out to keep dead and inaccessible wallets out of the migrated supply.";
  }
  return null;
}

function exchangeDisposition(exchange: ExchangeTreatment): Disposition {
  const name = exchange.display_name;
  const title = `Handled by ${name}`;
  const intro = `This is a ${name} wallet, so it is not part of the airdrop.`;
  if (exchange.destination.status !== "exchange_manual") {
    return {
      code: "handled_by_exchange",
      title,
      detail: `${intro} Its full balance will be sent separately once ${name} confirms a delivery address.`,
      destination: exchange.destination,
    };
  }
  const sameAddress =
    exchange.delivery_tier === "same_address" || exchange.delivery_tier === "same_address_initial";
  const target = sameAddress
    ? "to this same address"
    : exchange.staking_destination
      ? `to ${name}: the liquid balance to one ${name} address and staked ONE, including rewards, to another`
      : `to ${name}'s consolidation address`;
  const tier =
    exchange.delivery_tier === "same_address_initial"
      ? " It meets the initial airdrop criteria, so,"
      : exchange.delivery_tier === "aggregated_non_initial"
        ? " It does not meet the initial airdrop criteria, so,"
        : "";
  return {
    code: "handled_by_exchange",
    title,
    detail: tier
      ? `${intro}${tier} as arranged with ${name}, its full balance is sent separately ${target}.`
      : `${intro} As arranged with ${name}, its full balance is sent separately ${target}.`,
    destination: exchange.destination,
  };
}

function dispositionFor(
  account: AccountRow | null,
  exchanges: ExchangeTreatment[],
  migration: MigrationPolicy | null,
  netTotal: bigint | null,
  notIssuedTotal: bigint | null,
  walletDestination: Destination | null,
): Disposition | null {
  if (
    migration?.issuance_treatment === "not_issued" ||
    (netTotal === 0n && notIssuedTotal !== null && notIssuedTotal > 0n)
  ) {
    return {
      code: "not_issuing",
      title: "Not issued",
      detail: "The migration allocation is not issued and is retained in the 2050 premint reserve.",
      destination: { address: null, status: "not_issuing" },
    };
  }

  if (exchanges.length > 0) {
    const exchange = exchanges[0];
    if (migration?.issuance_treatment === "manual_from_reserve") {
      return exchangeDisposition(exchange);
    }
    return {
      code: "exchange_no_claim",
      title: `${exchange.display_name} wallet — nothing to deliver`,
      detail: `This address is on ${exchange.display_name}'s wallet list, but it held nothing to migrate at the cutoff.`,
      destination: { address: null, status: "none" },
    };
  }

  if (account?.meets_threshold && !migration?.stage_policy_applied) {
    return {
      code: "hold",
      title: "Migration stage unavailable",
      detail: "Snapshot qualification is recorded, but the reviewed migration-stage policy has not been loaded. No initial-stage delivery is authorized.",
      destination: { address: null, status: "hold" },
    };
  }

  if (account?.contract_treatment === "multisig_next_stage") {
    return {
      code: "multisig_next_stage",
      title: "To be migrated in the next stage",
      detail: "This is a reviewed multisig. Its verified owner and threshold controls will be preserved in the next migration stage.",
      destination: { address: null, status: "hold" },
    };
  }
  if (account?.contract_treatment === "onewallet_recovery") {
    return {
      code: "onewallet_recovery",
      title: "To be routed to the 1wallet recovery multisig",
      detail: "This reviewed 1wallet allocation is excluded from the initial distribution and will be handled in the next stage.",
      destination: { address: null, status: "hold" },
    };
  }
  if (account?.contract_treatment === "bridge_later_portal") {
    return {
      code: "bridge_later_portal",
      title: "Bridge contract",
      detail: "A dedicated claim portal for the bridge will be available in a later stage.",
      destination: { address: null, status: "hold" },
    };
  }
  if (
    account?.account_category === "contract" &&
    (migration?.stage === "deferred" || migration?.stage === "below_threshold")
  ) {
    return {
      code: "deferred",
      title: "Deferred",
      detail: migration.stage_reason ||
        "This unreviewed code-bearing account is outside the current migration stage.",
      destination: { address: null, status: "hold" },
    };
  }
  const leftOut = leftOutOfInitialAirdrop(account, migration?.stage_reason);
  if (migration?.stage === "deferred" && leftOut) {
    return {
      code: "deferred",
      title: "Not in the initial airdrop",
      detail: leftOut,
      destination: walletDestination ?? { address: null, status: "hold" },
    };
  }
  if (
    migration?.stage === "deferred" ||
    migration?.stage === "manual_review" ||
    migration?.stage === "below_threshold"
  ) {
    return {
      code: "deferred",
      title: migration.stage === "manual_review"
        ? "Under review"
        : migration.stage === "below_threshold"
          ? "Below the minimum"
          : "Not in the initial airdrop",
      detail: migration.stage_reason ? sentenceCase(migration.stage_reason) :
        (migration.stage === "below_threshold"
          ? "This address's total at the cutoff was under the minimum, so it is not in the initial airdrop."
          : "This wallet is not in the initial airdrop."),
      destination: walletDestination ?? { address: null, status: "hold" },
    };
  }

  if (account?.account_category === "contract") {
    return {
      code: "contract_recovery",
      title: "Smart contract recovery",
      detail: "This contract is handled through a class-specific recovery process rather than a same-address airdrop.",
      destination: walletDestination ?? { address: null, status: "hold" },
    };
  }
  if (migration?.stage === "initial") {
    const routingReady =
      walletDestination?.status === "ready" || walletDestination?.status === "none";
    return {
      code: routingReady ? "automatic_same_address" : "hold",
      title: routingReady ? "Initial stage" : "Initial stage — routing on hold",
      detail: routingReady
        ? "This eligible wallet is included in the current six-month activity stage."
        : "This eligible wallet is in the current six-month activity stage, but its delivery destination is not yet ready.",
      destination: walletDestination ?? { address: account?.address ?? null, status: "ready" },
    };
  }
  if (walletDestination?.status === "hold") {
    return {
      code: "hold",
      title: "On hold",
      detail: "The entitlement is recorded, but an approved destination or policy decision is still pending.",
      destination: walletDestination,
    };
  }
  if (account) {
    return {
      code: "deferred",
      title: "Deferred",
      detail: "This account has no authorized initial-stage allocation.",
      destination: walletDestination ?? { address: null, status: "hold" },
    };
  }
  return null;
}

export function buildClaimResponse(
  addressLower: string,
  account: AccountRow | null,
  delegations: DelegationRow[],
  exceptions: ExceptionRow[],
  exchangeRows: ExchangeRow[],
  vaults: VaultRow[],
  reasonTexts: Record<string, ReasonText>,
  snapshotMeta: SnapshotMeta,
  options: BuildOptions,
): ClaimResponse {
  const meta = buildMeta(snapshotMeta);
  const address = addressForms(addressLower);
  const importedExchanges = exchangeTreatments(exchangeRows);
  const exchanges = account
    ? importedExchanges
    : importedExchanges.map((row) => ({
        ...row,
        destination: { address: null, status: "none" as const },
        staking_destination: null,
      }));
  const base: ClaimResponse = {
    found: false,
    address,
    account_type: null,
    contract_category: null,
    code_bearing: false,
    eligibility: null,
    components: null,
    wallet_airdrop: null,
    vault_positions: [],
    adjustments: [],
    exchange_treatments: exchanges,
    disposition: dispositionFor(null, exchanges, null, null, null, null),
    migration_policy: null,
    notes: [],
    last_activity: null,
    meta,
  };
  if (!account) {
    base.notes.push(
      exchanges.length > 0
        ? "No balance, stake or pending amount was recorded for this exchange wallet at the cutoff."
        : "No balance, stake or pending amount was recorded for this address at the cutoff.",
    );
    return base;
  }

  const notes: string[] = [];
  const isContract = account.account_category === "contract";
  const hideAmounts = isContract && !options.exposeContractAmounts;
  const category = account.contract_primary_category;
  const contractMigration = migrationPolicyFor(account);
  const contractDisposition = dispositionFor(
    account,
    exchanges,
    contractMigration,
    null,
    null,
    null,
  );

  if (isContract && contractMigration.issuance_treatment !== "manual_from_reserve") {
    notes.push(
      contractMigration.issuance_treatment === "not_issued"
        ? `This address is a reviewed smart contract${category ? ` (${category})` : ""}. Its migration allocation is not issued and is retained in the 2050 premint reserve.`
        : contractMigration.stage === "deferred" || contractMigration.stage === "below_threshold"
          ? `This code-bearing address${category ? ` (${category})` : ""} is deferred. No same-address contract delivery or later-stage recovery is authorized by this classification alone.`
          : `This address is a smart contract${category ? ` (${category})` : ""}. Contract balances are not delivered to the same address automatically; they are handled in a later phase through a class-specific recovery process.`,
    );
  }
  if (hideAmounts) {
    return {
      ...base,
      found: true,
      account_type: account.account_category,
      contract_category: category,
      code_bearing: account.code_bearing,
      disposition: contractDisposition,
      migration_policy: redactMigrationAmounts(contractMigration),
      notes,
    };
  }

  const grossTotal = toBigInt(account.total_claim_atto);
  const qualificationTotal = toBigInt(account.qualification_total_atto);
  const wallet = walletBreakdown(account, exceptions);
  const positions = vaultPositions(account, delegations, exceptions, vaults);

  const adjustments: Adjustment[] = exceptions.map((ex) => {
    const r = reasonFor(ex, reasonTexts);
    const [amount_atto, amount_one] = amountPair(ex.amount_atto);
    return {
      kind: kindOf(ex),
      component: ex.component,
      validator_address: ex.validator_address ? ex.validator_address.toLowerCase() : null,
      amount_atto,
      amount_one,
      exception_type: ex.exception_type,
      reason_code: r.code,
      title: r.title,
      user_text: r.user_text,
      destination_id: ex.destination_id,
      destination_address: ex.destination_address ? ex.destination_address.toLowerCase() : null,
      destination_status: ex.destination_status,
      migration_stage: asMigrationStage(ex.migration_stage),
      issuance_treatment: ex.issuance_treatment ??
        (ex.destination_status === "not_issuing"
          ? "not_issued"
          : ex.destination_status === "redistributed"
            ? "redistributed"
            : "issue"),
      evidence: ex.evidence,
    };
  });

  const notIssuedTotal =
    toBigInt(wallet.not_issued_atto) +
    positions.reduce((acc, p) => acc + toBigInt(p.not_issued_atto), 0n);
  const redistributedTotal =
    toBigInt(wallet.redistributed_atto) +
    positions.reduce((acc, p) => acc + toBigInt(p.redistributed_atto), 0n);
  const netTotalRaw = grossTotal - notIssuedTotal - redistributedTotal;
  const netTotal = netTotalRaw < 0n ? 0n : netTotalRaw;
  const netStaked = positions.reduce((acc, position) => acc + toBigInt(position.expected_shares_atto), 0n);
  let migration = migrationPolicyFor(account);
  const manualDelivery = migration.issuance_treatment === "manual_from_reserve";
  if (!account.stage_policy_applied && !manualDelivery) {
    const compiledStage = exceptions
      .map((exception) => asMigrationStage(exception.migration_stage))
      .find((stage) => stage !== null);
    if (compiledStage) {
      migration = { ...migration, stage: compiledStage };
      if (compiledStage === "manual_review" && netTotal > 0n) {
        const [wallet_allocation_atto, wallet_allocation_one] = amountPair(wallet.net_atto);
        const [staked_to_vault_atto, staked_to_vault_one] = amountPair(netStaked);
        const [total_allocation_atto, total_allocation_one] = amountPair(netTotal);
        migration = {
          ...migration,
          wallet_allocation_atto,
          wallet_allocation_one,
          staked_to_vault_atto,
          staked_to_vault_one,
          total_allocation_atto,
          total_allocation_one,
        };
      }
    }
    if (netTotal === 0n && notIssuedTotal > 0n) {
      migration = {
        ...migration,
        stage: null,
        issuance_treatment: "not_issued",
        wallet_allocation_atto: "0",
        wallet_allocation_one: "0",
        staked_to_vault_atto: "0",
        staked_to_vault_one: "0",
        total_allocation_atto: "0",
        total_allocation_one: "0",
      };
    }
  }
  const meetsThreshold = account.meets_threshold;
  const disposition = dispositionFor(
    account,
    exchanges,
    migration,
    netTotal,
    notIssuedTotal,
    wallet.destination,
  );

  if (manualDelivery) {
    const exchangeName = exchanges[0]?.display_name ?? "the exchange";
    const manualTotal =
      toBigInt(wallet.manual_delivery_atto) +
      positions.reduce((acc, p) => acc + toBigInt(p.manual_delivery_atto), 0n);
    notes.push(
      `${formatOne(manualTotal)} ONE is sent separately from the 2050 reserve as arranged with ${exchangeName}. None of it is in the airdrop, and the minimum balance and activity rules do not apply.`,
    );
  } else if (!account.meets_threshold) {
    notes.push(
      `This address's total at the cutoff (${formatOne(qualificationTotal)} ONE) is under the ${formatOne(meta.threshold_atto, 0)} ONE minimum, so it is not in the initial airdrop.`,
    );
  }
  if (account.meets_threshold && migration.stage === "deferred" && !leftOutOfInitialAirdrop(account, migration.stage_reason)) {
    notes.push(
      `${migration.stage_reason ? sentenceCase(migration.stage_reason) : "This eligible wallet is outside the current six-month activity window."} Snapshot qualification is unchanged; the allocation is deferred to a later stage.`,
    );
  }
  if (account.account_category === "validator_account") {
    notes.push(
      "Verified validator account: the code field holds validator data, but the account is key-controlled. Wallet tokens and vault shares are delivered to the same address.",
    );
  }
  if (notIssuedTotal > 0n) {
    notes.push(
      `${formatOne(notIssuedTotal)} ONE is not issued under the published policy and is retained in the 2050 premint reserve; see the adjustments for the reason.`,
    );
  }
  if (redistributedTotal > 0n) {
    notes.push(
      `${formatOne(redistributedTotal)} ONE is a terminal WONE source offset already represented in qualified holder rows; it is not a second payout.`,
    );
  }
  const heldTotal =
    toBigInt(wallet.held_atto) + positions.reduce((acc, p) => acc + toBigInt(p.held_atto), 0n);
  if (heldTotal > 0n) {
    notes.push(
      `${formatOne(heldTotal)} ONE is on hold pending a policy decision or an approved destination address.`,
    );
  }
  for (const p of positions) {
    if (p.vault && p.vault.governor_status !== "ready") {
      notes.push(
        `The vault governor for validator ${p.validator.checksum} is on hold until an approved Ethereum governor is recorded.`,
      );
    }
  }

  const [total_claim_atto, total_claim_one] = amountPair(netTotal);
  const [gross_total_claim_atto, gross_total_claim_one] = amountPair(grossTotal);
  const [not_issued_atto, not_issued_one] = amountPair(notIssuedTotal);
  const [redistributed_atto, redistributed_one] = amountPair(redistributedTotal);
  const [qualification_total_atto, qualification_total_one] = amountPair(qualificationTotal);
  return {
    ...base,
    found: true,
    account_type: account.account_category,
    contract_category: category,
    code_bearing: account.code_bearing,
    eligibility: {
      total_claim_atto,
      total_claim_one,
      gross_total_claim_atto,
      gross_total_claim_one,
      not_issued_atto,
      not_issued_one,
      redistributed_atto,
      redistributed_one,
      qualification_total_atto,
      qualification_total_one,
      meets_threshold: meetsThreshold,
      status: migration.issuance_treatment === "not_issued" ||
          (netTotal === 0n && notIssuedTotal > 0n)
        ? "not_issuing"
        : disposition?.code === "handled_by_exchange"
          ? "handled_by_exchange"
        : migration.stage === "next_stage"
          ? "next_stage"
        : migration.stage === "initial"
          ? "prioritized"
          : "deferred",
    },
    components: components(account),
    wallet_airdrop: wallet,
    vault_positions: positions,
    adjustments,
    disposition,
    migration_policy: migration,
    notes,
    last_activity: account.last_activity_time_utc
      ? {
          time_utc: toIso(account.last_activity_time_utc),
          block: account.last_activity_block === null ? null : Number(account.last_activity_block),
          shard: account.last_activity_shard,
          type: account.last_activity_type,
          tx_hash: account.last_activity_tx_hash,
        }
      : null,
  };
}
