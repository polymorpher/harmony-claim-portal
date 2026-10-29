import { hexToBech32 } from "@hcp/shared";
import type { Address } from "viem";
import { networkNames, type Wallet } from "./useWallet";

/** The addresses a WalletConnect session shares, and which one the page acts for. Nothing for browser wallets. */
export function WalletAccounts({
  wallet,
  locked = false,
  onSelect,
}: {
  wallet: Wallet;
  locked?: boolean;
  onSelect?: (address: Address) => void;
}) {
  const { address, accounts, chainIds } = wallet;
  if (!address || accounts.length === 0) return null;
  return (
    <div className="wallet-accounts">
      {accounts.length > 1 && (
        <label>
          Address shared by the wallet
          <select
            value={address}
            disabled={locked}
            onChange={(e) => {
              const next = e.target.value as Address;
              wallet.select(next);
              onSelect?.(next);
            }}
          >
            {accounts.map((a) => (
              <option key={a.address} value={a.address}>
                {a.address} ({networkNames(a.chainIds)})
              </option>
            ))}
          </select>
        </label>
      )}
      <dl className="addr">
        <dt>Address</dt>
        <dd>
          <code>{address}</code>
        </dd>
        <dt>Harmony form</dt>
        <dd>
          <code>{hexToBech32(address.toLowerCase())}</code>
        </dd>
        {chainIds && (
          <>
            <dt>Shared on</dt>
            <dd>{networkNames(chainIds)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
