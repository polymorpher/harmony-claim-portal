import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useConnect, useDisconnect } from "wagmi";
import { hexToBech32, type SignatureScheme } from "@hcp/shared";
import { ApiRequestError, fetchClaim, fetchConfirmation, fetchMeta, createConfirmationChallenge, submitConfirmation } from "./api";
import { formatDate, formatUtc, one, shortAddress } from "./format";
import { LEDGER_APP_LABEL, LedgerAccounts } from "./ledger/LedgerAccounts";
import { useLedger } from "./ledger/useLedger";
import { Nav } from "./Nav";
import { useWallet } from "./useWallet";
import { connectErrorText, isConnecting, walletErrorText } from "./wallet";
import { WalletAccounts } from "./WalletAccounts";
import { walletConnectConnector } from "./wagmi";

function explain(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 429) return `Too many requests. Try again in ${err.retryAfterSeconds ?? 60} seconds.`;
    return err.message;
  }
  const wallet = walletErrorText(err);
  if (wallet) return wallet;
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong while contacting the confirmation service.";
}

export function ConfirmPage() {
  const wallet = useWallet();
  const walletAddress = wallet.address;
  const { connectors, connect, isPending: connecting, variables: connectVariables, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const ledger = useLedger();
  const connectErrorMessage = connectErrorText(connectError);
  const [signedMessage, setSignedMessage] = useState<string | null>(null);

  const ledgerAccount = ledger.account;
  const connected = ledgerAccount?.address ?? walletAddress;
  const viaWalletConnect = !ledgerAccount && wallet.accounts.length > 0;
  const legacyLedger = ledger.app?.kind === "harmony-legacy";

  const injectedConnectors = useMemo(
    () => connectors.filter((c) => c.type === "injected" || c.id === "injected"),
    [connectors],
  );
  const wcConnector = walletConnectConnector;

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
    enabled: Boolean(connected) && (status.data?.eligible === true || (status.data !== undefined && !ledgerAccount)),
    retry: false,
  });
  const noClaim = status.data?.eligible === false && !ledgerAccount && claim.data?.found === false;

  useEffect(() => {
    setSignedMessage(null);
  }, [connected]);

  const confirm = useMutation({
    mutationFn: async () => {
      if (!connected) throw new Error("Connect the wallet that holds this address.");
      const viaLedger = ledgerAccount !== null;
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
      const signed: { signature: string; scheme: SignatureScheme } = viaLedger
        ? await ledger.sign(challenge.message, connected)
        : { signature: await wallet.signMessage(challenge.message), scheme: "personal_sign" };
      return submitConfirmation(
        connected,
        challenge.nonce,
        challenge.issued_at,
        signed.signature,
        challenge.data_version,
        challenge.policy_version,
        signed.scheme,
      );
    },
    onSuccess: async () => {
      await status.refetch();
    },
  });

  const recorded = status.data?.confirmation;
  const activity = claim.data?.last_activity;
  const waiting = confirm.isPending;

  return (
    <div className="page">
      <Nav current="/confirm" />
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
          {ledger.app && ledgerAccount ? (
            <>
              <span className="pill ok">
                Ledger, {LEDGER_APP_LABEL[ledger.app.kind]} {ledger.app.version}
              </span>
              <button type="button" className="ghost" disabled={waiting} onClick={() => void ledger.disconnect()}>
                Disconnect
              </button>
            </>
          ) : walletAddress ? (
            <>
              <span className="pill ok">Connected {shortAddress(walletAddress)}</span>
              <button type="button" className="ghost" disabled={waiting} onClick={() => disconnect()}>
                Disconnect
              </button>
            </>
          ) : (
            <>
              {injectedConnectors.length > 0 ? (
                injectedConnectors.map((c) => (
                  <button key={c.uid} type="button" disabled={connecting} onClick={() => connect({ connector: c })}>
                    {isConnecting(connecting, connectVariables, c)
                      ? "Connecting…"
                      : `Connect ${c.name === "Injected" ? "browser wallet" : c.name}`}
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
              <button
                type="button"
                className="ghost"
                disabled={!ledger.supported || ledger.busy}
                onClick={() => void ledger.connect()}
              >
                {ledger.busy ? "Reading the Ledger…" : "Ledger (USB)"}
              </button>
            </>
          )}
        </div>
        <LedgerAccounts ledger={ledger} locked={waiting} />
        {!ledgerAccount && <WalletAccounts wallet={wallet} locked={waiting} />}
        {connectErrorMessage && <p className="error">{connectErrorMessage}</p>}
        {ledger.error && <p className="error">{ledger.error}</p>}
        {!connected && (
          <ul className="connect-help">
            <li>
              <strong>Browser wallet</strong>: MetaMask or another wallet extension, including MetaMask with a Ledger.
            </li>
            {wcConnector && (
              <li>
                <strong>WalletConnect</strong>: phone wallets, hardware wallet apps, and Ledger Wallet (formerly Ledger
                Live). In Ledger Wallet, open your Ethereum account, click WalletConnect, and paste the link. The wallet
                chooses which addresses to share. This page lists each one, including a Harmony address the wallet keeps
                on Harmony's path (<code>m/44'/1023'</code>) and shares for the Harmony network, and signs with the one
                you choose.
              </li>
            )}
            <li>
              <strong>Ledger (USB)</strong>: the Harmony app on a Ledger, either the 2025 version or the older one, or the
              Ethereum app. Works in Chrome, Edge, or Brave on a computer. Close Ledger Wallet first.
              {!ledger.supported && " This browser cannot connect to a Ledger over USB."}
            </li>
          </ul>
        )}
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
        {noClaim && (
          <div className="banner neutral">
            <p>
              <strong>This address has no migration claim.</strong> If you used a different address on Harmony,
              connect the wallet that holds it{viaWalletConnect ? ", or choose it above if this wallet shares it" : ""}.
              Some wallets keep Harmony addresses on Harmony's path (<code>m/44'/1023'/0'/0/N</code>) and give other
              sites only their Ethereum address. In the wallet, select the Harmony network or the Harmony account, then
              disconnect and connect again. A Harmony address on a Ledger works with the Ledger (USB) option.
            </p>
            <p>
              <strong>Only if all else fails:</strong> recover that address's private key from the wallet's recovery
              phrase with our <a href="/ledger">offline key tool</a>, on a computer that is offline, and import it into a
              browser wallet to connect here. Typing a recovery phrase into a computer exposes it: afterwards, move
              everything the wallet holds, on every network, to a new recovery phrase.
            </p>
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
            {legacyLedger && connected && (
              <div className="banner neutral ledger-note">
                The older Harmony Ledger app cannot sign a message, so it signs a transaction instead. The Ledger will show
                a transfer of 0 ONE to your own address, <code>{hexToBech32(connected.toLowerCase())}</code>, from shard 0
                to shard 0. Approve it. This site does not send that transaction, and Harmony would reject it anyway because
                its gas limit is 0. The message shown below goes in the transaction's data field, which the Ledger does not
                display.
              </div>
            )}
            {ledger.app && !legacyLedger && (
              <p className="small">The Ledger will show the message below. Check it, then approve it on the Ledger.</p>
            )}
            <p>
              <button type="button" disabled={waiting} onClick={() => confirm.mutate()}>
                {waiting
                  ? ledgerAccount
                    ? "Approve on your Ledger…"
                    : "Waiting for signature…"
                  : "Confirm you are still active"}
              </button>
            </p>
            {confirm.error && <p className="error">{explain(confirm.error)}</p>}
          </>
        )}
        {signedMessage && (
          <div className="block">
            <h3>{legacyLedger ? "Message in the transaction data" : "Message presented to the wallet"}</h3>
            <pre className="message">{signedMessage}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
