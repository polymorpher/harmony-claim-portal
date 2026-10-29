import { type SignatureScheme } from "@hcp/shared";
import type { Address, Hex } from "viem";
import { HARMONY_APP_CANNOT_SIGN } from "../ledger/apps";
import type { LedgerSession } from "../ledger/useLedger";
import { useSigner } from "../signer";
import { walletSendBlocked } from "../useWallet";

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
  /** Signs a message. Harmony Ledger apps can do this even when they cannot send an Ethereum transaction. */
  signMessage(message: string): Promise<{ signature: Hex; scheme: SignatureScheme }>;
}

/** The connected account, sending on the vault catalog's chain. */
export function useVaultSigner(ledger: LedgerSession, chainId: number | undefined): VaultSigner {
  const signer = useSigner(ledger);
  return {
    address: signer.address,
    via: signer.via,
    blockedReason:
      signer.via === "ledger" && !signer.canSend
        ? HARMONY_APP_CANNOT_SIGN
        : chainId !== undefined
          ? walletSendBlocked(signer, chainId)
          : null,
    signMessage: signer.signMessage,
    async send(call) {
      if (chainId === undefined) throw new Error("The vault list has not loaded.");
      return signer.send({ ...call, chainId });
    },
  };
}
