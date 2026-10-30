import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { bridgeClaimsAbi } from "./abi";
import { awaitClaim, checkBatch, ClaimError, claimedIndexes } from "./claim";
import type { BridgeAsset, BridgeContract } from "./deployments";
import { loadRows, ProofError, type BridgeRow } from "./proofs";

const CONTRACT = { label: "base", chain_id: 8453, address: "0x00000000000000000000000000000000000000c1" } as unknown as BridgeContract;
const PAYEE: Address = "0x00000000000000000000000000000000000000a1";
const TOKENS: Record<string, Address> = {
  USDC: "0x00000000000000000000000000000000000000b1",
  USDT: "0x00000000000000000000000000000000000000b2",
  DAI: "0x00000000000000000000000000000000000000b3",
};
const SENT: Hex = `0x${"11".repeat(32)}`;
const INCLUDED: Hex = `0x${"22".repeat(32)}`;

const row = (index: number, symbol: keyof typeof TOKENS): BridgeRow => ({
  contract: CONTRACT,
  asset: { token: TOKENS[symbol], symbol, decimals: 6, pools: [] } as BridgeAsset,
  index,
  account: PAYEE,
  amount: 10n,
  proof: [],
});
const [usdc, usdt, dai] = [row(1, "USDC"), row(2, "USDT"), row(3, "DAI")];

function revert(errorName: "TransferFailed" | "InvalidProof", args: readonly unknown[]) {
  return new ContractFunctionRevertedError({
    abi: bridgeClaimsAbi,
    data: encodeErrorResult({ abi: bridgeClaimsAbi, errorName, args } as never),
    functionName: "claimMany",
  });
}
const refusedTransfer = () => revert("TransferFailed", [TOKENS.USDT, PAYEE, 10n]);

/** A simulation that reverts whenever the batch holds one of `refusing`, and records each batch. */
function simulator(refusing: BridgeRow[] = []) {
  const calls: number[][] = [];
  const simulate = async (rows: BridgeRow[]) => {
    calls.push(rows.map((r) => r.index));
    if (rows.some((r) => refusing.includes(r))) throw refusedTransfer();
  };
  return { calls, simulate };
}

describe("checking a batch before the wallet", () => {
  it("passes a batch the contract accepts, in one simulation", async () => {
    const { calls, simulate } = simulator();
    expect(await checkBatch([usdc, usdt], simulate)).toEqual({ batch: [usdc, usdt], refused: [] });
    expect(calls).toEqual([[1, 2]]);
  });

  it("leaves out an asset whose token refuses the transfer and keeps the others", async () => {
    const { calls, simulate } = simulator([usdt]);
    const checked = await checkBatch([usdc, usdt, dai], simulate);
    expect(checked.batch).toEqual([usdc, dai]);
    expect(checked.refused).toEqual([{ row: usdt, reason: expect.stringMatching(/token refused the transfer/) }]);
    expect(calls[0]).toEqual([1, 2, 3]);
    expect(calls.at(-1)).toEqual([1, 3]);
  });

  it("refuses a single row without trying it twice", async () => {
    const { calls, simulate } = simulator([usdt]);
    const checked = await checkBatch([usdt], simulate);
    expect(checked.batch).toEqual([]);
    expect(checked.refused.map((r) => r.row)).toEqual([usdt]);
    expect(calls).toEqual([[2]]);
  });

  it("throws RPC failures instead of counting them as refusals", async () => {
    await expect(checkBatch([usdc, usdt], async () => Promise.reject(new Error("rate limited")))).rejects.toThrow("rate limited");
    let first = true;
    const flaky = async (rows: BridgeRow[]) => {
      if (first) {
        first = false;
        throw refusedTransfer();
      }
      if (rows[0] === dai) throw new Error("rpc down");
    };
    await expect(checkBatch([usdc, dai], flaky)).rejects.toThrow("rpc down");
  });

  it("throws when every row passes alone but the batch still reverts", async () => {
    const together = async (rows: BridgeRow[]) => {
      if (rows.length > 1) throw refusedTransfer();
    };
    await expect(checkBatch([usdc, dai], together)).rejects.toBeInstanceOf(ContractFunctionRevertedError);
  });
});

function claimedLog(index: number, address: Address = CONTRACT.address): Log {
  return {
    address,
    topics: encodeEventTopics({ abi: bridgeClaimsAbi, eventName: "Claimed", args: { index: BigInt(index), account: PAYEE, token: TOKENS.USDC } }),
    data: encodeAbiParameters([{ type: "uint256" }], [10n]),
    blockHash: `0x${"33".repeat(32)}`,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: INCLUDED,
    transactionIndex: 0,
    removed: false,
  } as Log;
}

/** A client whose receipt has `logs`, after reporting `reason` as viem does for a replaced transaction. */
function client(logs: Log[], { status = "success", reason }: { status?: "success" | "reverted"; reason?: string } = {}) {
  return {
    async waitForTransactionReceipt({ onReplaced }: { onReplaced?: (r: { reason: string }) => void }) {
      if (reason) onReplaced?.({ reason });
      return { status, transactionHash: reason ? INCLUDED : SENT, logs };
    },
  } as unknown as Pick<PublicClient, "waitForTransactionReceipt">;
}

describe("following a sent claim", () => {
  it("reads which rows the contract paid from its own Claimed events", () => {
    const logs = [claimedLog(1), claimedLog(2, "0x00000000000000000000000000000000000000ff"), claimedLog(3)];
    expect(claimedIndexes({ logs } as never, CONTRACT.address)).toEqual([1, 3]);
  });

  it("does not report a cancelled transaction as claimed, though its receipt succeeded", async () => {
    const error = await awaitClaim(client([], { reason: "cancelled" }), CONTRACT, [usdc, dai], SENT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaimError);
    expect((error as ClaimError).message).toMatch(/cancelled in the wallet, so nothing was claimed/);
    expect((error as ClaimError).hash).toBe(INCLUDED);
    expect((error as ClaimError).pending).toBe(false);
  });

  it("does not report another transaction in its place as claimed", async () => {
    await expect(awaitClaim(client([], { reason: "replaced" }), CONTRACT, [usdc], SENT)).rejects.toThrow(/replaced the transaction/);
    await expect(awaitClaim(client([claimedLog(9)]), CONTRACT, [usdc], SENT)).rejects.toThrow(/claimed already/);
  });

  it("counts a repriced transaction's payments and links the one included", async () => {
    expect(await awaitClaim(client([claimedLog(1), claimedLog(3)], { reason: "repriced" }), CONTRACT, [usdc, dai], SENT)).toEqual({ hash: INCLUDED, paid: 2 });
    expect(await awaitClaim(client([claimedLog(3)]), CONTRACT, [usdc, dai], SENT)).toEqual({ hash: SENT, paid: 1 });
  });

  it("reports a reverted transaction with its link", async () => {
    const error = (await awaitClaim(client([], { status: "reverted" }), CONTRACT, [usdc], SENT).catch((e: unknown) => e)) as ClaimError;
    expect(error.message).toMatch(/failed on chain/);
    expect([error.hash, error.pending]).toEqual([SENT, false]);
  });

  it("keeps the transaction to check again when waiting times out or the RPC fails", async () => {
    const timingOut = {
      waitForTransactionReceipt: async () => Promise.reject(new WaitForTransactionReceiptTimeoutError({ hash: SENT })),
    } as unknown as Pick<PublicClient, "waitForTransactionReceipt">;
    const timeout = (await awaitClaim(timingOut, CONTRACT, [usdc], SENT, 300_000).catch((e: unknown) => e)) as ClaimError;
    expect(timeout.message).toMatch(/not included within 5 minutes/);
    expect([timeout.hash, timeout.pending]).toEqual([SENT, true]);
    const failing = { waitForTransactionReceipt: async () => Promise.reject(new Error("socket hang up")) } as unknown as Pick<PublicClient, "waitForTransactionReceipt">;
    const lost = (await awaitClaim(failing, CONTRACT, [usdc], SENT).catch((e: unknown) => e)) as ClaimError;
    expect([lost.hash, lost.pending]).toEqual([SENT, true]);
  });
});

describe("downloading a proof file", () => {
  afterEach(() => vi.unstubAllGlobals());
  const account: Address = "0x0a9ac1a3de43a00af91bf4590db0cc9fcfe6d59b";

  it("gives up after a timeout, with a message that says so", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    await expect(loadRows(account)).rejects.toThrow(/did not load within 30 seconds/);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("explains a failed download, an HTTP error, and a broken file", async () => {
    vi.stubGlobal("fetch", async () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(loadRows(account)).rejects.toThrow(/could not be downloaded/);
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    await expect(loadRows(account)).rejects.toThrow(/HTTP 404/);
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 200 }));
    await expect(loadRows(account)).rejects.toBeInstanceOf(ProofError);
    await expect(loadRows(account)).rejects.toThrow(/not valid JSON/);
  });
});
