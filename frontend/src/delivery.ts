import type { ClaimResponse } from "@hcp/shared";
import { getAddress, type Address } from "viem";
import type { Catalog } from "./vault/catalog";
import type { ReservePayment } from "./vault/chain";

/** One part of a claim the reserve pays on Ethereum: the wallet part, or the shares in one governor vault. */
export interface DeliveryTarget {
  kind: "wallet" | "vault";
  /** "wallet", or the validator's lower-case address. */
  key: string;
  validatorName: string | null;
  /** Who is paid: the wallet part's destination, or the delegator the vault credits. */
  recipient: Address;
  /** The validator's governor vault; null when the vault list has none for it. */
  vault: Address | null;
  expected: bigint;
}

export type DeliveryState = "sent" | "partial" | "over" | "not_sent";

export interface DeliveryRow extends DeliveryTarget {
  payments: ReservePayment[];
  received: bigint;
  state: DeliveryState;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The parts of the claim the reserve may pay to an address it already knows: an issued allocation
 * with a ready destination. Exchange wallets are paid separately and have no targets.
 */
export function deliveryTargets(claim: ClaimResponse, catalog: Catalog | null): DeliveryTarget[] {
  const policy = claim.migration_policy;
  if (!claim.found || !policy || policy.issuance_treatment !== "issue") return [];
  const targets: DeliveryTarget[] = [];
  const walletExpected = BigInt(policy.wallet_allocation_atto ?? "0");
  const destination = claim.wallet_airdrop?.destination;
  if (walletExpected > 0n && destination?.status === "ready" && destination.address) {
    targets.push({
      kind: "wallet",
      key: "wallet",
      validatorName: null,
      recipient: getAddress(destination.address),
      vault: null,
      expected: walletExpected,
    });
  }
  for (const p of claim.vault_positions) {
    const expected = BigInt(p.expected_shares_atto);
    if (expected <= 0n || p.status !== "ready" || !p.destination.address) continue;
    const vault = catalog?.vaults.find((v) => same(v.validator, p.validator.hex))?.vault ?? null;
    targets.push({
      kind: "vault",
      key: p.validator.hex.toLowerCase(),
      validatorName: p.validator_name,
      recipient: getAddress(p.destination.address),
      vault,
      expected,
    });
  }
  return targets;
}

export function deliveryState(expected: bigint, received: bigint): DeliveryState {
  if (received === 0n) return "not_sent";
  if (received === expected) return "sent";
  return received < expected ? "partial" : "over";
}

/** Matches transfers to the wallet part by recipient, and deposits to a vault position by vault and delegator. */
export function matchPayments(targets: DeliveryTarget[], transfers: ReservePayment[], deposits: ReservePayment[]): DeliveryRow[] {
  return targets.map((t) => {
    const payments =
      t.kind === "wallet"
        ? transfers.filter((p) => same(p.recipient, t.recipient))
        : t.vault
          ? deposits.filter((p) => same(p.address, t.vault!) && same(p.recipient, t.recipient))
          : [];
    const received = payments.reduce((sum, p) => sum + p.amount, 0n);
    return { ...t, payments, received, state: deliveryState(t.expected, received) };
  });
}

export function uniqueAddresses(addresses: (Address | null)[]): Address[] {
  const seen = new Map<string, Address>();
  for (const a of addresses) if (a) seen.set(a.toLowerCase(), a);
  return [...seen.values()];
}
