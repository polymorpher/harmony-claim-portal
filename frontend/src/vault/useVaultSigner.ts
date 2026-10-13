import { recoverTransactionAddress, serializeTransaction, type Address, type Hex, type TransactionSerializableEIP1559 } from "viem";
import { useAccount } from "wagmi";
import { getAccount, sendTransaction, switchChain } from "wagmi/actions";
import { HARMONY_APP_CANNOT_SIGN } from "../ledger/apps";
import { LedgerError } from "../ledger/transport";
import type { LedgerSession } from "../ledger/useLedger";
import { wagmiConfig } from "../wagmi";
import { chainById, publicClient } from "./chain";

export interface ContractCall {
  to: Address;
  data: Hex;
}

export interface VaultSigner {
  address: Address | null;
  via: "wallet" | "ledger" | null;
  /** Why this connection can view but not send, if it cannot. */
  blockedReason: string | null;
  /** Signs and broadcasts; resolves with the transaction hash. */
  send(call: ContractCall): Promise<Hex>;
}

const GAS_HEADROOM_PERCENT = 120n;

type ConfigChainId = (typeof wagmiConfig.chains)[number]["id"];

/** The connected account, preferring a Ledger over USB like the confirm page does. */
export function useVaultSigner(ledger: LedgerSession, chainId: number | undefined): VaultSigner {
  const { address: walletAddress, isConnected } = useAccount();
  const ledgerAccount = ledger.account;

  if (ledgerAccount && ledger.app) {
    return {
      address: ledgerAccount.address,
      via: "ledger",
      blockedReason: ledger.canSignTransactions ? null : HARMONY_APP_CANNOT_SIGN,
      async send({ to, data }) {
        if (chainId === undefined) throw new Error("The vault list has not loaded.");
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

  if (isConnected && walletAddress) {
    return {
      address: walletAddress,
      via: "wallet",
      blockedReason: null,
      async send({ to, data }) {
        if (chainId === undefined) throw new Error("The vault list has not loaded.");
        const target = chainId as ConfigChainId;
        if (getAccount(wagmiConfig).chainId !== target) await switchChain(wagmiConfig, { chainId: target });
        return sendTransaction(wagmiConfig, { account: walletAddress, to, data, chainId: target });
      },
    };
  }

  return {
    address: null,
    via: null,
    blockedReason: null,
    async send() {
      throw new Error("Connect a wallet first.");
    },
  };
}
