export const CONFIRM_PURPOSE =
  "Confirm that this wallet is still active.";

export interface ConfirmationMessageInput {
  domain: string;
  address: string;
  nonce: string;
  /** Canonical UTC timestamp, `YYYY-MM-DDTHH:mm:ss.sssZ`. */
  issuedAt: string;
  cutoffTime: string;
  policyVersion: string;
  dataVersion: string;
}

/**
 * Exact bytes the wallet signs. Nothing about this string is stored as a
 * challenge: the server rebuilds it from the candidate row, the issued time,
 * and the nonce.
 */
export function confirmationMessage(input: ConfirmationMessageInput): string {
  return [
    `${input.domain} activity confirmation for a Harmony migration address`,
    "",
    `Domain: ${input.domain}`,
    `Address: ${input.address}`,
    `Purpose: ${CONFIRM_PURPOSE}`,
    "This signature does not transfer funds or authorize a transaction.",
    `Issued: ${input.issuedAt}`,
    `Nonce: ${input.nonce}`,
    `Cutoff: ${input.cutoffTime}`,
    `Policy version: ${input.policyVersion}`,
    `Data version: ${input.dataVersion}`,
  ].join("\n");
}
