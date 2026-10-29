import { keccak256, type Address, type PublicClient } from "viem";
import { publicClient } from "../chains";
import { bridgeClaimsAbi } from "./abi";
import type { BridgeContract } from "./deployments";
import type { BridgeRow } from "./proofs";

export interface ContractState {
  /** Whether the chain has exactly the expected runtime code at the contract's address. */
  code: "ok" | "missing" | "different";
  /** Paid flag per row index. */
  claimed: Map<number, boolean>;
  /** What the contract can pay now per asset (lower-case token): the custody Safe's approval, capped by its balance. */
  available: Map<string, bigint>;
}

/**
 * Reads the contract on its chain. The runtime code carries every immutable (funder, root, row count,
 * list hash), so a matching code hash means the contract is the one this page's list describes.
 */
export async function readContractState(
  contract: BridgeContract,
  rows: BridgeRow[],
  client: PublicClient = publicClient(contract.chain_id),
): Promise<ContractState> {
  const code = await client.getCode({ address: contract.address });
  const empty: ContractState = { code: "missing", claimed: new Map(), available: new Map() };
  if (!code || code === "0x") return empty;
  if (keccak256(code) !== contract.runtime_keccak256) return { ...empty, code: "different" };
  const tokens = [...new Set(rows.map((r) => r.asset.token.toLowerCase() as Address))];
  const [claimed, available] = await Promise.all([
    client.multicall({
      contracts: rows.map((r) => ({ address: contract.address, abi: bridgeClaimsAbi, functionName: "isClaimed", args: [BigInt(r.index)] }) as const),
      allowFailure: false,
    }),
    client.multicall({
      contracts: tokens.map((t) => ({ address: contract.address, abi: bridgeClaimsAbi, functionName: "available", args: [t] }) as const),
      allowFailure: false,
    }),
  ]);
  return {
    code: "ok",
    claimed: new Map(rows.map((r, i) => [r.index, claimed[i] as boolean])),
    available: new Map(tokens.map((t, i) => [t, available[i] as bigint])),
  };
}
