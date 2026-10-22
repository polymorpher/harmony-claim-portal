import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { encodeFunctionData, erc20Abi, formatUnits, type Address, type Hex } from "viem";
import { hexToBech32, normalizeVaultName, type VaultMetadataResponse } from "@hcp/shared";
import { ApiRequestError, createVaultNameChallenge, submitVaultName } from "../api";
import { one } from "../format";
import { transactionErrorText, walletErrorText } from "../wallet";
import { vaultAbi } from "./abi";
import type { AgreementStatus } from "./agreements";
import type { Catalog, CatalogVault } from "./catalog";
import { explorer, publicClient, type VaultDetail } from "./chain";
import { Dialog } from "./Dialog";
import { parseAddress, parseFeePercent, parseOne, percentFromBps } from "./format";
import { hasAcceptedRelease, recordRelease, RELEASE_TEXT } from "./release";
import type { ContractCall, VaultSigner } from "./useVaultSigner";

type TxState =
  | { phase: "idle" }
  | { phase: "wallet"; label: string }
  | { phase: "pending"; label: string; hash: Hex }
  | { phase: "done"; label: string; hash: Hex }
  | { phase: "error"; label: string; message: string };

function useTx(signer: VaultSigner, chainId: number, onDone: () => void) {
  const [state, setState] = useState<TxState>({ phase: "idle" });
  const busy = state.phase === "wallet" || state.phase === "pending";

  async function run(label: string, call: ContractCall): Promise<boolean> {
    setState({ phase: "wallet", label });
    try {
      const hash = await signer.send(call);
      setState({ phase: "pending", label, hash });
      const receipt = await publicClient(chainId).waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The transaction failed on chain.");
      setState({ phase: "done", label, hash });
      onDone();
      return true;
    } catch (err) {
      setState({ phase: "error", label, message: transactionErrorText(err) });
      onDone();
      return false;
    }
  }

  return { state, busy, run };
}

type Tx = ReturnType<typeof useTx>;

function TxStatus({ tx, chainId, via }: { tx: Tx; chainId: number; via: VaultSigner["via"] }) {
  const s = tx.state;
  const link = (hash: Hex, text: string) => (
    <a href={`${explorer(chainId)}/tx/${hash}`} target="_blank" rel="noreferrer">
      {text}
    </a>
  );
  switch (s.phase) {
    case "idle":
      return null;
    case "wallet":
      return <p className="muted">{s.label}: confirm in your {via === "ledger" ? "Ledger" : "wallet"}…</p>;
    case "pending":
      return <p className="muted">{s.label}: waiting for the transaction to be included ({link(s.hash, "view")})…</p>;
    case "done":
      return <p className="ok-text">{s.label}: done ({link(s.hash, "view transaction")}).</p>;
    case "error":
      return <p className="error">{s.label}: {s.message}</p>;
  }
}

function lost(address: Address, entry: CatalogVault, catalog: Catalog): boolean {
  return [entry.vault, catalog.token].some((a) => a.toLowerCase() === address.toLowerCase());
}

function WithdrawForm({ catalog, entry, held, signer, tx }: { catalog: Catalog; entry: CatalogVault; held: bigint; signer: VaultSigner; tx: Tx }) {
  const me = signer.address!;
  const [amount, setAmount] = useState("");
  const [elsewhere, setElsewhere] = useState(false);
  const [recipientText, setRecipientText] = useState("");
  const [step, setStep] = useState<"release" | "recipient" | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = parseOne(amount);
  const recipient = elsewhere ? parseAddress(recipientText) : me;
  const toOther = recipient !== null && recipient.toLowerCase() !== me.toLowerCase();

  function send() {
    setStep(null);
    if (value === null || recipient === null) return;
    const data = encodeFunctionData({ abi: vaultAbi, functionName: "withdraw", args: [value, recipient] });
    void tx.run("Withdraw", { to: entry.vault, data }).then((ok) => ok && setAmount(""));
  }

  function proceed(after: "submit" | "release" | "recipient") {
    if (after === "submit" && !hasAcceptedRelease(me)) {
      setAgreed(false);
      setStep("release");
    } else if (after !== "recipient" && toOther) {
      setChecked(false);
      setStep("recipient");
    } else {
      send();
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const problem =
      value === null
        ? "Enter an amount of ONE."
        : value > held
          ? "That is more than your balance in this vault."
          : recipient === null
            ? "Enter the address to receive the ONE, as 0x… or one1…."
            : lost(recipient, entry, catalog)
              ? "ONE sent to that address would be lost. Choose another address."
              : null;
    setError(problem);
    if (!problem) proceed("submit");
  }

  return (
    <form className="action" onSubmit={submit}>
      <h3>Withdraw</h3>
      <p className="small">Your balance in this vault: {one(held.toString(), 6)} ONE.</p>
      <label htmlFor="withdraw-amount">Amount (ONE)</label>
      <div className="row">
        <input id="withdraw-amount" inputMode="decimal" autoComplete="off" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button type="button" className="ghost" disabled={held === 0n} onClick={() => setAmount(formatUnits(held, 18))}>
          Max
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={elsewhere} onChange={(e) => setElsewhere(e.target.checked)} /> Send to a different address
      </label>
      {elsewhere ? (
        <>
          <label htmlFor="withdraw-to">Recipient (0x… or one1…)</label>
          <input id="withdraw-to" autoComplete="off" spellCheck={false} placeholder="0x… or one1…" value={recipientText} onChange={(e) => setRecipientText(e.target.value)} />
        </>
      ) : (
        <p className="small">
          The ONE goes to the connected address, <code>{me}</code>.
        </p>
      )}
      <p>
        <button type="submit" disabled={tx.busy || held === 0n}>
          Withdraw
        </button>
      </p>
      {error && <p className="error">{error}</p>}

      <Dialog open={step === "release"} title="Before your first withdrawal" onCancel={() => setStep(null)}>
        <blockquote className="release">{RELEASE_TEXT}</blockquote>
        <label className="check">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> I agree, as the holder of{" "}
          <code>{me}</code>.
        </label>
        <p className="small">This browser remembers your answer for this address.</p>
        <div className="dialog-buttons">
          <button type="button" className="ghost" onClick={() => setStep(null)}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!agreed}
            onClick={() => {
              recordRelease(me);
              proceed("release");
            }}
          >
            Agree and continue
          </button>
        </div>
      </Dialog>

      <Dialog open={step === "recipient"} title="Withdraw to a different address" onCancel={() => setStep(null)}>
        {recipient && value !== null && (
          <>
            <dl className="addr">
              <dt>Amount</dt>
              <dd>{one(value.toString(), 18)} ONE</dd>
              <dt>To</dt>
              <dd>
                <code>{recipient}</code>
              </dd>
              <dt>Harmony form</dt>
              <dd>
                <code>{hexToBech32(recipient.toLowerCase())}</code>
              </dd>
            </dl>
            <p className="banner warn block">
              The ONE leaves your vault balance and goes to this address on Ethereum, not to <code>{me}</code>. A transfer
              to a wrong address cannot be undone.
            </p>
            <label className="check">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I have checked
              this address and it can receive ERC-20 ONE on Ethereum.
            </label>
          </>
        )}
        <div className="dialog-buttons">
          <button type="button" className="ghost" onClick={() => setStep(null)}>
            Cancel
          </button>
          <button type="button" disabled={!checked} onClick={() => proceed("recipient")}>
            Withdraw to this address
          </button>
        </div>
      </Dialog>
    </form>
  );
}

function DepositForm({ catalog, entry, wallet, signer, tx }: { catalog: Catalog; entry: CatalogVault; wallet: NonNullable<VaultDetail["wallet"]>; signer: VaultSigner; tx: Tx }) {
  const me = signer.address!;
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const value = parseOne(amount);
  const needsApproval = value !== null && wallet.allowance < value;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = value === null ? "Enter an amount of ONE." : value > wallet.tokens ? "That is more ONE than the connected wallet holds." : null;
    setError(problem);
    if (problem || value === null) return;
    if (needsApproval) {
      const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [entry.vault, value] });
      if (!(await tx.run("Approve (step 1 of 2)", { to: catalog.token, data: approve }))) return;
    }
    const deposit = encodeFunctionData({ abi: vaultAbi, functionName: "deposit", args: [value, me] });
    if (await tx.run(needsApproval ? "Deposit (step 2 of 2)" : "Deposit", { to: entry.vault, data: deposit })) setAmount("");
  }

  return (
    <form className="action" onSubmit={(e) => void submit(e)}>
      <h3>Deposit</h3>
      <p className="small">
        ERC-20 ONE in the connected wallet: {one(wallet.tokens.toString(), 6)}. Deposits come from the connected wallet and are
        credited to it.
      </p>
      <label htmlFor="deposit-amount">Amount (ONE)</label>
      <div className="row">
        <input id="deposit-amount" inputMode="decimal" autoComplete="off" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button type="button" className="ghost" disabled={wallet.tokens === 0n} onClick={() => setAmount(formatUnits(wallet.tokens, 18))}>
          Max
        </button>
      </div>
      {needsApproval && <p className="small">This takes two transactions: an approval for exactly this amount, then the deposit.</p>}
      <p>
        <button type="submit" disabled={tx.busy || wallet.tokens === 0n}>
          Deposit
        </button>
      </p>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function GovernorForm({ catalog, entry, detail, commission, tx }: { catalog: Catalog; entry: CatalogVault; detail: VaultDetail; commission: string; tx: Tx }) {
  const [feeText, setFeeText] = useState("");
  const [feeError, setFeeError] = useState<string | null>(null);
  const [nextText, setNextText] = useState("");
  const [nextError, setNextError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [checked, setChecked] = useState(false);
  const feeBps = detail.feeBps ?? 0;
  const next = parseAddress(nextText);

  function setFee(bps: number) {
    const data = encodeFunctionData({ abi: vaultAbi, functionName: "setFeeBps", args: [bps] });
    void tx.run(bps === 0 ? "Return to the Harmony commission" : "Set fee", { to: entry.vault, data }).then((ok) => ok && setFeeText(""));
  }

  function submitFee(e: FormEvent) {
    e.preventDefault();
    const bps = parseFeePercent(feeText);
    setFeeError(bps === null ? "Enter a fee from 0.01 to 100 percent, with at most two decimals." : bps === feeBps ? "That is the current fee." : null);
    if (bps !== null && bps !== feeBps) setFee(bps);
  }

  function submitTransfer(e: FormEvent) {
    e.preventDefault();
    const problem =
      next === null
        ? "Enter the new governor's address, as 0x… or one1…."
        : next.toLowerCase() === detail.governor?.toLowerCase()
          ? "That address is already the governor."
          : lost(next, entry, catalog)
            ? "That address cannot act as governor."
            : null;
    setNextError(problem);
    if (!problem) {
      setChecked(false);
      setConfirming(true);
    }
  }

  function transfer() {
    setConfirming(false);
    if (next === null) return;
    const data = encodeFunctionData({ abi: vaultAbi, functionName: "transferGovernor", args: [next] });
    void tx.run("Transfer governor", { to: entry.vault, data }).then((ok) => ok && setNextText(""));
  }

  return (
    <div className="governor">
      <form className="action" onSubmit={submitFee}>
        <h3>Fee</h3>
        <p className="small">
          {feeBps === 0
            ? `No fee is set on the vault, so the Harmony commission at the cutoff, ${commission}%, applies.`
            : `The vault's fee is ${percentFromBps(feeBps)}%. The Harmony commission at the cutoff was ${commission}%.`}{" "}
          The contract reads a fee of 0 as the Harmony commission, so the lowest fee you can set is 0.01%.
        </p>
        <label htmlFor="fee">New fee (%)</label>
        <div className="row">
          <input id="fee" inputMode="decimal" autoComplete="off" placeholder="e.g. 5" value={feeText} onChange={(e) => setFeeText(e.target.value)} />
          <button type="submit" disabled={tx.busy}>
            Set fee
          </button>
        </div>
        {feeBps !== 0 && (
          <p>
            <button type="button" className="ghost" disabled={tx.busy} onClick={() => setFee(0)}>
              Return to the Harmony commission ({commission}%)
            </button>
          </p>
        )}
        {feeError && <p className="error">{feeError}</p>}
      </form>

      <form className="action" onSubmit={submitTransfer}>
        <h3>Transfer the governor role</h3>
        <p className="small">The new governor alone can then set the fee or transfer the role again.</p>
        <label htmlFor="next-governor">New governor (0x… or one1…)</label>
        <div className="row">
          <input id="next-governor" autoComplete="off" spellCheck={false} placeholder="0x… or one1…" value={nextText} onChange={(e) => setNextText(e.target.value)} />
          <button type="submit" disabled={tx.busy}>
            Transfer
          </button>
        </div>
        {nextError && <p className="error">{nextError}</p>}
        <Dialog open={confirming} title="Transfer the governor role" onCancel={() => setConfirming(false)}>
          {next && (
            <>
              <dl className="addr">
                <dt>New governor</dt>
                <dd>
                  <code>{next}</code>
                </dd>
                <dt>Harmony form</dt>
                <dd>
                  <code>{hexToBech32(next.toLowerCase())}</code>
                </dd>
              </dl>
              <p className="banner warn block">
                You will no longer be able to change this vault's fee or governor. Only the new address can, and only if it can
                send transactions on Ethereum.
              </p>
              <label className="check">
                <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I have checked
                this address and want to hand over the governor role.
              </label>
            </>
          )}
          <div className="dialog-buttons">
            <button type="button" className="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" disabled={!checked} onClick={transfer}>
              Transfer the role
            </button>
          </div>
        </Dialog>
      </form>
    </div>
  );
}

function nameError(err: unknown): string {
  const wallet = walletErrorText(err);
  if (wallet) return wallet;
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "The name could not be saved.";
}

function NameForm({ entry, signer, name }: { entry: CatalogVault; signer: VaultSigner; name: string }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const next = normalizeVaultName(text);
    if (!next) {
      setError("Enter a name of 1 to 80 characters, without a line break.");
      return;
    }
    if (next === name) {
      setError("That is already the vault's name.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const challenge = await createVaultNameChallenge(entry.vault, next);
      const signed = await signer.signMessage(challenge.message);
      const receipt = await submitVaultName({
        vault: entry.vault,
        name: challenge.name,
        nonce: challenge.nonce,
        issuedAt: challenge.issued_at,
        signature: signed.signature,
        signatureScheme: signed.scheme,
      });
      queryClient.setQueryData<VaultMetadataResponse>(["vault-metadata"], (old) => {
        const vaults = (old?.vaults ?? []).filter((row) => row.vault.toLowerCase() !== receipt.vault.toLowerCase());
        vaults.push(receipt);
        return { vaults };
      });
      setText("");
      setSaved(true);
    } catch (err) {
      setError(nameError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="action" onSubmit={(e) => void submit(e)}>
      <h3>Public name</h3>
      <p className="small">
        The name shown on this site is currently {name}. Signing a message changes it. The signature does not send a
        transaction or change the vault's governor, fee, or balances.
      </p>
      <label htmlFor="vault-name">New name</label>
      <div className="row">
        <input
          id="vault-name"
          autoComplete="off"
          spellCheck={false}
          maxLength={80}
          placeholder={name}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={busy || text.trim() === ""}>
          {busy ? "Waiting for signature…" : "Sign and save"}
        </button>
      </div>
      {saved && <p className="ok-text">Saved.</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}

export function VaultActions({
  catalog,
  entry,
  name,
  detail,
  signer,
  isGovernor,
  commission,
  agreement,
  onDone,
}: {
  catalog: Catalog;
  entry: CatalogVault;
  name: string;
  detail: VaultDetail;
  signer: VaultSigner;
  isGovernor: boolean;
  commission: string;
  agreement: AgreementStatus;
  onDone: () => void;
}) {
  const tx = useTx(signer, catalog.chain_id, onDone);
  const governorTx = useTx(signer, catalog.chain_id, onDone);
  const wallet = detail.wallet;
  return (
    <>
      <section className="card">
        <h2>Your position</h2>
        {wallet && (
          <div className="summary">
            <div>
              <span className="label">In this vault</span>
              <span className="big">{one(wallet.held.toString(), 4)} ONE</span>
            </div>
            <div>
              <span className="label">In your wallet</span>
              <span className="big">{one(wallet.tokens.toString(), 4)} ONE</span>
            </div>
          </div>
        )}
        {signer.blockedReason ? (
          <div className="banner warn block">{signer.blockedReason}</div>
        ) : (
          wallet && (
            <div className="actions">
              <WithdrawForm catalog={catalog} entry={entry} held={wallet.held} signer={signer} tx={tx} />
              <DepositForm catalog={catalog} entry={entry} wallet={wallet} signer={signer} tx={tx} />
            </div>
          )
        )}
        <TxStatus tx={tx} chainId={catalog.chain_id} via={signer.via} />
      </section>
      {isGovernor && (
        <section className="card">
          <h2>Governor</h2>
          <p className="small">The connected address is this vault's governor.</p>
          {agreement.state === "unsigned" && agreement.url && (
            <div className="banner warn">
              The governor agreement for this validator is not signed yet.{" "}
              <a href={agreement.url} target="_blank" rel="noreferrer">
                Open it to sign
              </a>{" "}
              with the validator's wallet on Base.
            </div>
          )}
          <NameForm entry={entry} signer={signer} name={name} />
          {signer.blockedReason ? (
            <div className="banner warn">{signer.blockedReason}</div>
          ) : (
            <GovernorForm catalog={catalog} entry={entry} detail={detail} commission={commission} tx={governorTx} />
          )}
          <TxStatus tx={governorTx} chainId={catalog.chain_id} via={signer.via} />
        </section>
      )}
    </>
  );
}
