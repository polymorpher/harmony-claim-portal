import { BaseError, ContractFunctionRevertedError, encodeFunctionData, formatUnits, type Hex } from "viem";
import { transactionErrorText } from "../wallet";
import { bridgeClaimsAbi } from "./abi";
import type { BridgeContract } from "./deployments";
import type { BridgeRow } from "./proofs";
import type { ContractState } from "./state";

export type RowStatus = "claimed" | "ready" | "waiting";

export function rowStatus(row: BridgeRow, state: ContractState): RowStatus {
  if (state.claimed.get(row.index)) return "claimed";
  return (state.available.get(row.asset.token.toLowerCase()) ?? 0n) >= row.amount ? "ready" : "waiting";
}

/**
 * The unpaid rows one claimMany can pay now. A row is left out when what is still available of its
 * asset does not cover it, because one failed transfer reverts the whole batch.
 */
export function payableRows(rows: BridgeRow[], state: ContractState): BridgeRow[] {
  const left = new Map(state.available);
  const out: BridgeRow[] = [];
  for (const row of rows) {
    if (state.claimed.get(row.index)) continue;
    const key = row.asset.token.toLowerCase();
    const have = left.get(key) ?? 0n;
    if (have < row.amount) continue;
    left.set(key, have - row.amount);
    out.push(row);
  }
  return out;
}

export function claimManyArgs(rows: BridgeRow[]) {
  return [rows.map((r) => ({ index: BigInt(r.index), account: r.account, token: r.asset.token, amount: r.amount, proof: r.proof }))] as const;
}

export function claimManyData(rows: BridgeRow[]): Hex {
  return encodeFunctionData({ abi: bridgeClaimsAbi, functionName: "claimMany", args: claimManyArgs(rows) });
}

/** Rows grouped by contract, in the contract list's order. */
export function rowsByContract(rows: BridgeRow[], contracts: BridgeContract[]): { contract: BridgeContract; rows: BridgeRow[] }[] {
  return contracts.map((contract) => ({ contract, rows: rows.filter((r) => r.contract.label === contract.label) })).filter((g) => g.rows.length > 0);
}

/**
 * An amount in whole tokens with thousands separators and at most `maxFraction` decimals, truncated.
 * An amount that would show as 0 shows every digit instead.
 */
export function formatAmount(raw: bigint, decimals: number, maxFraction = 6): string {
  const [whole, frac = ""] = formatUnits(raw, decimals).split(".");
  let shown = frac.slice(0, maxFraction).replace(/0+$/, "");
  if (whole === "0" && shown === "" && raw > 0n) shown = frac.replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return shown ? `${grouped}.${shown}` : grouped;
}

function revertOf(err: unknown): ContractFunctionRevertedError | null {
  const reverted = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
  return reverted instanceof ContractFunctionRevertedError ? reverted : null;
}

/** Whether `err` is the contract refusing the call, rather than the RPC or the wallet failing. */
export function isRevert(err: unknown): boolean {
  return revertOf(err) !== null;
}

/** Why one row would not pay, for a row checked on its own. */
export function refusalText(err: unknown): string {
  if (revertOf(err)?.data?.errorName === "TransferFailed") {
    return "the token refused the transfer; it may be paused, or the address blocked by its issuer";
  }
  return claimErrorText(err);
}

/** Text for a claim the contract would refuse, from a simulation. */
export function claimErrorText(err: unknown): string {
  const reverted = revertOf(err);
  if (reverted) {
    switch (reverted.data?.errorName) {
      case "TransferFailed":
        return "The custody Safe no longer makes enough of one of these assets available, or the token refused the transfer. Reload the page and try again.";
      case "InvalidProof":
      case "IndexOutOfRange":
        return "The contract does not accept a row of this list. Do not retry; report it to the migration team.";
      case "AlreadyClaimed":
        return "A row was claimed in the meantime. Reload the page.";
      case "NativeNotSupported":
        return "This contract does not pay the chain's coin.";
    }
  }
  return transactionErrorText(err);
}
