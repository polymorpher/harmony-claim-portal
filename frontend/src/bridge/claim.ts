import { parseEventLogs, WaitForTransactionReceiptTimeoutError, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { transactionErrorText } from "../wallet";
import { bridgeClaimsAbi } from "./abi";
import type { BridgeContract } from "./deployments";
import { isRevert, refusalText } from "./model";
import type { BridgeRow } from "./proofs";

export const RECEIPT_TIMEOUT_MS = 300_000;

/** A claim that went wrong after it was sent. `pending` means it may still be included, so it is worth checking again. */
export class ClaimError extends Error {
  constructor(
    message: string,
    readonly hash?: Hex,
    readonly pending = false,
  ) {
    super(message);
    this.name = "ClaimError";
  }
}

export interface Refusal {
  row: BridgeRow;
  reason: string;
}

/**
 * The rows one claimMany can pay now. When the whole batch would revert, each row is simulated on its
 * own, so an asset whose token refuses the transfer is left out instead of holding back the others.
 * RPC failures are thrown, not counted as refusals.
 */
export async function checkBatch(
  batch: BridgeRow[],
  simulate: (rows: BridgeRow[]) => Promise<unknown>,
): Promise<{ batch: BridgeRow[]; refused: Refusal[] }> {
  try {
    await simulate(batch);
    return { batch, refused: [] };
  } catch (err) {
    if (!isRevert(err)) throw err;
    if (batch.length === 1) return { batch: [], refused: [{ row: batch[0], reason: refusalText(err) }] };
  }
  const failed: { row: BridgeRow; err: unknown }[] = [];
  await Promise.all(
    batch.map(async (row) => {
      try {
        await simulate([row]);
      } catch (err) {
        failed.push({ row, err });
      }
    }),
  );
  const other = failed.find((f) => !isRevert(f.err));
  if (other) throw other.err;
  const left = batch.filter((row) => !failed.some((f) => f.row === row));
  if (left.length > 0) await simulate(left);
  const order = new Map(batch.map((row, i) => [row, i]));
  failed.sort((a, b) => order.get(a.row)! - order.get(b.row)!);
  return { batch: left, refused: failed.map((f) => ({ row: f.row, reason: refusalText(f.err) })) };
}

/** Row indexes the contract paid in this receipt, from its Claimed events. */
export function claimedIndexes(receipt: Pick<TransactionReceipt, "logs">, contract: Address): number[] {
  return parseEventLogs({ abi: bridgeClaimsAbi, eventName: "Claimed", logs: receipt.logs, strict: true })
    .filter((log) => log.address.toLowerCase() === contract.toLowerCase())
    .map((log) => Number(log.args.index));
}

export interface ClaimOutcome {
  /** The transaction that was included: the one sent, or the wallet's replacement for it. */
  hash: Hex;
  paid: number;
}

/**
 * Waits for a sent claim and counts what it paid. A successful receipt is not enough: the wallet can
 * replace or cancel the transaction, and viem then returns the replacement's receipt. Only Claimed
 * events of this contract for rows of this batch count.
 */
export async function awaitClaim(
  client: Pick<PublicClient, "waitForTransactionReceipt">,
  contract: BridgeContract,
  batch: BridgeRow[],
  hash: Hex,
  timeout = RECEIPT_TIMEOUT_MS,
): Promise<ClaimOutcome> {
  const replaced: { reason?: "cancelled" | "replaced" | "repriced" } = {};
  let receipt: TransactionReceipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash, timeout, onReplaced: (r) => (replaced.reason = r.reason) });
  } catch (err) {
    if (err instanceof WaitForTransactionReceiptTimeoutError) {
      throw new ClaimError(`The transaction was not included within ${Math.round(timeout / 60_000)} minutes. It may still be.`, hash, true);
    }
    throw new ClaimError(`The transaction could not be followed: ${transactionErrorText(err)}`, hash, true);
  }
  const included = receipt.transactionHash;
  if (receipt.status !== "success") throw new ClaimError("The transaction failed on chain, so nothing was claimed.", included);
  const wanted = new Set(batch.map((row) => row.index));
  const paid = claimedIndexes(receipt, contract.address).filter((index) => wanted.has(index)).length;
  if (paid === 0) {
    throw new ClaimError(
      replaced.reason === "cancelled"
        ? "The transaction was cancelled in the wallet, so nothing was claimed."
        : replaced.reason === "replaced"
          ? "The wallet replaced the transaction with a different one, which claimed nothing."
          : "The transaction claimed nothing: these assets had been claimed already.",
      included,
    );
  }
  return { hash: included, paid };
}
