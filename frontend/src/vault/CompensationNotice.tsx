/** Shown above the vault search, and on a vault whose governor agreement is not signed. */
export const COMPENSATION_NOTICE =
  "Only vaults whose governors have signed the governor agreement receive quarterly compensation under the migration plan. Delegators who staked with a validator that has not signed the governor agreement will not receive any compensation.";

export function CompensationNotice() {
  return <div className="banner warn">{COMPENSATION_NOTICE}</div>;
}
