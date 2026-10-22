import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { zeroAddress, type Address, type Hex } from "viem";
import { formatDate, formatUtc, one, shortAddress } from "../format";
import { onNavigate } from "../router";
import { summarize, type ActivityRow, type Totals, type VaultSummary } from "./activity";
import { confirmedAsOf, type Catalog, type CatalogVault } from "./catalog";
import { explorer, publicClient, readBlockTimes, readVaultDetail, readVaultLogs } from "./chain";
import { awaitingFunding, cutoffParts, displayUnit, formatRounded } from "./breakdown";
import { DelegatorBreakdown } from "./DelegatorBreakdown";
import { AgreementBadge } from "./AgreementBadge";
import { agreementStatus, AGREEMENTS_SITE, type AgreementInfo } from "./agreements";
import { CompensationNotice } from "./CompensationNotice";
import { effectiveFee, percentFromBps, percentFromRate } from "./format";
import type { VaultSigner } from "./useVaultSigner";
import { VaultActions } from "./VaultActions";

const ACTIVITY_PAGE = 20;

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

function AddressLink({ address, chainId, you, reserve }: { address: Address; chainId: number; you?: string | null; reserve?: Address }) {
  return (
    <>
      <a href={`${explorer(chainId)}/address/${address}`} target="_blank" rel="noreferrer">
        <code>{shortAddress(address)}</code>
      </a>
      {same(address, you) && <span className="tag">you</span>}
      {same(address, reserve) && <span className="tag">reserve</span>}
    </>
  );
}

function TxLink({ hash, chainId, children }: { hash: Hex; chainId: number; children: ReactNode }) {
  return (
    <a href={`${explorer(chainId)}/tx/${hash}`} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function when(times: Map<bigint, number> | undefined, block: bigint): string {
  const t = times?.get(block);
  return t ? formatUtc(new Date(t * 1000).toISOString()) : `block ${block.toLocaleString()}`;
}

function whenDate(times: Map<bigint, number> | undefined, block: bigint): string | null {
  const t = times?.get(block);
  return t ? formatDate(new Date(t * 1000).toISOString()) : null;
}

function FundedCards({
  summary,
  size,
  pending,
  display: pageDisplay,
  fundedOn,
}: {
  summary: VaultSummary;
  size: bigint;
  pending: Totals;
  display: { unit: bigint; decimals: number };
  fundedOn: string | null;
}) {
  const funded = summary.reserveCredits;
  const delta = size - funded.atto;
  const abs = delta < 0n ? -delta : delta;
  // Hundredths when the change is small, so "down 0.50" is visible in the size as well.
  const display = abs > 0n && displayUnit(abs).decimals > 0 ? displayUnit(0n) : pageDisplay;
  const fmt = (atto: bigint) => formatRounded(atto, display);
  const runs = summary.fundingRuns > 1 ? `in ${summary.fundingRuns} runs since ${fundedOn ?? "…"}` : `on ${fundedOn ?? "…"}`;
  return (
    <>
      <div>
        <span className="label">Vault size</span>
        <span className="big">{fmt(size)} ONE</span>
        <span className="hint">
          Funded {runs} with {fmt(funded.atto)} ONE;{" "}
          {delta === 0n ? "unchanged since." : `${delta < 0n ? "down" : "up"} ${fmt(abs)} since.`}
          {pending.count > 0 && ` ${pending.count.toLocaleString()} more approved delegators wait for the next funding.`}
        </span>
      </div>
      <div>
        <span className="label">Delegators now</span>
        <span className="big">{summary.delegatorsNow.toLocaleString()}</span>
        <span className="hint">{funded.count.toLocaleString()} credited by the reserve</span>
      </div>
    </>
  );
}

function ActivityText({ row, chainId, you, reserve }: { row: ActivityRow; chainId: number; you: string | null; reserve: Address }) {
  const link = (a: Address) => <AddressLink address={a} chainId={chainId} you={you} reserve={reserve} />;
  if (row.kind === "withdraw") {
    return (
      <>
        Withdrawal by {link(row.caller)}
        {row.counterparty && !same(row.counterparty, row.caller) && <> to {link(row.counterparty)}</>}
      </>
    );
  }
  if (row.fromReserve) {
    return row.count > 1 || !row.counterparty ? <>Airdrop from the reserve to {row.count.toLocaleString()} delegators</> : <>Airdrop from the reserve to {link(row.counterparty)}</>;
  }
  return (
    <>
      Deposit by {link(row.caller)}
      {row.count > 1 ? <> for {row.count} delegators</> : row.counterparty && !same(row.counterparty, row.caller) && <> for {link(row.counterparty)}</>}
    </>
  );
}

export function VaultDetail({
  catalog,
  entry,
  name,
  signer,
  agreements,
}: {
  catalog: Catalog;
  entry: CatalogVault;
  name: string;
  signer: VaultSigner;
  agreements: AgreementInfo;
}) {
  const chainId = catalog.chain_id;
  const client = publicClient(chainId);
  const queryClient = useQueryClient();
  const account = signer.address ?? undefined;
  const you = signer.address;

  const detail = useQuery({
    queryKey: ["vault-detail", chainId, entry.vault, account ?? null],
    queryFn: () => readVaultDetail(client, catalog, entry.vault, account),
    refetchInterval: 60_000,
  });
  const deployed = detail.data?.deployed === true;
  const logs = useQuery({
    queryKey: ["vault-logs", chainId, entry.vault],
    queryFn: () => readVaultLogs(client, entry.vault, catalog.start_block),
    enabled: deployed,
    refetchInterval: 60_000,
  });
  const summary = useMemo(() => (logs.data ? summarize(logs.data.logs, catalog.reserve) : null), [logs.data, catalog.reserve]);
  const [shown, setShown] = useState(ACTIVITY_PAGE);
  const rows = useMemo(() => summary?.activity.slice(0, shown) ?? [], [summary, shown]);

  const blocks = useMemo(() => {
    const all = [
      ...rows.map((r) => r.blockNumber),
      ...(summary?.governorChanges ?? []).map((c) => c.blockNumber),
      ...(summary?.feeChanges ?? []).map((c) => c.blockNumber),
      ...(summary?.funded ? [summary.funded.blockNumber] : []),
    ];
    return [...new Set(all.map(String))].sort().map(BigInt);
  }, [rows, summary]);
  const times = useQuery({
    queryKey: ["block-times", chainId, blocks.join(",")],
    queryFn: () => readBlockTimes(client, blocks),
    enabled: blocks.length > 0,
    staleTime: Infinity,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["vault-detail", chainId, entry.vault] });
    void queryClient.invalidateQueries({ queryKey: ["vault-logs", chainId, entry.vault] });
    void queryClient.invalidateQueries({ queryKey: ["vault-states", chainId] });
  };

  const d = detail.data;
  const governor = d?.governor ?? null;
  const initialGovernor = summary?.governorChanges.find((c) => c.previous === zeroAddress)?.next ?? entry.governor;
  const fee = d?.feeBps !== null && d?.feeBps !== undefined ? effectiveFee(d.feeBps, entry.commission_rate) : null;
  const commission = percentFromRate(entry.commission_rate);
  const cut = entry.cutoff;
  const isGovernor = same(governor, you);
  const inflow = summary ? summary.reserveCredits.atto + summary.otherDeposits.atto : 0n;
  const stake = BigInt(cut.stake_atto);
  const display = displayUnit(inflow > stake ? inflow : stake);
  const status = !d ? "loading" : !deployed ? "not_deployed" : !summary ? "loading" : summary.funded ? "funded" : "waiting";
  const pending = awaitingFunding(cutoffParts(cut, summary?.reserveCredits ?? { count: 0, atto: 0n }).parts);
  const asOf = confirmedAsOf(catalog);
  const agreement = agreementStatus(entry, agreements.live);

  return (
    <>
      <section className="card">
        <p className="small">
          <a href="/vault" onClick={onNavigate("/vault")}>
            ← All governor vaults
          </a>
        </p>
        <h2 className="vault-name">
          {name} <AgreementBadge status={agreement} asOf={agreements.asOf} />
        </h2>
        {agreement.state !== "signed" && <CompensationNotice />}
        <dl className="addr">
          <dt>Governor vault</dt>
          <dd>
            <a href={`${explorer(chainId)}/address/${entry.vault}`} target="_blank" rel="noreferrer">
              <code>{entry.vault}</code>
            </a>
          </dd>
          {name !== entry.name && entry.name && (
            <>
              <dt>Name at the cutoff</dt>
              <dd>{entry.name}</dd>
            </>
          )}
          <dt>Harmony validator</dt>
          <dd>
            <code>{entry.validator_one1}</code> · <code>{entry.validator}</code>
          </dd>
          <dt>Governor agreement</dt>
          <dd>
            {agreement.state === "none" ? (
              <>
                None listed on{" "}
                <a href={AGREEMENTS_SITE} target="_blank" rel="noreferrer">
                  governors.country
                </a>{" "}
                for this validator.
              </>
            ) : (
              <>
                {agreement.state === "signed" ? "Signed by the validator" : "Not signed yet"}
                {!agreement.live && agreements.asOf && ` (as of ${agreements.asOf})`}.{" "}
                <a href={agreement.url!} target="_blank" rel="noreferrer">
                  {agreement.state === "signed" ? "View the agreement" : "Open the agreement to sign"}
                </a>{" "}
                ·{" "}
                <a href={AGREEMENTS_SITE} target="_blank" rel="noreferrer">
                  governors.country
                </a>
              </>
            )}
          </dd>
        </dl>
        {detail.error && <p className="error">Could not read this vault from Ethereum. Try again in a moment.</p>}
        <div className="summary">
          {status === "funded" && summary && d?.size != null ? (
            <FundedCards summary={summary} size={d.size} pending={pending} display={display} fundedOn={summary.funded ? whenDate(times.data, summary.funded.blockNumber) : null} />
          ) : (
            <div className="wide">
              <span className="label">Vault</span>
              <span className="big">{status === "not_deployed" ? "No vault deployed" : status === "waiting" ? "Waiting for funding" : "…"}</span>
              {status === "not_deployed" && (
                <span className="hint">A vault was deployed only for a validator with at least 10,000 ONE.</span>
              )}
              {status === "waiting" && pending.count > 0 && (
                <span className="hint">
                  When the reserve funds it, the vault will credit {pending.count.toLocaleString()} approved delegators with{" "}
                  {formatRounded(pending.atto, display)} ONE.
                </span>
              )}
            </div>
          )}
          <div>
            <span className="label">Fee</span>
            <span className="big">{fee ? `${fee.percent}%` : deployed ? "…" : `${commission}%`}</span>
          </div>
          <div>
            <span className="label">Delegators at the cutoff</span>
            <span className="big">{cut.delegators.toLocaleString()}</span>
          </div>
        </div>
      </section>

      {deployed && (
        <section className="card">
          <h2>Governor and fee</h2>
          <dl className="addr">
            <dt>Governor</dt>
            <dd>{governor ? <AddressLink address={governor} chainId={chainId} you={you} /> : "…"}</dd>
            {governor && !same(governor, initialGovernor) && (
              <>
                <dt>Initial governor</dt>
                <dd>
                  <AddressLink address={initialGovernor} chainId={chainId} you={you} />
                </dd>
              </>
            )}
            <dt>Fee</dt>
            <dd>
              {fee ? (
                fee.fromHarmony ? (
                  <>
                    {fee.percent}%, the validator's commission on Harmony at the cutoff. The governor has not set a fee on
                    the vault.
                  </>
                ) : (
                  <>{fee.percent}%, set by the governor on the vault.</>
                )
              ) : (
                "…"
              )}
            </dd>
            {fee && fee.percent !== commission && (
              <>
                <dt>Initial fee</dt>
                <dd>{commission}%, the Harmony commission at the cutoff</dd>
              </>
            )}
          </dl>
          {summary && summary.governorChanges.length > 1 && (
            <div className="block">
              <h3>Governor changes</h3>
              <table>
                <tbody>
                  {summary.governorChanges.map((c) => (
                    <tr key={`${c.transactionHash}-${c.next}`}>
                      <td>
                        <TxLink hash={c.transactionHash} chainId={chainId}>
                          {when(times.data, c.blockNumber)}
                        </TxLink>
                      </td>
                      <td>
                        {c.previous === zeroAddress ? (
                          <>Set at deployment to <AddressLink address={c.next} chainId={chainId} you={you} /></>
                        ) : (
                          <>
                            <AddressLink address={c.previous} chainId={chainId} you={you} /> →{" "}
                            <AddressLink address={c.next} chainId={chainId} you={you} />
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {summary && summary.feeChanges.length > 0 && (
            <div className="block">
              <h3>Fee changes</h3>
              <table>
                <tbody>
                  {summary.feeChanges.map((c) => (
                    <tr key={`${c.transactionHash}-${c.next}`}>
                      <td>
                        <TxLink hash={c.transactionHash} chainId={chainId}>
                          {when(times.data, c.blockNumber)}
                        </TxLink>
                      </td>
                      <td>
                        {c.previous === 0 ? `Harmony commission (${commission}%)` : `${percentFromBps(c.previous)}%`} →{" "}
                        {c.next === 0 ? `Harmony commission (${commission}%)` : `${percentFromBps(c.next)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="card">
        <h2>Delegators</h2>
        {d ? (
          <DelegatorBreakdown cutoff={entry.cutoff} summary={summary} deployed={deployed} display={display} asOf={asOf ? formatDate(asOf) : null} />
        ) : (
          <p className="muted">Reading this vault from Ethereum…</p>
        )}
        <p className="small">
          Inactive delegators can still <a href="/confirm">confirm their wallet</a>. Once approved they move to "Approved,
          not credited to the vault yet", and into "Airdropped into the vault" when the reserve next funds it. Each group is
          the sum of the rows under it. Cutoff figures are Harmony shard 0 block{" "}
          {catalog.harmony_cutoff.block.toLocaleString()} ({formatUtc(catalog.harmony_cutoff.time_utc)}); amounts are
          rounded so the columns add up.
        </p>
      </section>

      {deployed && signer.address && d && (
        <VaultActions
          catalog={catalog}
          entry={entry}
          name={name}
          detail={d}
          signer={signer}
          isGovernor={isGovernor}
          commission={commission}
          agreement={agreement}
          onDone={refresh}
        />
      )}

      {deployed && (
        <section className="card">
          <h2>Recent activity</h2>
          {logs.isLoading && <p className="muted">Reading the vault's events…</p>}
          {logs.error && <p className="error">Could not read the vault's events. Try again in a moment.</p>}
          {summary && summary.activity.length === 0 && <p className="muted">No deposits or withdrawals yet.</p>}
          {rows.length > 0 && (
            <table className="activity">
              <thead>
                <tr>
                  <th>Time (UTC)</th>
                  <th>Activity</th>
                  <th className="num">ONE</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>
                      <TxLink hash={r.transactionHash} chainId={chainId}>
                        {when(times.data, r.blockNumber)}
                      </TxLink>
                    </td>
                    <td>
                      <ActivityText row={r} chainId={chainId} you={you} reserve={catalog.reserve} />
                    </td>
                    <td className="num">
                      {r.kind === "withdraw" ? "−" : "+"}
                      {one(r.amount.toString(), 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {summary && summary.activity.length > shown && (
            <p>
              <button type="button" className="ghost" onClick={() => setShown(shown + ACTIVITY_PAGE)}>
                Show more
              </button>
            </p>
          )}
        </section>
      )}
    </>
  );
}
