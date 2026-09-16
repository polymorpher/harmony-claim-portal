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
  type MetaResponse,
  type VaultPosition,
  type WalletAirdrop,
} from "@hcp/shared";
import { addressForms } from "./address.js";
import type {
  AccountRow,
  DelegationRow,
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
    hold: "Held pending a policy decision",
    ready: "Routed",
    none: "",
  };
  return { code, title: fallbackTitle[ex.destination_status], user_text: code.replace(/_/g, " ") };
}

function kindOf(ex: ExceptionRow): AdjustmentKind {
  if (ex.destination_status === "not_issuing") return "deduction";
  if (ex.destination_status === "hold") return "hold";
  if (ex.exception_type === "validator_wrapper_same_address") return "same_address";
  if (ex.destination_address && ex.destination_address.toLowerCase() === ex.source_address.toLowerCase()) {
    return "same_address";
  }
  return "redirect";
}

function destinationFor(
  gross: bigint,
  notIssued: bigint,
  held: bigint,
  readyRows: ExceptionRow[],
  sameAddress: string,
): Destination {
  const issuable = gross - notIssued - held;
  if (gross === 0n) return { address: null, status: "none" };
  if (issuable > 0n) {
    const redirects = new Set(
      readyRows
        .map((r) => r.destination_address?.toLowerCase() ?? null)
        .filter((a): a is string => a !== null && a !== sameAddress),
    );
    if (redirects.size === 1) return { address: [...redirects][0], status: "ready" };
    return { address: sameAddress, status: "ready" };
  }
  if (held > 0n) return { address: null, status: "hold" };
  return { address: null, status: "not_issuing" };
}

interface Split {
  gross: bigint;
  notIssued: bigint;
  held: bigint;
  ready: ExceptionRow[];
}

function splitExceptions(gross: bigint, rows: ExceptionRow[]): Split {
  let notIssued = 0n;
  let held = 0n;
  const ready: ExceptionRow[] = [];
  for (const ex of rows) {
    const a = toBigInt(ex.amount_atto);
    if (ex.destination_status === "not_issuing") notIssued += a;
    else if (ex.destination_status === "hold") held += a;
    else ready.push(ex);
  }
  return { gross, notIssued, held, ready };
}

function walletBreakdown(account: AccountRow, exceptions: ExceptionRow[]): WalletAirdrop {
  const s = splitExceptions(
    toBigInt(account.wallet_airdrop_atto),
    exceptions.filter((e) => e.component === "wallet_airdrop"),
  );
  const issuable = s.gross - s.notIssued - s.held;
  const [gross_atto, gross_one] = amountPair(s.gross);
  const [not_issued_atto, not_issued_one] = amountPair(s.notIssued);
  const [held_atto, held_one] = amountPair(s.held);
  const [issuable_atto, issuable_one] = amountPair(issuable < 0n ? 0n : issuable);
  return {
    gross_atto,
    gross_one,
    not_issued_atto,
    not_issued_one,
    held_atto,
    held_one,
    issuable_atto,
    issuable_one,
    destination: destinationFor(s.gross, s.notIssued, s.held, s.ready, account.address ?? ""),
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
    const net = s.gross - s.notIssued;
    const destination = destinationFor(s.gross, s.notIssued, s.held, s.ready, account.address ?? "");
    const v = vaultByAddr.get(validator);
    const [staked_atto, staked_one] = amountPair(s.gross);
    const [not_issued_atto, not_issued_one] = amountPair(s.notIssued);
    const [held_atto, held_one] = amountPair(s.held);
    const [expected_shares_atto, expected_shares_one] = amountPair(net < 0n ? 0n : net);
    let vault: VaultPosition["vault"] = null;
    if (v) {
      const [assets_atto, assets_one] = amountPair(v.vault_assets_atto);
      const [priority_staked_atto, priority_staked_one] = amountPair(v.priority_staked_to_vault_atto);
      const [deferred_staked_atto, deferred_staked_one] = amountPair(v.deferred_staked_to_vault_atto);
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
      };
    }
    return {
      validator: addressForms(validator),
      validator_name: v?.validator_name ?? null,
      is_self_delegation: d.is_self_delegation,
      priority: d.priority,
      staked_atto,
      staked_one,
      not_issued_atto,
      not_issued_one,
      held_atto,
      held_one,
      expected_shares_atto,
      expected_shares_one,
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
  const [wallet_airdrop_atto, wallet_airdrop_one] = amountPair(account.wallet_airdrop_atto);
  const [staked_to_vault_atto, staked_to_vault_one] = amountPair(account.staked_to_vault_atto);
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
    wallet_airdrop_atto,
    wallet_airdrop_one,
    staked_to_vault_atto,
    staked_to_vault_one,
  };
}

function toIso(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : v;
}

export function buildClaimResponse(
  addressLower: string,
  account: AccountRow | null,
  delegations: DelegationRow[],
  exceptions: ExceptionRow[],
  vaults: VaultRow[],
  reasonTexts: Record<string, ReasonText>,
  snapshotMeta: SnapshotMeta,
  options: BuildOptions,
): ClaimResponse {
  const meta = buildMeta(snapshotMeta);
  const address = addressForms(addressLower);
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
    notes: [],
    last_activity: null,
    meta,
  };
  if (!account) {
    base.notes.push(
      "No balance, stake or pending amount was recorded for this address at the cutoff.",
    );
    return base;
  }

  const notes: string[] = [];
  const isContract = account.account_category === "contract";
  const hideAmounts = isContract && !options.exposeContractAmounts;
  const category = account.contract_primary_category;

  if (isContract) {
    notes.push(
      `This address is a smart contract${category ? ` (${category})` : ""}. Contract balances are not delivered to the same address automatically; they are handled in a later phase through a class-specific recovery process.`,
    );
  }
  if (hideAmounts) {
    return {
      ...base,
      found: true,
      account_type: account.account_category,
      contract_category: category,
      code_bearing: account.code_bearing,
      notes,
    };
  }

  const total = toBigInt(account.total_claim_atto);
  const meetsThreshold = account.meets_threshold;
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
      evidence: ex.evidence,
    };
  });

  if (!meetsThreshold) {
    notes.push(
      `The total claim (${formatOne(total)} ONE) is below the ${formatOne(meta.threshold_atto, 0)} ONE threshold, so this account is deferred and not part of the prioritized distribution.`,
    );
  }
  if (account.account_category === "validator_account") {
    notes.push(
      "Verified validator account: the code field holds validator data, but the account is key-controlled. Wallet tokens and vault shares are delivered to the same address.",
    );
  }
  const notIssuedTotal =
    toBigInt(wallet.not_issued_atto) +
    positions.reduce((acc, p) => acc + toBigInt(p.not_issued_atto), 0n);
  if (notIssuedTotal > 0n) {
    notes.push(
      `${formatOne(notIssuedTotal)} ONE is not issued under the published non-issuance policy; see the adjustments for the reason.`,
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

  const [total_claim_atto, total_claim_one] = amountPair(total);
  return {
    ...base,
    found: true,
    account_type: account.account_category,
    contract_category: category,
    code_bearing: account.code_bearing,
    eligibility: {
      total_claim_atto,
      total_claim_one,
      meets_threshold: meetsThreshold,
      status: meetsThreshold ? "prioritized" : "deferred",
    },
    components: components(account),
    wallet_airdrop: wallet,
    vault_positions: positions,
    adjustments,
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
