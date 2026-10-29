import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BaseError, formatUnits, type Address, type Hex } from "viem";
import { useConnect, useDisconnect } from "wagmi";
import { chainById, chainName, explorer, publicClient } from "../chains";
import { formatUtc, shortAddress } from "../format";
import { LEDGER_APP_LABEL, LedgerAccounts } from "../ledger/LedgerAccounts";
import { useLedger, type LedgerSession } from "../ledger/useLedger";
import { Nav } from "../Nav";
import { useSigner, type Signer } from "../signer";
import { useWallet, walletSendBlocked } from "../useWallet";
import { parseAddress } from "../vault/format";
import { connectErrorText, isConnecting } from "../wallet";
import { WalletAccounts } from "../WalletAccounts";
import { walletConnectConnector } from "../wagmi";
import { bridgeClaimsAbi } from "./abi";
import { BRIDGE, listUrls, NATIVE, type BridgeContract, type SnapshotBlock } from "./deployments";
import { claimErrorText, claimManyArgs, claimManyData, formatAmount, payableRows, rowsByContract, rowStatus, type RowStatus } from "./model";
import { loadRows, ProofError, type BridgeRow } from "./proofs";
import {
  countedOn,
  describeBasis,
  formatMoment,
  holderChainName,
  joinList,
  remoteHoldersAt,
  snapshotBases,
  snapshotChains,
  type SnapshotBasis,
} from "./snapshots";
import { readContractState } from "./state";

function addressFromUrl(): string {
  return new URLSearchParams(window.location.search).get("address")?.trim() ?? "";
}

function setAddressInUrl(address: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("address", address);
  window.history.replaceState(null, "", url.toString());
}

function WalletCard({ ledger, signer, onSelect }: { ledger: LedgerSession; signer: Signer; onSelect: (address: Address) => void }) {
  const wallet = useWallet();
  const address = wallet.address;
  const { connectors, connect, isPending: connecting, variables: connectVariables, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const connectErrorMessage = connectErrorText(connectError);
  const injectedConnectors = useMemo(() => connectors.filter((c) => c.type === "injected" || c.id === "injected"), [connectors]);
  const wcConnector = walletConnectConnector;

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
        ) : address ? (
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
      {signer.via === "wallet" && <WalletAccounts wallet={wallet} onSelect={onSelect} />}
      {connectErrorMessage && <p className="error">{connectErrorMessage}</p>}
      {ledger.error && <p className="error">{ledger.error}</p>}
      {!signer.address && (
        <ul className="connect-help">
          <li>
            <strong>Browser wallet</strong>: MetaMask or another wallet extension, including MetaMask with a Ledger. It is asked to
            switch to the claim's network when you claim.
          </li>
          {wcConnector && (
            <li>
              <strong>WalletConnect</strong>: phone wallets, and Ledger Wallet (formerly Ledger Live).
            </li>
          )}
          <li>
            <strong>Ledger (USB)</strong>: the Ethereum app sends claims on every chain here; turn on Blind signing in its
            settings. The Harmony apps, 2025 or older, can show an address but cannot send transactions outside Harmony. Works in
            Chrome, Edge, or Brave on a computer. Close Ledger Wallet first.
            {!ledger.supported && " This browser cannot connect to a Ledger over USB."}
          </li>
        </ul>
      )}
      {signer.address && (
        <p className="small">
          Connected as <code>{signer.address}</code>. A claim can be sent from any wallet; the assets always go to the address
          the claim belongs to.
        </p>
      )}
    </section>
  );
}

type ClaimTx =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "wallet" }
  | { phase: "pending"; hash: Hex }
  | { phase: "done"; hash: Hex; count: number }
  | { phase: "error"; message: string };

function ClaimStatus({ tx, chainId, via }: { tx: ClaimTx; chainId: number; via: Signer["via"] }) {
  const link = (hash: Hex, text: string) => (
    <a href={`${explorer(chainId)}/tx/${hash}`} target="_blank" rel="noreferrer">
      {text}
    </a>
  );
  switch (tx.phase) {
    case "idle":
      return null;
    case "checking":
      return <p className="muted">Checking the claim with the contract…</p>;
    case "wallet":
      return <p className="muted">Confirm the claim in your {via === "ledger" ? "Ledger" : "wallet"}…</p>;
    case "pending":
      return <p className="muted">Waiting for the transaction to be included ({link(tx.hash, "view")})…</p>;
    case "done":
      return (
        <p className="ok-text">
          Claimed {tx.count} {tx.count === 1 ? "asset" : "assets"} ({link(tx.hash, "view transaction")}).
        </p>
      );
    case "error":
      return <p className="error">{tx.message}</p>;
  }
}

const STATUS_TEXT: Record<RowStatus, { text: string; className: string; title?: string }> = {
  claimed: { text: "Claimed", className: "ok-text" },
  ready: { text: "Ready", className: "" },
  waiting: { text: "Not open yet", className: "muted", title: "The custody Safe has not yet made this asset available to the claim contract." },
};

function AssetCell({ row }: { row: BridgeRow }) {
  if (row.asset.token === NATIVE) return <>{row.asset.symbol}</>;
  return (
    <a href={`${explorer(row.contract.chain_id)}/token/${row.asset.token}`} target="_blank" rel="noreferrer" title={row.asset.token}>
      {row.asset.symbol}
    </a>
  );
}

function Basis({ basis }: { basis: SnapshotBasis }) {
  const d = describeBasis(basis);
  return (
    <>
      {d.what}{" "}
      {d.moment ? (
        <>
          {d.when},{" "}
          <span className="tip" tabIndex={0} title={d.blocks}>
            {formatMoment(d.moment)}
          </span>
        </>
      ) : (
        <span className="tip" tabIndex={0} title={d.blocks}>
          {d.when}
        </span>
      )}
    </>
  );
}

/** Which balances and moment a card's amounts start from; the exact blocks are in the tooltip. */
function SnapshotNote({ rows }: { rows: BridgeRow[] }) {
  const bases = snapshotBases(rows);
  const how = <a href="#amounts">How the amounts were computed</a>;
  if (bases.length === 1) {
    return (
      <p className="small">
        Amounts start from <Basis basis={bases[0]} />. {how}.
      </p>
    );
  }
  return (
    <div className="small snapshot-notes">
      Amounts start from:
      <ul>
        {bases.map((b) => (
          <li key={b.key}>
            {b.symbols.join(", ")}: <Basis basis={b} />
          </li>
        ))}
      </ul>
      {how}.
    </div>
  );
}

function ChainCard({ contract, rows, signer }: { contract: BridgeContract; rows: BridgeRow[]; signer: Signer }) {
  const queryClient = useQueryClient();
  const account = rows[0].account;
  const chainId = contract.chain_id;
  const name = chainName(chainId);
  const coin = chainById(chainId).nativeCurrency.symbol;
  const stateKey = ["bridge-state", contract.label, account.toLowerCase()];
  const state = useQuery({ queryKey: stateKey, queryFn: () => readContractState(contract, rows), staleTime: 30_000, retry: 1 });
  const [tx, setTx] = useState<ClaimTx>({ phase: "idle" });
  const busy = tx.phase === "checking" || tx.phase === "wallet" || tx.phase === "pending";
  const ready = state.data?.code === "ok" ? state.data : null;
  const payable = ready ? payableRows(rows, ready) : [];
  const allClaimed = ready !== null && rows.every((r) => ready.claimed.get(r.index));
  const waiting = ready !== null && rows.some((r) => rowStatus(r, ready) === "waiting");
  const native = rows.find((r) => r.asset.token === NATIVE);
  const sender = signer.address;
  const forSomeoneElse = sender !== null && sender.toLowerCase() !== account.toLowerCase();
  const sendBlocked = signer.via === "wallet" ? walletSendBlocked(signer, chainId) : null;

  async function claim() {
    const batch = payable;
    if (!sender || batch.length === 0) return;
    const client = publicClient(chainId);
    setTx({ phase: "checking" });
    try {
      await client.simulateContract({ account: sender, address: contract.address, abi: bridgeClaimsAbi, functionName: "claimMany", args: claimManyArgs(batch) });
      setTx({ phase: "wallet" });
      const hash = await signer.send({ chainId, to: contract.address, data: claimManyData(batch) });
      setTx({ phase: "pending", hash });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The transaction failed on chain.");
      setTx({ phase: "done", hash, count: batch.length });
    } catch (err) {
      setTx({ phase: "error", message: claimErrorText(err) });
    } finally {
      void queryClient.invalidateQueries({ queryKey: stateKey });
    }
  }

  return (
    <section className="card">
      <h2>{name}</h2>
      <p className="small">
        Claim contract{" "}
        <a href={`${explorer(chainId)}/address/${contract.address}#code`} target="_blank" rel="noreferrer">
          <code>{contract.address}</code>
        </a>
      </p>
      <SnapshotNote rows={rows} />
      <table className="bridge-rows">
        <thead>
          <tr>
            <th>Asset</th>
            <th className="num">Amount</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const status = ready ? STATUS_TEXT[rowStatus(r, ready)] : null;
            return (
              <tr key={r.index}>
                <td>
                  <AssetCell row={r} />
                </td>
                <td className="num" title={`${formatUnits(r.amount, r.asset.decimals)} ${r.asset.symbol}`}>
                  {formatAmount(r.amount, r.asset.decimals)}
                </td>
                <td>{status ? <span className={status.className} title={status.title}>{status.text}</span> : <span className="muted">…</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {state.isLoading && <p className="muted">Reading {name}…</p>}
      {state.error && (
        <p className="error">
          {name} could not be read: {state.error instanceof BaseError ? state.error.shortMessage : "network error"}{" "}
          <button type="button" className="ghost small-button" onClick={() => void state.refetch()}>
            Try again
          </button>
        </p>
      )}
      {state.data && state.data.code !== "ok" && (
        <div className="banner warn block">
          {state.data.code === "missing"
            ? `${name} has no contract at this address. `
            : `The contract at this address on ${name} does not have the code this page expects. `}
          Claiming is turned off here. Check the address against the published lists before you do anything else.
        </div>
      )}
      {allClaimed && <p className="ok-text">Everything on {name} has been claimed.</p>}
      {ready && !allClaimed && payable.length === 0 && (
        <p className="muted">
          Claims on {name} are not open yet. They open once the custody Safe approves this contract for each asset; this page then
          shows them as ready.
        </p>
      )}
      {payable.length > 0 && (
        <div className="bridge-action">
          {sender === null ? (
            <p className="small">Connect a wallet above to claim. Any wallet can send the claim; the assets go to this address.</p>
          ) : !signer.canSend ? (
            <div className="banner warn block">
              The Harmony apps on a Ledger cannot send transactions on {name}. Anyone can send this claim and the assets still go to{" "}
              <code>{account}</code>, so you can connect another wallet that holds a little {coin} for the fee.{" "}
              <a href="/ledger">Using a Harmony Ledger address later</a>.
            </div>
          ) : sendBlocked ? (
            <div className="banner warn block">
              {sendBlocked} Any address can send this claim; the assets still go to <code>{account}</code>.
            </div>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => void claim()}>
                Claim {payable.length} {payable.length === 1 ? "asset" : "assets"} on {name}
              </button>
              {forSomeoneElse && (
                <p className="small">
                  <code>{shortAddress(sender)}</code> sends the transaction and pays the fee; the assets go to <code>{account}</code>.
                </p>
              )}
              <p className="small">
                The claim costs a network fee in {coin}.{waiting ? " Assets that are not open yet are left out until they open." : ""}
              </p>
            </>
          )}
        </div>
      )}
      {native && (
        <p className="small">
          {native.asset.symbol} is sent as the coin itself. An address that cannot receive it, such as some contracts, gets W
          {native.asset.symbol} instead.
        </p>
      )}
      <ClaimStatus tx={tx} chainId={chainId} via={signer.via} />
    </section>
  );
}

function Results({ account, signer }: { account: Address; signer: Signer }) {
  const rows = useQuery({ queryKey: ["bridge-rows", account.toLowerCase()], queryFn: () => loadRows(account), staleTime: Infinity, retry: 1 });
  if (rows.isLoading) {
    return (
      <section className="card">
        <p className="muted">Loading the claim list…</p>
      </section>
    );
  }
  if (rows.error) {
    return (
      <section className="card">
        <p className="error">{rows.error instanceof ProofError ? rows.error.message : "The claim list could not be loaded. Check your connection and try again."}</p>
      </section>
    );
  }
  const groups = rowsByContract(rows.data ?? [], BRIDGE.contracts);
  if (groups.length === 0) {
    return (
      <section className="card">
        <h2>No bridge claim</h2>
        <p>
          <code>{account}</code> is not in any of the five claim lists.
        </p>
        <p className="small">
          The lists pay the holders of bridged tokens at the snapshot. Some contract holders, such as multisigs that held on
          another chain and 1wallets, are held for review and are not listed yet.
        </p>
      </section>
    );
  }
  return (
    <>
      <p className="history-id">
        Claims of <code>{account}</code> on {groups.length === 1 ? chainName(groups[0].contract.chain_id) : `${groups.length} chains`}.
      </p>
      {groups.map((g) => (
        <ChainCard key={`${g.contract.label}-${account}`} contract={g.contract} rows={g.rows} signer={signer} />
      ))}
    </>
  );
}

function About() {
  return (
    <section className="card">
      <h2>How bridge claims work</h2>
      <ul className="notes">
        <li>
          Harmony's LayerZero bridge held the assets behind bridged tokens. That collateral is now in the custody Safe on each
          chain and goes back to the holders, at the same address: holders of a bridged token on Harmony receive the original
          asset on the chain it came from, and holders of bridged ONE on BNB Chain or Ethereum receive ERC-20 ONE on Ethereum.
        </li>
        <li>
          Each chain has one claim contract with a fixed list. It pays each row once, from the custody Safe, always to the row's
          address. Nobody can change the list or the contract. Anyone can send a claim for any address.
        </li>
        <li>
          This page loads the address's rows from the published lists and checks each row's proof against the list's root
          built into this page. It checks each contract's code on its chain, then reads which rows are paid and what the custody
          Safe makes available.
        </li>
      </ul>
      <table className="bridge-contracts">
        <thead>
          <tr>
            <th>Chain</th>
            <th>Contract</th>
            <th className="num">Rows</th>
            <th>List</th>
          </tr>
        </thead>
        <tbody>
          {BRIDGE.contracts.map((c) => (
            <tr key={c.label}>
              <td>{chainName(c.chain_id)}</td>
              <td>
                <a href={`${explorer(c.chain_id)}/address/${c.address}#code`} target="_blank" rel="noreferrer" title={c.address}>
                  <code>{shortAddress(c.address)}</code>
                </a>
              </td>
              <td className="num">{c.claim_count.toLocaleString("en-US")}</td>
              <td>
                <a href={listUrls(c).claims}>claims.csv</a> · <a href={listUrls(c).manifest}>manifest</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small">
        Run <code>{BRIDGE.run}</code>, published with its trees and checksums at{" "}
        <a href={`${BRIDGE.published_url}/README.md`}>{BRIDGE.published_url.replace(/^https:\/\//, "")}</a>.{" "}
        <code>SHA256SUMS</code> has SHA-256 <code>{BRIDGE.published_index_sha256}</code>.
      </p>
    </section>
  );
}

function BlockCell({ block }: { block: SnapshotBlock | undefined }) {
  if (!block) return <span className="muted">-</span>;
  return (
    <>
      {block.number.toLocaleString("en-US")}
      <br />
      <span className="small">{formatUtc(block.time)}</span>
    </>
  );
}

/** The snapshot moments, each chain's blocks for them, and what turns a balance into a row. */
function Amounts() {
  const { blocks, orphaned_one_deliveries: orphaned } = BRIDGE.snapshots;
  const harmony = blocks.harmony!;
  const chains = snapshotChains();
  const oneHolders = joinList(remoteHoldersAt("rollback").map((c) => holderChainName(c)));
  const delivered = joinList(
    chains.filter((c) => orphaned[c]).map((c, i) => `${orphaned[c].toLocaleString("en-US")}${i === 0 ? " transfers" : ""} to ${holderChainName(c)}`),
  );
  return (
    <section className="card" id="amounts">
      <h2>How the amounts were computed</h2>
      <p>
        Each row starts from the address's balance of a bridged token at one moment. It is then adjusted for bridge transfers
        that had not completed, and reduced in proportion where the escrow held less than the eligible balances.
      </p>

      <div className="block">
        <h3>Two moments</h3>
        <ul className="notes">
          <li>
            <strong>The cutoff, {formatMoment(harmony.cutoff!.time)}.</strong> The same cutoff as the ONE migration. Tokens
            bridged to Harmony from another chain, such as USDC, ETH, or BNB, count as held on Harmony at its block{" "}
            {harmony.cutoff!.number.toLocaleString("en-US")}.
          </li>
          {oneHolders && (
            <li>
              <strong>Before the rollback, {formatMoment(harmony.rollback!.time)}.</strong> In August 2026 Harmony was rolled back
              to its block {harmony.rollback!.number.toLocaleString("en-US")}, produced at this moment, and the blocks after it
              were abandoned. LayerZero had already delivered ONE that the abandoned blocks sent
              {delivered ? `: ${delivered}` : ""}. Bridged ONE on {oneHolders} therefore counts as held at this moment, which
              keeps that ONE, and anything traded from it, out of the balances. It is paid as ERC-20 ONE on Ethereum.
            </li>
          )}
        </ul>
      </div>

      <div className="block">
        <h3>Blocks on each chain</h3>
        <p className="small">
          A chain's block for a moment is its last block at or before that time, so its timestamp can be a second or two
          earlier. Harmony's two blocks are the migration's own. The other chains' blocks at each moment also mark which bridge
          transfers were still on their way. Each escrow's balance, the collateral, was read at the block in the last column.
        </p>
        <div className="table-scroll">
          <table className="bridge-snapshots">
            <thead>
              <tr>
                <th>Chain</th>
                <th>Balances counted</th>
                <th className="num">At the cutoff</th>
                <th className="num">Before the rollback</th>
                <th className="num">Escrow read</th>
              </tr>
            </thead>
            <tbody>
              {chains.map((chain) => (
                <tr key={chain}>
                  <td>{holderChainName(chain)}</td>
                  <td>{countedOn(chain) ?? <span className="muted">none</span>}</td>
                  <td className="num">
                    <BlockCell block={blocks[chain]?.cutoff} />
                  </td>
                  <td className="num">
                    <BlockCell block={blocks[chain]?.rollback} />
                  </td>
                  <td className="num">
                    <BlockCell block={blocks[chain]?.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="block">
        <h3>Adjustments</h3>
        <ul className="notes">
          <li>
            A bridge transfer that never completed is credited to whoever it was owed to. Tokens sent from Harmony that were never
            paid out on the other chain go back to the Harmony sender. Deposits on the other chain that never reached Harmony go to
            the depositor, and a delivery that failed on arrival goes to its recipient.
          </li>
          <li>
            If an escrow paid out for a Harmony transfer that the rollback undid, the payout is taken off the recipient's balance,
            because the rollback gave the tokens back on Harmony.
          </li>
          <li>
            For bridged ONE, ONE that Harmony bridged out after the moment is credited to its recipient, and bridged ONE sent back
            to Harmony and released there after the moment is taken off its sender.
          </li>
          <li>No balance goes below zero.</li>
        </ul>
      </div>

      <div className="block">
        <h3>Scaling and exclusions</h3>
        <ul className="notes">
          <li>
            Where an escrow held less than the eligible balances, every allocation from it is reduced in the same proportion,
            rounded down. For ONE, the collateral is the ONE locked in Harmony's bridge contracts at the cutoff. There is no
            minimum amount.
          </li>
          <li>
            Bridge contracts, custody multisigs, and other system addresses are left out, as are addresses the migration does not
            issue to, such as reported theft and burn addresses. Contracts such as 1wallets, and multisigs that held on a chain
            other than the claim chain, are held for review and are not in these lists.
          </li>
        </ul>
      </div>
    </section>
  );
}

export function BridgePage() {
  const ledger = useLedger();
  const signer = useSigner(ledger);
  const [input, setInput] = useState(addressFromUrl);
  const [lookup, setLookup] = useState<Address | null>(() => parseAddress(addressFromUrl()));
  const [inputError, setInputError] = useState<string | null>(() =>
    addressFromUrl() && !parseAddress(addressFromUrl()) ? "That is not a valid address." : null,
  );
  const autoFilled = useRef<string | null>(null);

  const show = (address: Address) => {
    setInput(address);
    setInputError(null);
    setLookup(address);
    setAddressInUrl(address);
  };

  useEffect(() => {
    document.title = "Bridge claims · Harmony migration";
  }, []);

  // Look up the connected account unless the page shows an address someone entered.
  useEffect(() => {
    if (!signer.address) return;
    const shown = addressFromUrl();
    if (shown && shown !== autoFilled.current) return;
    autoFilled.current = signer.address;
    show(signer.address);
  }, [signer.address]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseAddress(input);
    if (!parsed) {
      setInputError("Enter a 0x… hex address or a one1… address.");
      return;
    }
    show(parsed);
  };

  return (
    <div className="page">
      <Nav current="/bridge" />
      <header className="header">
        <h1>Bridge claims</h1>
        <p className="sub">
          The collateral of Harmony's LayerZero bridge goes back to the holders of bridged tokens, on Ethereum, BNB Chain,
          Arbitrum, Base, and Linea. Look up an address, then claim its assets on each chain.
        </p>
      </header>

      <WalletCard
        ledger={ledger}
        signer={signer}
        onSelect={(address) => {
          autoFilled.current = address;
          show(address);
        }}
      />

      <section className="card">
        <form className="lookup" onSubmit={onSubmit}>
          <label htmlFor="bridge-address">Address (0x… or one1…)</label>
          <div className="row">
            <input
              id="bridge-address"
              name="address"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x… or one1…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button type="submit">Look up</button>
          </div>
          {inputError && <p className="error">{inputError}</p>}
        </form>
        {!lookup && !inputError && <p className="small">Connect a wallet or enter an address to see its claims.</p>}
      </section>

      {lookup && <Results key={lookup} account={lookup} signer={signer} />}

      <About />
      <Amounts />
    </div>
  );
}
