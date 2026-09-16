import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { ApiRequestError, fetchClaim, fetchMeta } from "./api";
import { ClaimView } from "./ClaimView";
import { formatUtc, looksLikeAddress, one, shortAddress } from "./format";

function addressFromUrl(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("address")?.trim() ?? "";
}

function setAddressInUrl(address: string) {
  const url = new URL(window.location.href);
  if (address) url.searchParams.set("address", address);
  else url.searchParams.delete("address");
  window.history.replaceState(null, "", url.toString());
}

export function App() {
  const { address: connected, isConnected } = useAccount();
  const { connectors, connect, isPending: connecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();

  const [input, setInput] = useState(addressFromUrl);
  const [lookup, setLookup] = useState<string>(addressFromUrl);
  const [inputError, setInputError] = useState<string | null>(null);

  // Auto-lookup the connected wallet unless the user pasted another address.
  useEffect(() => {
    if (isConnected && connected && !addressFromUrl()) {
      setInput(connected);
      setLookup(connected);
      setAddressInUrl(connected);
    }
  }, [isConnected, connected]);

  const meta = useQuery({ queryKey: ["meta"], queryFn: fetchMeta, staleTime: 60_000 });
  const claim = useQuery({
    queryKey: ["claim", lookup.toLowerCase()],
    queryFn: () => fetchClaim(lookup),
    enabled: looksLikeAddress(lookup),
    retry: false,
    staleTime: 30_000,
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const value = input.trim();
    if (!looksLikeAddress(value)) {
      setInputError("Enter a 0x… hex address or a one1… address.");
      return;
    }
    setInputError(null);
    setLookup(value);
    setAddressInUrl(value);
  };

  const injectedConnectors = useMemo(
    () => connectors.filter((c) => c.type === "injected" || c.id === "injected"),
    [connectors],
  );
  const wcConnector = connectors.find((c) => c.type === "walletConnect");

  const errorText = (() => {
    const err = claim.error;
    if (!err) return null;
    if (err instanceof ApiRequestError) {
      if (err.status === 429) {
        return `Too many lookups from your connection. Try again in ${err.retryAfterSeconds ?? 60} seconds.`;
      }
      if (err.status === 400) return "That address is not valid.";
      if (err.status === 503) return "The lookup service is temporarily unavailable.";
      return err.message;
    }
    return "Network error while contacting the lookup service.";
  })();

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Harmony migration claim lookup</h1>
          <p className="sub">
            See how your Harmony ONE balance at the cutoff maps to the Ethereum ERC-20 airdrop and validator
            vault shares.
          </p>
        </div>
      </header>

      <section className="card">
        <h2>1. Choose an address</h2>
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
                  <button
                    key={c.uid}
                    type="button"
                    disabled={connecting}
                    onClick={() => connect({ connector: c })}
                  >
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

        <form className="lookup" onSubmit={onSubmit}>
          <label htmlFor="address">or paste an address (0x… or one1…)</label>
          <div className="row">
            <input
              id="address"
              name="address"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x… or one1…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button type="submit" disabled={claim.isFetching}>
              {claim.isFetching ? "Looking up…" : "Look up"}
            </button>
          </div>
          {inputError && <p className="error">{inputError}</p>}
        </form>
      </section>

      <section className="card">
        <h2>2. Your claim</h2>
        {!looksLikeAddress(lookup) && <p className="muted">Connect a wallet or enter an address to begin.</p>}
        {claim.isLoading && looksLikeAddress(lookup) && <p className="muted">Loading…</p>}
        {errorText && <p className="error">{errorText}</p>}
        {claim.data && <ClaimView claim={claim.data} />}
      </section>

      <footer className="footer">
        {meta.data ? (
          <>
            <span>
              Cutoff: shard 0 block {meta.data.cutoff.shard0?.block.toLocaleString() ?? "?"}, shard 1 block{" "}
              {meta.data.cutoff.shard1?.block.toLocaleString() ?? "?"} ({formatUtc(meta.data.cutoff.requested_time_utc)})
            </span>
            <span>Threshold: {one(meta.data.threshold_atto, 0)} ONE total claim</span>
            <span>
              Data version: {meta.data.data_version ?? "-"}
              {meta.data.fixture ? " (synthetic test data)" : ""}
            </span>
          </>
        ) : (
          <span className="muted">Loading cutoff information…</span>
        )}
        <span className="muted">
          This page only reads a single address at a time. It never asks you to sign anything.
        </span>
      </footer>
    </div>
  );
}
