import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAccount, useConnect, useDisconnect, useSignMessage } from "wagmi";
import { ApiRequestError, fetchClaim, fetchConfirmation, fetchMeta, createConfirmationChallenge, submitConfirmation } from "./api";
import { formatDate, formatUtc, one, shortAddress } from "./format";

function explain(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 429) return `Too many requests. Try again in ${err.retryAfterSeconds ?? 60} seconds.`;
    return err.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong while contacting the confirmation service.";
}

export function ConfirmPage() {
  const { address: connected, isConnected } = useAccount();
  const { connectors, connect, isPending: connecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync, isPending: signing } = useSignMessage();
  const [signedMessage, setSignedMessage] = useState<string | null>(null);

  const injectedConnectors = useMemo(
    () => connectors.filter((c) => c.type === "injected" || c.id === "injected"),
    [connectors],
  );
  const wcConnector = connectors.find((c) => c.type === "walletConnect");

  const meta = useQuery({ queryKey: ["meta"], queryFn: fetchMeta, staleTime: 60_000 });
  const cutoffDate = meta.data?.cutoff.requested_time_utc ? formatDate(meta.data.cutoff.requested_time_utc) : null;

  const status = useQuery({
    queryKey: ["confirmation", connected?.toLowerCase()],
    queryFn: () => fetchConfirmation(connected!),
    enabled: Boolean(connected),
    retry: false,
  });
  const claim = useQuery({
    queryKey: ["claim", connected?.toLowerCase()],
    queryFn: () => fetchClaim(connected!),
    enabled: Boolean(connected) && status.data?.eligible === true,
    retry: false,
  });

  useEffect(() => {
    setSignedMessage(null);
  }, [connected]);

  const confirm = useMutation({
    mutationFn: async () => {
      if (!connected) throw new Error("Connect the wallet that holds this address.");
      const challenge = await createConfirmationChallenge(connected);
      if (challenge.address.hex !== connected.toLowerCase()) {
        throw new Error("The connected wallet changed. Try again.");
      }
      const latest = await fetchConfirmation(connected);
      if (
        latest.data_version !== challenge.data_version ||
        latest.policy_version !== challenge.policy_version
      ) {
        throw new Error("The migration data was updated. Sign again.");
      }
      setSignedMessage(challenge.message);
      const signature = await signMessageAsync({ message: challenge.message });
      return submitConfirmation(
        connected,
        challenge.nonce,
        challenge.issued_at,
        signature,
        challenge.data_version,
        challenge.policy_version,
      );
    },
    onSuccess: async () => {
      await status.refetch();
    },
  });

  const recorded = status.data?.confirmation;
  const activity = claim.data?.last_activity;

  return (
    <div className="page">
      <nav className="nav" aria-label="Pages">
        <a href="/">Claim lookup</a>
        <a href="/confirm" aria-current="page">Confirm activity</a>
      </nav>
      <header className="header">
        <h1>Confirm wallet activity</h1>
        <p className="sub">
          Wallets with no Harmony activity in the six months before the cutoff{cutoffDate ? ` (${cutoffDate})` : ""} were
          not included in the initial airdrop. This check keeps dead and inaccessible wallets out of the migrated supply.
          Confirm you are still active by signing a message from the wallet. Signing does not send a transaction or cost anything.
        </p>
      </header>

      <section className="card">
        <h2>1. Connect the wallet</h2>
        <div className="connect-row">
          {isConnected && connected ? (
            <>
              <span className="pill ok">Connected {shortAddress(connected)}</span>
              <button type="button" className="ghost" onClick={() => disconnect()}>
                Disconnect
              </button>
            </>
          ) : (
            <>
              {injectedConnectors.length > 0 ? (
                injectedConnectors.map((c) => (
                  <button key={c.uid} type="button" disabled={connecting} onClick={() => connect({ connector: c })}>
                    {connecting ? "Connecting…" : `Connect ${c.name === "Injected" ? "browser wallet" : c.name}`}
                  </button>
                ))
              ) : (
                <span className="muted">No browser wallet detected.</span>
              )}
              {wcConnector && (
                <button type="button" className="ghost" disabled={connecting} onClick={() => connect({ connector: wcConnector })}>
                  WalletConnect
                </button>
              )}
            </>
          )}
        </div>
        {connectError && <p className="error">{connectError.message}</p>}
        <p className="small">
          Use the wallet that holds this Harmony address. Signing is free and does not send a transaction.
        </p>
      </section>

      <section className="card">
        <h2>2. Review and sign</h2>
        {!connected && <p className="muted">Connect your wallet to check whether it needs to confirm.</p>}
        {status.isLoading && <p className="muted">Loading…</p>}
        {status.error && <p className="error">{explain(status.error)}</p>}
        {status.data && !status.data.eligible && (
          <div className="banner warn">
            <strong>This wallet cannot be confirmed here.</strong> Only wallets left out because they had no Harmony
            activity in the six months before the cutoff can use this page. See the{" "}
            <a href={`/?address=${encodeURIComponent(connected ?? "")}`}>claim lookup</a> for this wallet’s status.
          </div>
        )}
        {status.data?.eligible && recorded && (
          <div className="banner ok">
            <strong>Activity confirmed</strong> at {formatUtc(recorded.recorded_at)}. Nothing else is needed from this wallet.
          </div>
        )}
        {status.data?.eligible && !recorded && (
          <>
            <p>
              {status.data.stage_reason === "no indexed wallet activity"
                ? "No activity on Harmony was found for this wallet before the cutoff, so it was not included in the initial airdrop."
                : activity?.time_utc
                  ? `This wallet's last activity on Harmony was on ${formatDate(activity.time_utc)}, more than six months before the cutoff, so it was not included in the initial airdrop.`
                  : "This wallet's last activity on Harmony was more than six months before the cutoff, so it was not included in the initial airdrop."}
            </p>
            {claim.data?.migration_policy && (
              <div className="summary">
                <div>
                  <span className="label">Amount not included in initial airdrop</span>
                  <span className="big">{one(claim.data.migration_policy.total_allocation_atto)} ONE</span>
                </div>
                <div>
                  <span className="label">Last Harmony activity</span>
                  <span className="big">{activity ? formatUtc(activity.time_utc) : "No activity found"}</span>
                </div>
              </div>
            )}
            <p>
              <button type="button" disabled={confirm.isPending || signing} onClick={() => confirm.mutate()}>
                {confirm.isPending || signing ? "Waiting for signature…" : "Confirm you are still active"}
              </button>
            </p>
            {confirm.error && <p className="error">{explain(confirm.error)}</p>}
          </>
        )}
        {signedMessage && (
          <div className="block">
            <h3>Message presented to the wallet</h3>
            <pre className="message">{signedMessage}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
