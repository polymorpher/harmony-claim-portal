import type { VaultSummary } from "./activity";
import { cutoffParts, displayUnit, formatFixed, roundedGroups, roundedHoldings, type Category, type Group, type Part } from "./breakdown";
import type { CutoffDelegations } from "./catalog";

interface Describe {
  label: string;
  note?: string;
  className: string;
}

const GROUPS: Record<Group, string> = {
  airdropped: "Airdropped into the vault",
  funding: "Approved, not credited to the vault yet",
  not_airdropped: "Not airdropped",
  separate: "Handled separately",
};

const ACTIVE = "Active on Harmony in the six months before the cutoff, with at least 1,000 ONE.";

/** Row text; `asOf` is when the portal confirmations in the catalog were exported. */
function describe(p: Part, asOf: string | null): Describe {
  if (p.credited) {
    switch (p.category) {
      case "initial":
        return { label: "Active delegators", note: ACTIVE, className: "cat-airdrop" };
      case "confirmed":
        return { label: "Confirmed on the portal", note: "Inactive at the cutoff, then confirmed their wallet and were approved.", className: "cat-confirmed" };
      case "inactive":
        return {
          label: "Confirmed on the portal later",
          note: `Inactive at the cutoff, then confirmed and approved${asOf ? ` after ${asOf}` : ""}.`,
          className: "cat-confirmed",
        };
      case "next_stage":
        return { label: "Later-stage contracts", className: "cat-confirmed" };
      default:
        return { label: "After manual review", className: "cat-confirmed" };
    }
  }
  switch (p.category) {
    case "initial":
      return { label: "Active delegators", note: `${ACTIVE} Credited when the reserve funds this vault.`, className: "cat-pending" };
    case "confirmed":
      return {
        label: "Confirmed on the portal",
        note: `Inactive at the cutoff, then confirmed their wallet and were approved${asOf ? ` (as of ${asOf})` : ""}. Credited with the vault's next funding.`,
        className: "cat-pending-confirmed",
      };
    case "inactive":
      return {
        label: "Inactive, not confirmed",
        note: `No Harmony activity in the six months before the cutoff, and no approved confirmation${asOf ? ` as of ${asOf}` : ""}. They can still confirm on the portal.`,
        className: "cat-waiting",
      };
    case "below_threshold":
      return { label: "Under 1,000 ONE", note: "Below the 1,000 ONE threshold for the initial distribution.", className: "cat-below" };
    case "next_stage":
      return { label: "Contracts for a later stage", note: "1wallets, multisigs and other contract wallets.", className: "cat-later" };
    case "manual_review":
      return { label: "Held for manual review", className: "cat-review" };
    case "exchange":
      return {
        label: "Paid to the exchange directly",
        note: "Stake held through an exchange is delivered to the exchange, not through this vault.",
        className: "cat-exchange",
      };
    case "not_issued":
      return { label: "Not issued", note: "Reviewed and not issued; kept in the reserve.", className: "cat-not-issued" };
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function StakeBar({ parts, total, asOf }: { parts: Part[]; total: bigint; asOf: string | null }) {
  if (total === 0n) return null;
  return (
    <div className="stake-bar" aria-hidden="true">
      {parts.map((p) => (
        <span
          key={`${p.credited}-${p.category}`}
          className={describe(p, asOf).className}
          style={{ flexGrow: Number((p.atto * 1_000_000n) / total) }}
          title={describe(p, asOf).label}
        />
      ))}
    </div>
  );
}

function CutoffTable({ cutoff, summary, display, asOf }: { cutoff: CutoffDelegations; summary: VaultSummary | null; display: Display; asOf: string | null }) {
  const credits = summary?.reserveCredits ?? { count: 0, atto: 0n };
  const { parts, unexplained } = cutoffParts(cutoff, credits);
  const { groups, total } = roundedGroups(parts, display.unit);
  const fmt = (v: bigint) => formatFixed(v, display.decimals);
  return (
    <>
      <StakeBar parts={parts} total={BigInt(cutoff.stake_atto)} asOf={asOf} />
      <table className="breakdown">
        <thead>
          <tr>
            <th />
            <th />
            <th className="num">Delegators</th>
            <th className="num">ONE</th>
          </tr>
        </thead>
        {groups.map((g, i) => (
          <tbody key={g.group} className="group">
            <tr className="group">
              <td className="op">{i === 0 ? "" : "+"}</td>
              <td>{GROUPS[g.group]}</td>
              <td className="num">{g.count.toLocaleString()}</td>
              <td className="num">{fmt(g.value)}</td>
            </tr>
            {g.parts.map(({ part, value }) => {
              const d = describe(part, asOf);
              return (
                <tr key={`${part.credited}-${part.category}`} className="member">
                  <td />
                  <td>
                    <span className={`swatch ${d.className}`} />
                    {d.label}
                    {d.note && <div className="small">{d.note}</div>}
                  </td>
                  <td className="num">{part.count.toLocaleString()}</td>
                  <td className="num">{fmt(value)}</td>
                </tr>
              );
            })}
          </tbody>
        ))}
        <tbody>
          <tr className="total">
            <td className="op">=</td>
            <td>Staked with this validator at the Harmony cutoff</td>
            <td className="num">{cutoff.delegators.toLocaleString()}</td>
            <td className="num">{fmt(total)}</td>
          </tr>
        </tbody>
      </table>
      {(unexplained.count > 0 || unexplained.atto > 0n) && (
        <p className="small">
          The reserve also credited {plural(unexplained.count, "delegator", "delegators")} beyond the stages above; they are
          not in this sum.
        </p>
      )}
    </>
  );
}

function HoldingsTable({ summary, display: pageDisplay }: { summary: VaultSummary; display: Display }) {
  // Hundredths when a deposit or withdrawal total is small, so 0.5 ONE does not show as 1.
  const display = [summary.otherDeposits.atto, summary.withdrawals.atto].some((a) => a > 0n && displayUnit(a).decimals > 0)
    ? displayUnit(0n)
    : pageDisplay;
  const { values, total } = roundedHoldings(summary.reserveCredits.atto, summary.otherDeposits.atto, summary.withdrawals.atto, display.unit);
  const fmt = (v: bigint) => formatFixed(v, display.decimals);
  const rows = [
    { op: "", className: "cat-airdrop", label: `Airdropped into the vault, to ${plural(summary.reserveCredits.count, "delegator", "delegators")}` },
    { op: "+", className: "cat-deposit", label: `Deposited by delegators (${plural(summary.otherDeposits.count, "deposit", "deposits")})` },
    { op: "−", className: "cat-withdraw", label: `Withdrawn (${plural(summary.withdrawals.count, "withdrawal", "withdrawals")})` },
  ];
  return (
    <table className="breakdown">
      <thead>
        <tr>
          <th />
          <th />
          <th className="num">ONE</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.className}>
            <td className="op">{r.op}</td>
            <td>
              <span className={`swatch ${r.className}`} />
              {r.label}
            </td>
            <td className="num">{fmt(values[i])}</td>
          </tr>
        ))}
        <tr className="total">
          <td className="op">=</td>
          <td>In the vault now, held by {plural(summary.delegatorsNow, "delegator", "delegators")}</td>
          <td className="num">{fmt(total)}</td>
        </tr>
      </tbody>
    </table>
  );
}

interface Display {
  unit: bigint;
  decimals: number;
}

/**
 * `summary` is null while the vault's events load, and for a vault that is not
 * deployed (nothing credited yet).
 */
export function DelegatorBreakdown({
  cutoff,
  summary,
  deployed,
  display,
  asOf,
}: {
  cutoff: CutoffDelegations;
  summary: VaultSummary | null;
  deployed: boolean;
  display: Display;
  asOf: string | null;
}) {
  return (
    <>
      <div className="block">
        <h3>Where the stake at the Harmony cutoff is now</h3>
        {deployed && !summary ? (
          <p className="muted">Reading the vault's events…</p>
        ) : (
          <CutoffTable cutoff={cutoff} summary={summary} display={display} asOf={asOf} />
        )}
      </div>
      {summary && (
        <div className="block">
          <h3>What the vault holds now</h3>
          {summary.reserveCredits.count + summary.otherDeposits.count + summary.withdrawals.count === 0 ? (
            <p className="muted">Nothing yet: the vault is waiting for funding.</p>
          ) : (
            <HoldingsTable summary={summary} display={display} />
          )}
        </div>
      )}
    </>
  );
}
