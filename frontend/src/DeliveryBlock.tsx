import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ClaimResponse } from "@hcp/shared";
import type { Hex } from "viem";
import { deliveryTargets, matchPayments, uniqueAddresses, type DeliveryRow, type DeliveryState } from "./delivery";
import { formatDate, one, shortAddress } from "./format";
import { loadCatalog } from "./vault/catalog";
import { explorer, publicClient, readBlockTimes, readReservePayments } from "./vault/chain";

const STATE_TEXT: Record<"wallet" | "vault", Record<DeliveryState, string>> = {
  wallet: { sent: "Sent", partial: "Partly sent", over: "More than this allocation", not_sent: "Not sent yet" },
  vault: { sent: "Credited", partial: "Partly credited", over: "More than this allocation", not_sent: "Not credited yet" },
};

function TxLink({ hash, chainId, label }: { hash: Hex; chainId: number; label: string }) {
  return (
    <a href={`${explorer(chainId)}/tx/${hash}`} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

function Part({ row, self }: { row: DeliveryRow; self: string }) {
  if (row.kind === "wallet") {
    return (
      <>
        <div>Wallet (ERC-20 ONE)</div>
        {row.recipient.toLowerCase() !== self && (
          <div className="small">
            to <code title={row.recipient}>{shortAddress(row.recipient)}</code>
          </div>
        )}
      </>
    );
  }
  return (
    <>
      <div>{row.validatorName ?? shortAddress(row.key)}</div>
      <div className="small">
        {row.vault ? (
          <>
            governor vault <a href={`/vault/${row.vault}`}><code>{shortAddress(row.vault)}</code></a>
          </>
        ) : (
          "no governor vault in the vault list"
        )}
      </div>
    </>
  );
}

function Status({ row, chainId, times }: { row: DeliveryRow; chainId: number; times: Map<bigint, number> | undefined }) {
  if (row.kind === "vault" && !row.vault) return <>Not checked</>;
  return (
    <>
      <span className={row.state === "sent" ? "ok-text" : undefined}>{STATE_TEXT[row.kind][row.state]}</span>
      {row.payments.map((p) => {
        const t = times?.get(p.blockNumber);
        const date = t ? formatDate(new Date(t * 1000).toISOString()) : `block ${p.blockNumber.toLocaleString()}`;
        return (
          <div className="small payment" key={`${p.transactionHash}:${p.address}:${p.amount}`}>
            {row.payments.length > 1 ? `${one(p.amount.toString())} ONE, ` : ""}
            {date} · <TxLink hash={p.transactionHash} chainId={chainId} label={`tx ${shortAddress(p.transactionHash)}`} />
          </div>
        );
      })}
    </>
  );
}

/** What the 2050 reserve has paid for this claim on Ethereum, read in the browser. */
export function Delivery({ claim }: { claim: ClaimResponse }) {
  const catalog = useQuery({ queryKey: ["vault-catalog"], queryFn: () => loadCatalog(), staleTime: Infinity, retry: 1 });
  const targets = useMemo(() => deliveryTargets(claim, catalog.data ?? null), [claim, catalog.data]);
  const chainId = catalog.data?.chain_id ?? 1;
  const recipients = uniqueAddresses(targets.map((t) => t.recipient));
  const vaults = uniqueAddresses(targets.map((t) => t.vault));
  const payments = useQuery({
    queryKey: ["reserve-payments", chainId, recipients.join(","), vaults.join(",")],
    queryFn: () => readReservePayments(publicClient(chainId), catalog.data!, recipients, vaults),
    enabled: Boolean(catalog.data) && targets.length > 0,
    staleTime: 60_000,
    retry: 1,
  });
  const rows = useMemo(
    () => (payments.data ? matchPayments(targets, payments.data.transfers, payments.data.deposits) : null),
    [targets, payments.data],
  );
  const blocks = [...new Set((rows ?? []).flatMap((r) => r.payments.map((p) => p.blockNumber)))].sort((a, b) => (a < b ? -1 : 1));
  const times = useQuery({
    queryKey: ["block-times", chainId, blocks.join(",")],
    queryFn: () => readBlockTimes(publicClient(chainId), blocks),
    enabled: blocks.length > 0,
    staleTime: Infinity,
  });

  if (targets.length === 0) return null;

  return (
    <div className="block">
      <h3>Delivery on Ethereum</h3>
      {catalog.error ? (
        <p className="error">Couldn't check delivery: the vault list could not be loaded. This does not mean nothing was sent.</p>
      ) : payments.error ? (
        <p className="error">Couldn't read Ethereum right now. This does not mean nothing was sent; try again later.</p>
      ) : !rows ? (
        <p className="muted">Checking Ethereum…</p>
      ) : (
        <>
          <table className="delivery">
            <thead>
              <tr>
                <th>Part</th>
                <th className="num">Allocation</th>
                <th className="num">Received</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>
                    <Part row={row} self={claim.address.hex} />
                  </td>
                  <td className="num">{one(row.expected.toString())}</td>
                  <td className="num">{row.received > 0n ? one(row.received.toString()) : "-"}</td>
                  <td>
                    <Status row={row} chainId={chainId} times={times.data} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small">
            Payments from the 2050 reserve, read from Ethereum in your browser up to block{" "}
            {payments.data!.toBlock.toLocaleString()}. Vault rows count the reserve's deposits; withdrawals since then are on
            the vault's page.
          </p>
        </>
      )}
    </div>
  );
}
