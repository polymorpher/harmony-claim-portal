/** Stage reasons that may request next-batch confirmation. Matches the migration toolkit. */
export const CONFIRMABLE_STAGE_REASONS = [
  "wallet activity predates initial window",
  "no indexed wallet activity",
] as const;

export type ConfirmableStageReason = (typeof CONFIRMABLE_STAGE_REASONS)[number];

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
