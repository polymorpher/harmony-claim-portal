import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAccount, useConnect, useDisconnect, useSignMessage } from "wagmi";
import { ApiRequestError, fetchClaim, fetchConfirmation, createConfirmationChallenge, submitConfirmation } from "./api";
import { formatUtc, one, shortAddress } from "./format";

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
        throw new Error("The connected account changed. Request a new challenge.");
      }
      const latest = await fetchConfirmation(connected);
      if (
        latest.data_version !== challenge.data_version ||
        latest.policy_version !== challenge.policy_version
      ) {
        throw new Error("The confirmation set changed. Request a new challenge.");
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
      <nav className="nav">
        <a href="/">Lookup</a>
        <a href="/confirm" aria-current="page">Confirm</a>
      </nav>
      <header className="header">
        <h1>Confirm an older wallet</h1>
        <p className="sub">
          Wallets whose last indexed activity is outside the six months before the cutoff stay in a later batch.
          Signing proves you control the key today. It does not send a transaction or change the snapshot.
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
          Use the same key that controlled the Harmony address. The signature is <code>personal_sign</code> and spends no gas.
        </p>
      </section>

      <section className="card">
        <h2>2. Review and sign</h2>
        {!connected && <p className="muted">Connect a wallet to see whether it can be confirmed.</p>}
        {status.isLoading && <p className="muted">Loading…</p>}
        {status.error && <p className="error">{explain(status.error)}</p>}
        {status.data && !status.data.eligible && (
          <div className="banner warn">
            <strong>Not eligible.</strong> This address is not in the current next-batch confirmation set.
            The <a href={`/?address=${encodeURIComponent(connected ?? "")}`}>claim lookup</a> shows its migration stage.
          </div>
        )}
        {status.data?.eligible && recorded && (
          <div className="banner ok">
            <strong>Confirmation recorded</strong> at {formatUtc(recorded.recorded_at)} for data version {recorded.data_version}.
            The allocation stays deferred until a later batch is published.
          </div>
        )}
        {status.data?.eligible && !recorded && (
          <>
            <p>
              {status.data.stage_reason === "no indexed wallet activity"
                ? "No indexed wallet activity was found before the cutoff."
                : "The last indexed activity is outside the six-month window."}
              {" "}Snapshot qualification is unchanged. A recorded signature is reviewed for the next batch and does not guarantee inclusion.
            </p>
            {claim.data?.migration_policy && (
              <div className="summary">
                <div>
                  <span className="label">Deferred allocation</span>
                  <span className="big">{one(claim.data.migration_policy.total_allocation_atto)} ONE</span>
                </div>
                <div>
                  <span className="label">Last indexed activity</span>
                  <span className="big">{activity ? formatUtc(activity.time_utc) : "None indexed"}</span>
                </div>
              </div>
            )}
            <p>
              <button type="button" disabled={confirm.isPending || signing} onClick={() => confirm.mutate()}>
                {confirm.isPending || signing ? "Waiting for signature…" : "Sign confirmation"}
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
