import { createWalletClient, custom, getAddress, isAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { harmonyOne } from "viem/chains";

/** An address a WalletConnect session shares, and the chains the wallet shares it on. */
export interface SessionAccount {
  address: Address;
  chainIds: number[];
}

export type SessionNamespaces = Record<string, { accounts?: readonly string[] } | undefined>;

/** The request method of a WalletConnect session, which takes the CAIP-2 chain to send on. */
export interface SessionRequester {
  request(args: { method: string; params?: unknown }, chain?: string): Promise<unknown>;
}

/**
 * Every EVM address in a WalletConnect session, once each, in the session's
 * order. The dapp cannot ask for a derivation path: the wallet picks the key
 * behind each chain's account. A wallet that keeps Harmony accounts on
 * Harmony's path (44'/1023') can share one for eip155:1666600000 and a
 * different, 44'/60' one for Ethereum.
 */
export function sessionAccounts(namespaces: SessionNamespaces | undefined): SessionAccount[] {
  const found = new Map<Address, SessionAccount>();
  for (const [key, namespace] of Object.entries(namespaces ?? {})) {
    if (key !== "eip155" && !key.startsWith("eip155:")) continue;
    for (const id of namespace?.accounts ?? []) {
      const [ns, reference, raw] = id.split(":");
      const chainId = Number(reference);
      if (ns !== "eip155" || !/^[1-9]\d*$/.test(reference ?? "") || !Number.isSafeInteger(chainId)) continue;
      if (!raw || !isAddress(raw, { strict: false })) continue;
      const address = getAddress(raw);
      const entry = found.get(address) ?? { address, chainIds: [] };
      if (!entry.chainIds.includes(chainId)) entry.chainIds.push(chainId);
      found.set(address, entry);
    }
  }
  return [...found.values()];
}

/**
 * The account to act for: the user's choice while the session still shares
 * it, else the first one shared on Harmony (claims, confirmations and vault
 * shares belong to the address that held ONE there), else the wallet's
 * current one.
 */
export function chooseAccount(
  accounts: SessionAccount[],
  chosen: Address | null,
  current: Address | undefined,
): SessionAccount | undefined {
  return (
    accounts.find((a) => a.address === chosen) ??
    accounts.find((a) => a.chainIds.includes(harmonyOne.id)) ??
    accounts.find((a) => a.address === current) ??
    accounts[0]
  );
}

/** The chain to send a request for `account` on: the session's current one if it shares the account there. */
export function requestChainId(account: SessionAccount, current: number | undefined): number {
  return current !== undefined && account.chainIds.includes(current) ? current : account.chainIds[0];
}

/** personal_sign by `account` over a WalletConnect session, on a chain the session shares it on. */
export function signWithSession(
  session: SessionRequester,
  account: SessionAccount,
  currentChainId: number | undefined,
  message: string,
): Promise<Hex> {
  const chain = `eip155:${requestChainId(account, currentChainId)}`;
  const client = createWalletClient({
    transport: custom({ request: ({ method, params }) => session.request({ method, params }, chain) }, { retryCount: 0 }),
  });
  return client.signMessage({ account: account.address, message });
}

/** Throws unless `signature` is `address`'s personal_sign of `message`, which is all the server accepts. */
export async function checkSigner(message: string, signature: Hex, address: Address): Promise<void> {
  const signer = await recoverMessageAddress({ message, signature }).catch(() => null);
  if (signer?.toLowerCase() === address.toLowerCase()) return;
  throw new Error(
    signer
      ? `The wallet signed with ${signer}, not ${address}. Open the account with ${address} in the wallet, then try again.`
      : `The wallet returned a signature that is not from ${address}.`,
  );
}
