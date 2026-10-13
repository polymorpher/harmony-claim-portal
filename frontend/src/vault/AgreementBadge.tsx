import type { AgreementStatus } from "./agreements";

const TEXT = {
  signed: "Agreement signed",
  unsigned: "Agreement not signed",
  none: "No agreement listed",
} as const;

/** The governor agreement state; `asOf` labels the catalog snapshot when the live read is unavailable. */
export function AgreementBadge({ status, asOf }: { status: AgreementStatus; asOf: string | null }) {
  const title = status.live ? "Live from the agreement registry on Base" : `As of ${asOf ?? "the vault list's build"}`;
  if (status.state === "none" || !status.url) {
    return (
      <span className="badge none" title="governors.country lists no governor agreement for this validator">
        {TEXT.none}
      </span>
    );
  }
  return (
    <a className={`badge ${status.state}`} href={status.url} target="_blank" rel="noreferrer" title={title}>
      {TEXT[status.state]}
    </a>
  );
}
