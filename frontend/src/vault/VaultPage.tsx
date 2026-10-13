import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { isAddress } from "viem";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { formatDate, shortAddress } from "../format";
import { LEDGER_APP_LABEL, LedgerAccounts } from "../ledger/LedgerAccounts";
import { useLedger, type LedgerSession } from "../ledger/useLedger";
import { Nav } from "../Nav";
import { onNavigate } from "../router";
import { connectErrorText, isConnecting } from "../wallet";
import { walletConnectConnector } from "../wagmi";
import { readAgreements } from "./agreements";
import { findVault, loadCatalog, type Catalog } from "./catalog";
import { chainById } from "./chain";
import { useVaultSigner, type VaultSigner } from "./useVaultSigner";
import { VaultDetail } from "./VaultDetail";
import { VaultList } from "./VaultList";

function WalletPanel({ ledger, signer, catalog }: { ledger: LedgerSession; signer: VaultSigner; catalog: Catalog | undefined }) {
  const { isConnected, address, chainId } = useAccount();
  const { connectors, connect, isPending: connecting, variables: connectVariables, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const connectErrorMessage = connectErrorText(connectError);
  const injectedConnectors = useMemo(() => connectors.filter((c) => c.type === "injected" || c.id === "injected"), [connectors]);
  const wcConnector = walletConnectConnector;
  const network = catalog ? chainById(catalog.chain_id).name : "Ethereum";

  return (
    <section className="card">
      <h2>Wallet</h2>
      <div className="connect-row">
        {ledger.app && ledger.account ? (
          <>
            <span className="pill ok">
              Ledger, {LEDGER_APP_LABEL[ledger.app.kind]} {ledger.app.version}
            </span>
            <button type="button" className="ghost" onClick={() => void ledger.disconnect()}>
              Disconnect
            </button>
          </>
        ) : isConnected && address ? (
          <>
            <span className="pill ok">Connected {shortAddress(address)}</span>
            <button type="button" className="ghost" onClick={() => disconnect()}>
              Disconnect
            </button>
          </>
        ) : (
          <>
            {injectedConnectors.length > 0 ? (
              injectedConnectors.map((c) => (
                <button key={c.uid} type="button" disabled={connecting} onClick={() => connect({ connector: c })}>
                  {isConnecting(connecting, connectVariables, c) ? "Connecting…" : `Connect ${c.name === "Injected" ? "browser wallet" : c.name}`}
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
            <button type="button" className="ghost" disabled={!ledger.supported || ledger.busy} onClick={() => void ledger.connect()}>
              {ledger.busy ? "Reading the Ledger…" : "Ledger (USB)"}
            </button>
          </>
        )}
      </div>
      <LedgerAccounts ledger={ledger} locked={false} />
      {connectErrorMessage && <p className="error">{connectErrorMessage}</p>}
      {ledger.error && <p className="error">{ledger.error}</p>}
      {signer.blockedReason && (
        <div className="banner warn">
          <strong>View only.</strong> {signer.blockedReason}
        </div>
      )}
      {signer.via === "wallet" && catalog && chainId !== catalog.chain_id && (
        <p className="small">Your wallet is on another network. It will be asked to switch to {network} when you send a transaction.</p>
      )}
      {!signer.address && (
        <ul className="connect-help">
          <li>
            <strong>Browser wallet</strong>: MetaMask or another wallet extension, including MetaMask with a Ledger.
          </li>
          {wcConnector && (
            <li>
              <strong>WalletConnect</strong>: phone wallets, and Ledger Wallet (formerly Ledger Live).
            </li>
          )}
          <li>
            <strong>Ledger (USB)</strong>: the Ethereum app sends transactions; turn on Blind signing in its settings. The
            Harmony apps, 2025 or older, can connect to view an address but cannot sign Ethereum transactions. Works in Chrome,
            Edge, or Brave on a computer. Close Ledger Wallet first.
            {!ledger.supported && " This browser cannot connect to a Ledger over USB."}
          </li>
        </ul>
      )}
      {signer.address && <p className="small">Viewing as <code>{signer.address}</code>.</p>}
    </section>
  );
}

export function VaultPage({ path }: { path: string }) {
  const ledger = useLedger();
  const catalog = useQuery({ queryKey: ["vault-catalog"], queryFn: () => loadCatalog(), staleTime: Infinity, retry: 1 });
  const signer = useVaultSigner(ledger, catalog.data?.chain_id);
  const target = path.startsWith("/vault/") ? path.slice("/vault/".length) : null;
  const entry = catalog.data && target && isAddress(target, { strict: false }) ? findVault(catalog.data, target) : undefined;
  const agreementIds = useMemo(() => catalog.data?.vaults.flatMap((v) => (v.agreement ? [v.agreement.id] : [])) ?? [], [catalog.data]);
  const agreements = useQuery({
    queryKey: ["governor-agreements", agreementIds.length],
    queryFn: () => readAgreements(agreementIds),
    enabled: agreementIds.length > 0,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  const agreementInfo = {
    live: agreements.data,
    asOf: catalog.data?.governor_agreements ? formatDate(catalog.data.governor_agreements.checked_utc) : null,
  };

  useEffect(() => {
    document.title = entry ? `${entry.name || entry.validator_one1} · Governor Vaults` : "Governor Vaults · Harmony migration";
  }, [entry]);

  return (
    <div className="page">
      <Nav current="/vault" />
      <header className="header">
        <h1>Governor Vaults</h1>
        <p className="sub">
          Each Harmony validator's delegated stake at the cutoff is held in a governor vault on Ethereum, credited to the
          same delegator addresses. The validator is the vault's governor and sets its fee. Look up a vault, then withdraw or
          deposit ERC-20 ONE with a connected wallet.
        </p>
      </header>

      <WalletPanel ledger={ledger} signer={signer} catalog={catalog.data} />

      {catalog.isLoading && <p className="muted">Loading the vault list…</p>}
      {catalog.error && <p className="error">{catalog.error instanceof Error ? catalog.error.message : "The vault list could not be loaded."}</p>}
      {catalog.data && target === null && (
        <VaultList catalog={catalog.data} account={signer.address ?? undefined} agreements={agreementInfo} />
      )}
      {catalog.data && target !== null && !entry && (
        <section className="card">
          <p className="error">
            <code>{target}</code> is not a governor vault.
          </p>
          <p>
            <a href="/vault" onClick={onNavigate("/vault")}>
              Back to all governor vaults
            </a>
          </p>
        </section>
      )}
      {catalog.data && entry && (
        <VaultDetail key={entry.vault} catalog={catalog.data} entry={entry} signer={signer} agreements={agreementInfo} />
      )}
    </div>
  );
}
