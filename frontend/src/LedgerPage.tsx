import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Nav } from "./Nav";

const TOOL = "/ledger-key-tool.html";
const COLEMAN = "https://github.com/iancoleman/bip39/releases/tag/0.5.6";
const HMY = "https://github.com/harmony-one/go-sdk/releases";

async function toolHash(): Promise<string | null> {
  const res = await fetch(`${TOOL}.sha256`, { cache: "no-cache" });
  if (!res.ok) return null;
  const hash = (await res.text()).trim().split(/\s+/)[0];
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

/** What a holder can do when the address they use with a Ledger's Harmony app, or another wallet on Harmony's path, cannot sign on Ethereum. */
export function LedgerPage() {
  const hash = useQuery({ queryKey: ["key-tool-hash"], queryFn: toolHash, staleTime: Infinity, retry: 1 });
  useEffect(() => {
    document.title = "Harmony addresses on a Ledger · Harmony migration";
  }, []);

  return (
    <div className="page">
      <Nav current={null} />
      <header className="header">
        <div>
          <h1>Harmony addresses on a Ledger</h1>
          <p className="sub">
            Your ONE and vault shares on Ethereum are at the same address you used on Harmony. If that address is on a
            Ledger's Harmony app, the Ledger can show it but cannot move what it holds on Ethereum. Other wallets that keep
            Harmony addresses on Harmony's path can have the same problem.
          </p>
        </div>
      </header>

      <section className="card">
        <h2>Why the Ledger cannot send</h2>
        <ul className="notes">
          <li>
            The Harmony apps derive addresses on Harmony's path, <code>m/44'/1023'/0'/0/N</code>. The 2025 Harmony app is
            Ledger's Ethereum app built for the Harmony network, and it refuses transactions for any other network. The older
            Harmony One app signs only Harmony transactions.
          </li>
          <li>
            Ledger's Ethereum app does sign Ethereum transactions, but it is limited to Ethereum's own paths (
            <code>m/44'/60'</code>), so it cannot use the Harmony address.
          </li>
          <li>
            The ONE token and the governor vaults only act on a transaction sent by the address itself. There is no signed
            approval that someone else could submit for you.
          </li>
          <li>
            Confirming activity on <a href="/confirm">the Confirm page</a> still works with both Harmony apps: it only signs
            a message.
          </li>
        </ul>
      </section>

      <section className="card">
        <h2>Other wallets on Harmony's path</h2>
        <p>
          Some other wallets, hardware wallets among them, also keep Harmony addresses on <code>m/44'/1023'/0'/0/N</code>{" "}
          and Ethereum addresses on Ethereum's path. Such a wallet may give this site only its Ethereum address, and on
          Ethereum it signs with that address, not the Harmony one. Try these first:
        </p>
        <ul className="notes">
          <li>
            Connect over WalletConnect and choose the Harmony address if the wallet shares it. If it does not, select the
            Harmony network or the Harmony account in the wallet, then disconnect and connect again.
          </li>
          <li>Ask the wallet's support whether it can sign on Ethereum for the Harmony address.</li>
        </ul>
        <p>
          The key tool below also works for these wallets if they use a standard 12- or 24-word recovery phrase (BIP-39)
          on that path, but only use it once everything else has failed.
        </p>
      </section>

      <section className="card">
        <h2>What you can do</h2>
        <p>
          <strong>Only if all else fails</strong>, recover the address's private key from the recovery phrase, on a computer
          that is offline, and import it into an Ethereum wallet such as MetaMask. That wallet can then confirm activity,
          withdraw your vault shares, send your ONE to an address you control (for example an account of the Ethereum app on
          the same Ledger), and, if you are a vault's governor, hand the governor role to that address.
        </p>
        <div className="banner warn">
          <strong>The recovery phrase controls everything in the wallet, on every network.</strong> Never type it into a
          website, a chat or an email, and never give it to anyone: nobody from Harmony or this portal will ask for it. Type
          it only into an offline tool on a computer you trust. Once it has been typed into a computer, treat it as exposed:
          after moving these funds, move everything else in the wallet to a new recovery phrase.
        </div>
      </section>

      <section className="card">
        <h2>Our offline key tool</h2>
        <p>
          A single HTML file that derives the keys of addresses on Harmony's path from the recovery phrase and, if you set
          one, the wallet's passphrase. It runs entirely in your browser. Its security policy blocks every network request, so it
          cannot send anything anywhere, even if the computer is online.
        </p>
        <ol className="steps">
          <li>
            <a className="button" href={TOOL} download>
              Download ledger-key-tool.html
            </a>
          </li>
          <li>
            Check the file before you open it. Its SHA-256 must be{" "}
            {hash.data ? <code>{hash.data}</code> : hash.isLoading ? "…" : "published with the site (not available here)"}:
            <pre className="cmd">{`shasum -a 256 ledger-key-tool.html               # macOS, Linux
certutil -hashfile ledger-key-tool.html SHA256    # Windows`}</pre>
          </li>
          <li>Disconnect the computer from the internet, then open the file in a browser.</li>
          <li>
            Type the recovery phrase, the passphrase if you use one, and optionally your Harmony address. Find your address
            in the list (the older Harmony app always uses #0) and show its private key.
          </li>
          <li>Import the key into MetaMask or another Ethereum wallet. It shows the same 0x address.</li>
          <li>
            Back online, send a little ETH to that address for gas, then use <a href="/vault">Governor Vaults</a> with that
            wallet to withdraw your shares, and send the ONE to your new address.
          </li>
        </ol>
      </section>

      <section className="card">
        <h2>Other offline tools</h2>
        <ul className="notes">
          <li>
            <a href={COLEMAN} target="_blank" rel="noreferrer">
              Ian Coleman's BIP39 tool
            </a>
            : download <code>bip39-standalone.html</code> from the release (it is signed) and open it offline. Choose coin{" "}
            <em>ETH - Ethereum</em>, the <em>BIP32</em> tab, client <em>Custom derivation path</em>, and enter{" "}
            <code>m/44'/1023'/0'/0</code>. The table lists each address with its private key.
          </li>
          <li>
            <a href={HMY} target="_blank" rel="noreferrer">
              Harmony's command-line wallet, hmy
            </a>
            : <code>hmy keys recover-from-mnemonic NAME --index N</code>, then{" "}
            <code>hmy keys export-private-key one1…</code>. It cannot use a Ledger passphrase.
          </li>
        </ul>
      </section>
    </div>
  );
}
