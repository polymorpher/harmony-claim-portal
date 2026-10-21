import { describe, expect, it } from "vitest";
import { hexToBech32, type ArchiveRecord } from "@hcp/shared";
import {
  calldataLines,
  calldataSize,
  callLabel,
  destinationText,
  direction,
  functionName,
  historyPath,
  isMalformedHistoryLocation,
  parseHistoryLocation,
  parseQuery,
  recordFlags,
  recordLabel,
  shardText,
} from "./model";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"ab".repeat(32)}`;

function record(partial: Partial<ArchiveRecord>): ArchiveRecord {
  return {
    id: "1",
    record_type: "transaction",
    kind: "transfer",
    shard: 0,
    to_shard: 0,
    branch: "canonical",
    block_number: 67500000,
    block_hash: HASH,
    time_utc: "2025-01-01T00:00:00.000Z",
    tx_index: 0,
    trace_address: null,
    tx_hash: HASH,
    eth_hash: null,
    from: ALICE,
    to: BOB,
    value_atto: "1000000000000000000",
    value_one: "1",
    fee_atto: null,
    status: "success",
    method: null,
    method_name: null,
    method_verified: null,
    ancestor_reverted: null,
    destination: null,
    ...partial,
  };
}

describe("history query", () => {
  it("recognizes hashes and both address forms", () => {
    expect(parseQuery(` ${HASH.toUpperCase().replace("0X", "0x")} `)).toEqual({ type: "tx", value: HASH });
    expect(parseQuery(ALICE)).toEqual({ type: "address", value: ALICE });
    const bech = hexToBech32(ALICE);
    expect(parseQuery(bech)).toEqual({ type: "address", value: bech });
    expect(parseQuery("0x1234")).toBeNull();
    expect(parseQuery("hello")).toBeNull();
  });

  it("round-trips through a query-string link", () => {
    for (const q of [parseQuery(ALICE)!, parseQuery(HASH)!, parseQuery(hexToBech32(BOB))!]) {
      const url = new URL(historyPath(q), "https://migrate.country");
      expect(url.pathname).toBe("/history");
      expect(parseHistoryLocation(url.pathname, url.search)).toEqual(q);
    }
    expect(parseHistoryLocation("/history", "")).toBeNull();
    expect(parseHistoryLocation("/history", `?tx=${ALICE}`)).toBeNull();
    expect(parseHistoryLocation("/history", `?address=${HASH}`)).toBeNull();
  });

  it("still reads the older path links", () => {
    expect(parseHistoryLocation(`/history/address/${ALICE}`, "")).toEqual({ type: "address", value: ALICE });
    expect(parseHistoryLocation(`/history/tx/${HASH}`, "")).toEqual({ type: "tx", value: HASH });
    expect(parseHistoryLocation(`/history/tx/${ALICE}`, "")).toBeNull();
    expect(parseHistoryLocation("/history/address/%E0%A4%A", "")).toBeNull();
  });

  it("flags only locations that name an unparseable record", () => {
    expect(isMalformedHistoryLocation("/history", "")).toBe(false);
    expect(isMalformedHistoryLocation("/history", `?address=${ALICE}`)).toBe(false);
    expect(isMalformedHistoryLocation("/history", "?address=nope")).toBe(true);
    expect(isMalformedHistoryLocation("/history/tx/nope", "")).toBe(true);
  });
});

describe("record display", () => {
  it("labels kinds", () => {
    expect(recordLabel({ record_type: "transaction", kind: "call" })).toBe("Contract call");
    expect(recordLabel({ record_type: "internal", kind: "selfdestruct" })).toBe("Self-destruct payout");
    expect(recordLabel({ record_type: "cross_shard", kind: "precompile_replay_incompatible_delegatecall" })).toBe(
      "Cross-shard receipt",
    );
    expect(recordLabel({ record_type: "staking", kind: "CollectRewards" })).toBe("Collect rewards");
  });

  it("derives direction against the looked-up address", () => {
    expect(direction(record({}), ALICE)).toBe("out");
    expect(direction(record({}), BOB.toUpperCase().replace("0X", "0x"))).toBe("in");
    expect(direction(record({ to: ALICE }), ALICE)).toBe("self");
    expect(direction(record({ to: null }), ALICE)).toBe("out");
  });

  it("flags rolled-back, failed and reverted records", () => {
    expect(recordFlags(record({}))).toEqual([]);
    expect(recordFlags(record({ branch: "rolled_back", status: "failed" }))).toEqual([
      "Rolled back, not final",
      "Failed, value not moved",
    ]);
    expect(recordFlags(record({ record_type: "internal", status: "failed" }))).toEqual(["Reverted, not moved"]);
    expect(recordFlags(record({ record_type: "cross_shard", ancestor_reverted: true }))).toEqual([
      "Created inside a reverted call",
    ]);
  });

  it("describes shards and destinations", () => {
    expect(shardText(record({}))).toBe("0");
    expect(shardText(record({ to_shard: 1 }))).toBe("0 → 1");
    const credited = record({
      record_type: "cross_shard",
      to_shard: 1,
      destination: { status: "credited", block_number: 95000000, block_hash: HASH, time_utc: null },
    });
    expect(destinationText(credited)).toBe("Credited on shard 1 in block 95,000,000");
    expect(destinationText(record({}))).toBeNull();
  });

  it("names called functions but not creation code", () => {
    expect(functionName("update(string,string,uint8,string,string[],bool)")).toBe("update");
    expect(functionName("fallback")).toBe("fallback");
    const call = { record_type: "transaction" as const, kind: "call", method_name: "deposit()" };
    expect(callLabel(call)).toBe("deposit");
    expect(callLabel({ ...call, method_name: null })).toBeNull();
    expect(callLabel({ ...call, kind: "create" })).toBeNull();
  });

  it("splits calldata into selector and argument words", () => {
    const input = `0xd0e30db0${"00".repeat(31)}01${"ff".repeat(3)}`;
    expect(calldataSize(input)).toBe(39);
    expect(calldataLines(input)).toEqual(["0xd0e30db0", `${"00".repeat(31)}01`, "ffffff"]);
    expect(calldataLines("0x31")).toEqual(["0x31"]);
  });
});
