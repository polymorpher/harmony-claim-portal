/** Stage reasons that may request next-batch confirmation. Matches the migration toolkit. */
export const CONFIRMABLE_STAGE_REASONS = [
  "wallet activity predates initial window",
  "no indexed wallet activity",
] as const;

export type ConfirmableStageReason = (typeof CONFIRMABLE_STAGE_REASONS)[number];

/**
 * How a confirmation signature was produced.
 * - `personal_sign`: EIP-191 over the confirmation message (browser and phone
 *   wallets, the 2025 Harmony Ledger app, the Ethereum Ledger app).
 * - `harmony_ledger_tx`: the pre-2025 Harmony Ledger app signed
 *   `harmonyLedgerTx(address, message)`; see harmony-ledger-tx.ts.
 */
export const SIGNATURE_SCHEMES = ["personal_sign", "harmony_ledger_tx"] as const;

export type SignatureScheme = (typeof SIGNATURE_SCHEMES)[number];

export function isSignatureScheme(value: unknown): value is SignatureScheme {
  return typeof value === "string" && (SIGNATURE_SCHEMES as readonly string[]).includes(value);
}

const CONFIRMABLE_ACCOUNTS = new Set(["ordinary_eoa", "validator_account"]);

/**
 * Whether the lookup page should offer /confirm. The confirmation service's
 * candidate table is the authority; this only hides the link for accounts the
 * policy already excludes.
 */
export function claimCanRequestConfirmation(claim: {
  account_type: string | null;
  exchange_treatments: readonly unknown[];
  migration_policy: {
    stage: string | null;
    stage_reason: string | null;
    issuance_treatment: string;
  } | null;
}): boolean {
  if (claim.exchange_treatments.length > 0) return false;
  if (!claim.account_type || !CONFIRMABLE_ACCOUNTS.has(claim.account_type)) return false;
  const policy = claim.migration_policy;
  if (!policy || policy.issuance_treatment !== "issue" || policy.stage !== "deferred") return false;
  return (CONFIRMABLE_STAGE_REASONS as readonly string[]).includes(policy.stage_reason ?? "");
}
