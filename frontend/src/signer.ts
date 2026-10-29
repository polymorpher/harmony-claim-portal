import { type SignatureScheme } from "@hcp/shared";
import { recoverTransactionAddress, serializeTransaction, type Address, type Hex, type TransactionSerializableEIP1559 } from "viem";
import { getAccount, sendTransaction, switchChain } from "wagmi/actions";
import { chainById, publicClient } from "./chains";
import { LedgerError } from "./ledger/transport";
import type { LedgerSession } from "./ledger/useLedger";
import { useWallet, walletSendBlocked } from "./useWallet";
import { wagmiConfig } from "./wagmi";

export interface ChainCall {
  chainId: number;
  to: Address;
  data: Hex;
}

export interface Signer {
  address: Address | null;
  via: "wallet" | "ledger" | null;
  /** False for the Harmony Ledger apps, which sign messages but no transaction outside Harmony. */
  canSend: boolean;
  /** Chains a WalletConnect session shares `address` on, and so the only ones it can send on; null when not limited. */
  chainIds: number[] | null;
  /** Signs and broadcasts on `chainId`; resolves with the transaction hash. */
  send(call: ChainCall): Promise<Hex>;
  /** Signs a message. Harmony Ledger apps can do this even when they cannot send a transaction. */
  signMessage(message: string): Promise<{ signature: Hex; scheme: SignatureScheme }>;
}

const GAS_HEADROOM_PERCENT = 120n;

type ConfigChainId = (typeof wagmiConfig.chains)[number]["id"];

function configChain(chainId: number): ConfigChainId {
  if (!wagmiConfig.chains.some((c) => c.id === chainId)) throw new Error(`Unsupported chain ${chainId}`);
  return chainId as ConfigChainId;
}

/** The connected account, preferring a Ledger over USB like the confirm page does. */
export function useSigner(ledger: LedgerSession): Signer {
  const wallet = useWallet();
  const walletAddress = wallet.address;
  const ledgerAccount = ledger.account;

  if (ledgerAccount && ledger.app) {
    return {
      address: ledgerAccount.address,
      via: "ledger",
      canSend: ledger.canSignTransactions,
      chainIds: null,
      signMessage: (message) => ledger.sign(message, ledgerAccount.address),
      async send({ chainId, to, data }) {
        const client = publicClient(chainId);
        const from = ledgerAccount.address;
        const prepared = await client.prepareTransactionRequest({ account: from, to, data, chain: chainById(chainId), type: "eip1559" });
        const tx: TransactionSerializableEIP1559 = {
          type: "eip1559",
          chainId,
          nonce: prepared.nonce,
          gas: (prepared.gas * GAS_HEADROOM_PERCENT) / 100n,
          maxFeePerGas: prepared.maxFeePerGas,
          maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
          to,
          value: 0n,
          data,
        };
        const signature = await ledger.signTransaction(serializeTransaction(tx), from);
        const signed = serializeTransaction(tx, signature);
        const signer = await recoverTransactionAddress({ serializedTransaction: signed });
        if (signer.toLowerCase() !== from.toLowerCase()) {
          throw new LedgerError("The Ledger signed with a different address. Check that the same Ledger and app are still open.");
        }
        return client.sendRawTransaction({ serializedTransaction: signed });
      },
    };
  }

  if (walletAddress) {
    return {
      address: walletAddress,
      via: "wallet",
      canSend: true,
      chainIds: wallet.chainIds,
      async signMessage(message) {
        return { signature: await wallet.signMessage(message), scheme: "personal_sign" };
      },
      async send({ chainId, to, data }) {
        const target = configChain(chainId);
        const blocked = walletSendBlocked(wallet, target);
        if (blocked) throw new Error(blocked);
        if (getAccount(wagmiConfig).chainId !== target) await switchChain(wagmiConfig, { chainId: target });
        return sendTransaction(wagmiConfig, { account: walletAddress, to, data, chainId: target });
      },
    };
  }

  return {
    address: null,
    via: null,
    canSend: false,
    chainIds: null,
    async send() {
      throw new Error("Connect a wallet first.");
    },
    async signMessage() {
      throw new Error("Connect a wallet first.");
    },
  };
}
