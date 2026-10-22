import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";

/**
 * keccak256 of the audited GovernorDelegator runtime with the ONE token
 * patched into the immutable asset slots. From harmony-migration
 * `airdrop/vault/GovernorDelegator.json` (hiddenstate.xyz audit, 2026-10-06).
 * Mainnet token 0xFf74317E948695297acb79Cb2De06111F5Cc16b3.
 * Sepolia rehearsal token 0x6dF02e9a623f9d11d6c73B1fc2aBfAbb63f11E72.
 */
export const MAINNET_VAULT_RUNTIME = "0xc1f4cf5c480968601dde8f0e72521acfa7948d4d6b668dfa8f446f81375a47e6";
export const SEPOLIA_VAULT_RUNTIME = "0xe61dc419e4237365186809c20dfd54b43fb3baafa911b15c749e9e4ef6ccb572";

const governorAbi = parseAbi(["function governor() view returns (address)"]);

export class VaultChainError extends Error {
  constructor(message = "The vault's governor could not be read from Ethereum. Try again.") {
    super(message);
    this.name = "VaultChainError";
  }
}

export function isAuditedVaultCode(code: Hex): boolean {
  if (!code || code === "0x") return false;
  const hash = keccak256(code);
  return hash === MAINNET_VAULT_RUNTIME || hash === SEPOLIA_VAULT_RUNTIME;
}

/** The current governor of an audited vault, or null when the address is not one. */
export interface VaultChain {
  governorOf(vault: Address): Promise<Address | null>;
}

export function ethereumVaultChain(rpcUrls: string[]): VaultChain {
  if (rpcUrls.length === 0) {
    return {
      async governorOf() {
        throw new VaultChainError();
      },
    };
  }
  const client: PublicClient = createPublicClient({
    chain: mainnet,
    transport: fallback(rpcUrls.map((url) => http(url, { retryCount: 1, timeout: 12_000 }))),
  });
  return {
    async governorOf(vault) {
      try {
        const code = await client.getCode({ address: vault });
        if (!code || !isAuditedVaultCode(code)) return null;
        const governor = await client.readContract({ address: vault, abi: governorAbi, functionName: "governor" });
        return getAddress(governor);
      } catch (err) {
        if (err instanceof VaultChainError) throw err;
        throw new VaultChainError();
      }
    },
  };
}
