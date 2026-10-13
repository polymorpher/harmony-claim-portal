import { hexToBech32 } from "@hcp/shared";
import { PATH_SCHEMES, type LedgerAppKind, type PathScheme } from "./apps";
import type { LedgerSession } from "./useLedger";

export const LEDGER_APP_LABEL: Record<LedgerAppKind, string> = {
  harmony: "Harmony app",
  "harmony-legacy": "older Harmony app",
  ethereum: "Ethereum app",
};

const ETHEREUM_SCHEMES: PathScheme[] = ["ledger-live", "bip44", "legacy"];

export function LedgerAccounts({ ledger, locked }: { ledger: LedgerSession; locked: boolean }) {
  const account = ledger.account;
  if (!ledger.app || !account) return null;
  const disabled = locked || ledger.busy;
  return (
    <div className="ledger-accounts">
      {ledger.app.kind === "ethereum" && (
        <label>
          Account type
          <select
            value={ledger.scheme}
            disabled={disabled}
            onChange={(e) => void ledger.changeScheme(e.target.value as PathScheme)}
          >
            {ETHEREUM_SCHEMES.map((s) => (
              <option key={s} value={s}>
                {PATH_SCHEMES[s].label}
              </option>
            ))}
          </select>
        </label>
      )}
      {ledger.accounts.length > 1 && (
        <label>
          Address on this Ledger
          <select value={ledger.selected} disabled={disabled} onChange={(e) => ledger.select(Number(e.target.value))}>
            {ledger.accounts.map((a, i) => (
              <option key={a.path} value={i}>
                {a.address}
              </option>
            ))}
          </select>
        </label>
      )}
      <dl className="addr">
        <dt>Address</dt>
        <dd>
          <code>{account.address}</code>
        </dd>
        <dt>Harmony form</dt>
        <dd>
          <code>{hexToBech32(account.address.toLowerCase())}</code>
        </dd>
        <dt>Path</dt>
        <dd>
          <code>{account.path}</code>
        </dd>
      </dl>
    </div>
  );
}
