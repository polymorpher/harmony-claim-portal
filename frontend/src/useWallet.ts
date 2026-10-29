import { useEffect, useState, useSyncExternalStore } from "react";
import type { Address, Hex } from "viem";
import { useAccount, useSignMessage, type Connector } from "wagmi";
import { wagmiConfig } from "./wagmi";
import {
  checkSigner,
  chooseAccount,
  sessionAccounts,
  signWithSession,
  type SessionAccount,
  type SessionNamespaces,
  type SessionRequester,
} from "./walletconnect";

/** The parts of @walletconnect/ethereum-provider used here; it is not a direct dependency. */
interface WalletConnectProvider {
  session?: { namespaces: SessionNamespaces };
  signer: SessionRequester;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

interface SessionState {
  provider: WalletConnectProvider | null;
  accounts: SessionAccount[];
}

const SESSION_EVENTS = ["session_update", "accountsChanged", "chainChanged"];

function useWalletConnectSession(connector: Connector | undefined): SessionState | null {
  const [state, setState] = useState<SessionState | null>(null);
  useEffect(() => {
    setState(null);
    if (connector?.type !== "walletConnect") return;
    let provider: WalletConnectProvider | null = null;
    let stopped = false;
    const refresh = () => {
      if (!stopped) setState({ provider, accounts: sessionAccounts(provider?.session?.namespaces) });
    };
    connector.getProvider().then(
      (found) => {
        if (stopped) return;
        provider = found as WalletConnectProvider;
        for (const event of SESSION_EVENTS) provider.on(event, refresh);
        refresh();
      },
      refresh,
    );
    return () => {
      stopped = true;
      if (provider) for (const event of SESSION_EVENTS) provider.removeListener(event, refresh);
    };
  }, [connector]);
  return state;
}

// The address picked among a session's accounts, kept across client-side navigation.
let chosen: Address | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getChosen(): Address | null {
  return chosen;
}

function choose(address: Address | null) {
  chosen = address;
  listeners.forEach((l) => l());
}

export function networkNames(chainIds: readonly number[]): string {
  return chainIds.map((id) => wagmiConfig.chains.find((c) => c.id === id)?.name ?? `chain ${id}`).join(", ");
}

export interface Wallet {
  /** The address pages act for, once a browser wallet or WalletConnect is connected. */
  address: Address | undefined;
  /** Every address a WalletConnect session shares; empty for browser wallets. */
  accounts: SessionAccount[];
  /** Chains a WalletConnect session shares `address` on; null when the wallet is not limited to some. */
  chainIds: number[] | null;
  select(address: Address): void;
  /** personal_sign by `address`, checked to recover to it. */
  signMessage(message: string): Promise<Hex>;
}

/**
 * The connected wallet. Over WalletConnect it can act for any address the
 * session shares, on any chain, not only the accounts of the session's
 * current chain that wagmi exposes, so a Harmony account the wallet shares
 * only for Harmony can sign too.
 */
export function useWallet(): Wallet {
  const { address: current, chainId, connector, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const session = useWalletConnectSession(isConnected ? connector : undefined);
  const picked = useSyncExternalStore(subscribe, getChosen, getChosen);

  useEffect(() => {
    if (!isConnected) choose(null);
  }, [isConnected]);

  const loading = isConnected && connector?.type === "walletConnect" && session === null;
  const account = session ? chooseAccount(session.accounts, picked, current) : undefined;
  const address = isConnected && !loading ? (account?.address ?? current) : undefined;

  async function signMessage(message: string): Promise<Hex> {
    if (!address) throw new Error("Connect a wallet first.");
    const signature =
      session?.provider && account
        ? await signWithSession(session.provider.signer, account, chainId, message)
        : await signMessageAsync({ account: address, message });
    await checkSigner(message, signature, address);
    return signature;
  }

  return {
    address,
    accounts: session?.accounts ?? [],
    chainIds: account?.chainIds ?? null,
    select: choose,
    signMessage,
  };
}

/** Why `wallet` cannot send transactions on `chainId` from its address, or null if it can. */
export function walletSendBlocked(wallet: Pick<Wallet, "chainIds">, chainId: number): string | null {
  if (!wallet.chainIds || wallet.chainIds.includes(chainId)) return null;
  return `Over WalletConnect, your wallet shares this address only on ${networkNames(wallet.chainIds)}, so it cannot send transactions on ${networkNames([chainId])} from it. Choose an address the wallet shares there.`;
}
