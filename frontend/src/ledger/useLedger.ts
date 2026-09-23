import { useEffect, useRef, useState } from "react";
import { harmonyLedgerTx, type SignatureScheme } from "@hcp/shared";
import { keccak256, recoverAddress, recoverMessageAddress, stringToBytes, type Address, type Hex } from "viem";
import {
  detectApp,
  ethGetAddress,
  ethSignPersonalMessage,
  LEGACY_HARMONY_PATH,
  ledgerErrorText,
  legacyGetAddress,
  legacySignTx,
  PATH_SCHEMES,
  type LedgerApp,
  type PathScheme,
} from "./apps";
import { LedgerError, WebHidLedger, webHidSupported } from "./transport";

export interface LedgerAccount {
  path: string;
  address: Address;
}

export interface LedgerSignature {
  signature: Hex;
  scheme: SignatureScheme;
}

const ACCOUNTS_SHOWN = 5;

async function readAccounts(ledger: WebHidLedger, app: LedgerApp, scheme: PathScheme): Promise<LedgerAccount[]> {
  if (app.kind === "harmony-legacy") {
    return [{ path: LEGACY_HARMONY_PATH, address: await legacyGetAddress(ledger.apdu) }];
  }
  const accounts: LedgerAccount[] = [];
  for (let i = 0; i < ACCOUNTS_SHOWN; i++) {
    const path = PATH_SCHEMES[scheme].path(i);
    accounts.push({ path, address: await ethGetAddress(ledger.apdu, path) });
  }
  return accounts;
}

export function useLedger() {
  const device = useRef<WebHidLedger | null>(null);
  const [app, setApp] = useState<LedgerApp | null>(null);
  const [scheme, setScheme] = useState<PathScheme>("harmony");
  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => void device.current?.close(), []);

  function reset() {
    device.current = null;
    setApp(null);
    setAccounts([]);
    setSelected(0);
  }

  async function connect() {
    setError(null);
    setBusy(true);
    try {
      await device.current?.close();
      reset();
      const ledger = await WebHidLedger.request(() => {
        reset();
        setError("The Ledger was disconnected. Connect it again.");
      });
      device.current = ledger;
      const found = await detectApp(ledger.apdu);
      const firstScheme: PathScheme = found.kind === "ethereum" ? "ledger-live" : "harmony";
      const list = await readAccounts(ledger, found, firstScheme);
      setApp(found);
      setScheme(firstScheme);
      setAccounts(list);
      setSelected(0);
    } catch (err) {
      await device.current?.close();
      reset();
      setError(ledgerErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    await device.current?.close();
    reset();
    setError(null);
  }

  async function changeScheme(next: PathScheme) {
    const ledger = device.current;
    if (!ledger || !app || app.kind !== "ethereum") return;
    setError(null);
    setBusy(true);
    try {
      setAccounts(await readAccounts(ledger, app, next));
      setScheme(next);
      setSelected(0);
    } catch (err) {
      setError(ledgerErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  /** Signs the confirmation message with the selected account and checks the signer locally. */
  async function sign(message: string, expected: string): Promise<LedgerSignature> {
    const ledger = device.current;
    const account = accounts[selected];
    if (!ledger || !app || !account) throw new LedgerError("Connect the Ledger first.");
    if (account.address.toLowerCase() !== expected.toLowerCase()) {
      throw new LedgerError("The selected Ledger address changed. Try again.");
    }
    const legacy = app.kind === "harmony-legacy";
    const payload = legacy ? harmonyLedgerTx(account.address, message) : stringToBytes(message);
    let signature: Hex;
    try {
      signature = legacy
        ? await legacySignTx(ledger.apdu, payload)
        : await ethSignPersonalMessage(ledger.apdu, account.path, payload);
    } catch (err) {
      throw new LedgerError(ledgerErrorText(err));
    }
    const signer = await (legacy
      ? recoverAddress({ hash: keccak256(payload), signature })
      : recoverMessageAddress({ message, signature })
    ).catch(() => null);
    if (signer?.toLowerCase() !== account.address.toLowerCase()) {
      throw new LedgerError("The Ledger signed with a different address. Check that the same Ledger and app are still open.");
    }
    return { signature, scheme: legacy ? "harmony_ledger_tx" : "personal_sign" };
  }

  return {
    supported: webHidSupported(),
    app,
    scheme,
    accounts,
    selected,
    account: accounts[selected] ?? null,
    busy,
    error,
    connect,
    disconnect,
    changeScheme,
    select: setSelected,
    sign,
  };
}

export type LedgerSession = ReturnType<typeof useLedger>;
