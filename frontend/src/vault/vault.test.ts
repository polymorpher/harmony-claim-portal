import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keccak256, type Address, type Hex } from "viem";
import { summarize, type VaultLog } from "./activity";
import { agreementStatus, agreementUrl } from "./agreements";
import { awaitingFunding, cutoffParts, formatFixed, groupOf, roundedGroups, roundedHoldings, roundToTotal } from "./breakdown";
import { AUDITED_CREATION_KECCAK, checkCatalog, CREATE2_FACTORY, vaultAddress, type Catalog, type CutoffDelegations } from "./catalog";
import { effectiveFee, parseAddress, parseFeePercent, parseOne, percentFromBps, percentFromRate } from "./format";
import { hasAcceptedRelease, recordRelease, RELEASE_TEXT } from "./release";

const CREATION = readFileSync(new URL("./testdata/GovernorDelegator.creation.hex", import.meta.url), "utf8").trim() as Hex;
const TOKEN: Address = "0xFf74317E948695297acb79Cb2De06111F5Cc16b3";
const SEPOLIA_TOKEN: Address = "0x6dF02e9a623f9d11d6c73B1fc2aBfAbb63f11E72";
const RESERVE: Address = "0xf868743BE6bbdA38929C03616234684E6D3Ded20";
const FORTUNE: Address = "0x63e7E9BB58aA72739a7CEc06f6EA9Fe73eb7A598";
const MODULO: Address = "0x951020A7047483d09173aF5d71B7C9CF60f273f6";
const ONE = 10n ** 18n;

const stage = (count: number, one: bigint) => ({ count, atto: (one * ONE).toString() });

function cutoff(over: Partial<CutoffDelegations> = {}): CutoffDelegations {
  return {
    delegators: 0,
    stake_atto: "0",
    initial: stage(0, 0n),
    inactive: stage(0, 0n),
    below_threshold: stage(0, 0n),
    exchange: stage(0, 0n),
    next_stage: stage(0, 0n),
    not_issued: stage(0, 0n),
    manual_review: stage(0, 0n),
    ...over,
  };
}

function catalog(vaults: { validator: Address; vault: Address }[]): Catalog {
  return {
    format: "vault-catalog/v1",
    generated_utc: "2026-10-11T00:00:00Z",
    chain_id: 1,
    token: TOKEN,
    reserve: RESERVE,
    factory: CREATE2_FACTORY,
    creation_code: CREATION,
    start_block: 26172162,
    harmony_cutoff: { block: 93623067, time_utc: "2026-09-10T14:00:00Z" },
    threshold_atto: (1000n * ONE).toString(),
    vaults: vaults.map((v) => ({ ...v, validator_one1: "", name: "x", governor: v.validator, commission_rate: "0.1", cutoff: cutoff() })),
  };
}

describe("vault addresses", () => {
  it("is the audited creation code", () => {
    expect(keccak256(CREATION)).toBe(AUDITED_CREATION_KECCAK);
  });

  it("derives the deployed mainnet and Sepolia vaults", () => {
    expect(vaultAddress(CREATION, TOKEN, FORTUNE, FORTUNE)).toBe("0xb75B9f48CF1e66e89727364c4df1d90FD84F6ba8");
    expect(vaultAddress(CREATION, TOKEN, MODULO, MODULO)).toBe("0x267282daf0ADc848d5E62D2aDF02356e45e12431");
    expect(vaultAddress(CREATION, SEPOLIA_TOKEN, FORTUNE, FORTUNE)).toBe("0x440575437D1Dde5Fd7B627817FC05d29E9A5B902");
  });

  it("rejects a catalog whose address or code is not the audited vault", () => {
    const good = catalog([{ validator: FORTUNE, vault: "0xb75b9f48cf1e66e89727364c4df1d90fd84f6ba8" }]);
    expect(checkCatalog(good).vaults[0].vault).toBe("0xb75B9f48CF1e66e89727364c4df1d90FD84F6ba8");
    expect(() => checkCatalog(catalog([{ validator: FORTUNE, vault: MODULO }]))).toThrow(/audited contract would be at/);
    expect(() => checkCatalog({ ...good, creation_code: `${CREATION}00` })).toThrow(/audited vault contract/);
    expect(() => checkCatalog({ ...good, format: "other" })).toThrow(/unknown format/);
    expect(() => checkCatalog({ ...good, token: SEPOLIA_TOKEN })).toThrow(/another token/);
  });
});

let index = 0;
function log(eventName: VaultLog["eventName"], args: Record<string, unknown>, block: number, tx = `0x${block.toString(16).padStart(64, "0")}`): VaultLog {
  return { eventName, args, blockNumber: BigInt(block), logIndex: index++, transactionHash: tx as Hex } as VaultLog;
}

const A: Address = "0x00000000000000000000000000000000000000a1";
const B: Address = "0x00000000000000000000000000000000000000b2";
const C: Address = "0x00000000000000000000000000000000000000c3";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

describe("vault events", () => {
  const logs = [
    log("GovernorTransferred", { previous: ZERO, next: FORTUNE }, 10),
    log("Deposit", { caller: RESERVE, delegator: A, assets: 100n * ONE }, 20, "0xaa"),
    log("Deposit", { caller: RESERVE, delegator: B, assets: 50n * ONE }, 20, "0xaa"),
    log("Deposit", { caller: RESERVE, delegator: C, assets: 5n * ONE }, 20, "0xaa"),
    log("Withdraw", { caller: B, delegator: C, assets: 50n * ONE }, 30),
    log("Deposit", { caller: C, delegator: C, assets: 1n * ONE }, 31),
    log("FeeUpdated", { previousFeeBps: 0, newFeeBps: 500 }, 40),
    log("GovernorTransferred", { previous: FORTUNE, next: MODULO }, 41),
    log("Deposit", { caller: RESERVE, delegator: B, assets: 7n * ONE }, 50, "0xbb"),
  ];

  it("tracks balances from deposits and the withdrawing caller", () => {
    const s = summarize([...logs].reverse(), RESERVE);
    expect(s.balances.get(A.toLowerCase())).toBe(100n * ONE);
    expect(s.balances.get(B.toLowerCase())).toBe(7n * ONE);
    expect(s.balances.get(C.toLowerCase())).toBe(6n * ONE);
    expect(s.delegatorsNow).toBe(3);
  });

  it("counts what the reserve credited, not other deposits", () => {
    const s = summarize(logs, RESERVE);
    expect(s.reserveCredits).toEqual({ count: 3, atto: 162n * ONE });
    expect(s.funded?.blockNumber).toBe(20n);
    expect(s.fundingRuns).toBe(2);
    expect(summarize(logs.slice(0, 1), RESERVE).funded).toBeNull();
    expect(s.otherDeposits).toEqual({ count: 1, atto: ONE });
    expect(s.withdrawals).toEqual({ count: 1, atto: 50n * ONE });
    let held = 0n;
    for (const b of s.balances.values()) held += b;
    expect(s.reserveCredits.atto + s.otherDeposits.atto - s.withdrawals.atto).toBe(held);
  });

  it("keeps governor and fee history in order", () => {
    const s = summarize(logs, RESERVE);
    expect(s.governorChanges.map((c) => [c.previous, c.next])).toEqual([[ZERO, FORTUNE], [FORTUNE, MODULO]]);
    expect(s.feeChanges.map((c) => [c.previous, c.next])).toEqual([[0, 500]]);
  });

  it("lists activity newest first and groups a funding batch into one row", () => {
    const s = summarize(logs, RESERVE);
    expect(s.activity.map((r) => [r.kind, r.count, r.amount / ONE, r.fromReserve])).toEqual([
      ["deposit", 1, 7n, true],
      ["deposit", 1, 1n, false],
      ["withdraw", 1, 50n, false],
      ["deposit", 3, 155n, true],
    ]);
    expect(s.activity[2].caller).toBe(B);
    expect(s.activity[2].counterparty).toBe(C);
    expect(s.activity[3].counterparty).toBeNull();
  });
});

describe("cutoff breakdown", () => {
  const fortune = cutoff({
    delegators: 2287,
    stake_atto: (113_060_607n * ONE).toString(),
    initial: stage(261, 57_000_000n),
    inactive: stage(1605, 56_000_000n),
    below_threshold: stage(417, 45_000n),
    next_stage: stage(4, 15_607n),
  });
  const view = (credits: { count: number; atto: bigint }) =>
    cutoffParts(fortune, credits).parts.map((p) => [p.credited ? "credited" : "outside", p.category, p.count, p.atto / ONE]);
  const sums = (credits: { count: number; atto: bigint }) => {
    const { parts } = cutoffParts(fortune, credits);
    return [parts.reduce((n, p) => n + p.count, 0), parts.reduce((a, p) => a + p.atto, 0n)];
  };

  it("shows the initial stage as not credited before funding", () => {
    expect(view({ count: 0, atto: 0n })).toEqual([
      ["outside", "initial", 261, 57_000_000n],
      ["outside", "inactive", 1605, 56_000_000n],
      ["outside", "below_threshold", 417, 45_000n],
      ["outside", "next_stage", 4, 15_607n],
    ]);
  });

  it("allocates credits to the initial stage, then to confirmed inactive delegators", () => {
    expect(view({ count: 271, atto: 64_000_000n * ONE })).toEqual([
      ["credited", "initial", 261, 57_000_000n],
      ["credited", "inactive", 10, 7_000_000n],
      ["outside", "inactive", 1595, 49_000_000n],
      ["outside", "below_threshold", 417, 45_000n],
      ["outside", "next_stage", 4, 15_607n],
    ]);
  });

  it("counts portal-approved delegators in what the next funding adds", () => {
    const withConfirmed = { ...fortune, confirmed: stage(10, 7_000_000n), inactive: stage(1595, 49_000_000n) };
    const before = cutoffParts(withConfirmed, { count: 0, atto: 0n }).parts;
    expect(before.filter((p) => groupOf(p) === "funding").map((p) => p.category)).toEqual(["initial", "confirmed"]);
    expect(awaitingFunding(before)).toEqual({ count: 271, atto: 64_000_000n * ONE });
    const after = cutoffParts(withConfirmed, { count: 271, atto: 64_000_000n * ONE }).parts;
    expect(awaitingFunding(after)).toEqual({ count: 0, atto: 0n });
    expect(after.filter((p) => p.credited).map((p) => [p.category, p.count])).toEqual([["initial", 261], ["confirmed", 10]]);
    expect(after.filter((p) => groupOf(p) === "not_airdropped").map((p) => [p.category, p.count])).toEqual([
      ["inactive", 1595],
      ["below_threshold", 417],
    ]);
  });

  it("always adds up to the cutoff totals", () => {
    for (const credits of [{ count: 0, atto: 0n }, { count: 100, atto: 20_000_000n * ONE }, { count: 1870, atto: 113_015_607n * ONE }]) {
      expect(sums(credits)).toEqual([2287, 113_060_607n * ONE]);
    }
    expect(cutoffParts(fortune, { count: 1880, atto: 113_015_700n * ONE }).unexplained).toEqual({ count: 10, atto: 93n * ONE });
  });

  it("rounds rows so they add up to the rounded total", () => {
    const parts = [ONE * 57_490_571n + (ONE * 95n) / 100n, ONE * 56_826_892n + (ONE * 63n) / 100n, ONE * 44_974n + (ONE * 80n) / 100n];
    const { values, total } = roundToTotal(parts.map((atto) => ({ sign: 1, atto })), ONE);
    expect(values.reduce((a, b) => a + b, 0n)).toBe(total);
    // 57,490,571.95 + 56,826,892.63 + 44,974.80 = 114,362,439.38: rounding each up would give ...440
    expect(total).toBe(114_362_439n);
    expect(values).toEqual([57_490_572n, 56_826_892n, 44_975n]);
    const signed = roundToTotal([{ sign: 1, atto: 5_072_252n * ONE }, { sign: 1, atto: ONE / 2n }, { sign: -1, atto: ONE }], ONE / 100n);
    expect(signed).toEqual({ values: [507_225_200n, 50n, 100n], total: 507_225_150n });
    expect(formatFixed(signed.total, 2)).toBe("5,072,251.50");
    expect(formatFixed(114_549_731n, 0)).toBe("114,549,731");
  });

  it("groups rows so each group sums its rows and the groups sum to the total", () => {
    const frac = (one: bigint, hundredths: bigint) => one * ONE + (hundredths * ONE) / 100n;
    const real = cutoff({
      delegators: 2290,
      stake_atto: (frac(57_490_571n, 95n) + frac(56_826_892n, 63n) + frac(44_974n, 80n) + 15_607n * ONE + frac(171_684n, 76n)).toString(),
      initial: { count: 261, atto: frac(57_490_571n, 95n).toString() },
      inactive: { count: 1605, atto: frac(56_826_892n, 63n).toString() },
      below_threshold: { count: 417, atto: frac(44_974n, 80n).toString() },
      next_stage: stage(4, 15_607n),
      not_issued: { count: 3, atto: frac(171_684n, 76n).toString() },
    });
    const credits = { count: 271, atto: frac(64_836_229n, 58n) };
    const { groups, total } = roundedGroups(cutoffParts(real, credits).parts, ONE);
    // 49,526,209.80 + 187,291.76 must make 114,549,731 − 64,836,230 = 49,713,501
    expect(groups.map((g) => [g.group, g.count, g.value])).toEqual([
      ["airdropped", 271, 64_836_230n],
      ["not_airdropped", 2012, 49_526_210n],
      ["separate", 7, 187_291n],
    ]);
    expect(total).toBe(114_549_731n);
    for (const g of groups) expect(g.parts.reduce((a, p) => a + p.value, 0n)).toBe(g.value);
    // the holdings table starts from the same airdropped figure
    expect(roundedHoldings(credits.atto, ONE / 2n, ONE, ONE).values[0]).toBe(64_836_230n);
  });
});

describe("fee and amount input", () => {
  it("formats Harmony rates and basis points as percent", () => {
    expect(percentFromRate("0.07")).toBe("7");
    expect(percentFromRate("0.1")).toBe("10");
    expect(percentFromRate("0.0525")).toBe("5.25");
    expect(percentFromRate("1")).toBe("100");
    expect(percentFromRate("0")).toBe("0");
    expect(percentFromBps(750)).toBe("7.5");
    expect(percentFromBps(1005)).toBe("10.05");
    expect(percentFromBps(10_000)).toBe("100");
  });

  it("reads a zero fee as the Harmony commission", () => {
    expect(effectiveFee(0, "0.07")).toEqual({ percent: "7", fromHarmony: true });
    expect(effectiveFee(500, "0.07")).toEqual({ percent: "5", fromHarmony: false });
  });

  it("parses the governor's percent into basis points", () => {
    expect(parseFeePercent("7.5")).toBe(750);
    expect(parseFeePercent("10%")).toBe(1000);
    expect(parseFeePercent("0.01")).toBe(1);
    expect(parseFeePercent("100")).toBe(10_000);
    for (const bad of ["0", "100.01", "7.555", "-1", "abc", ""]) expect(parseFeePercent(bad)).toBeNull();
  });

  it("parses ONE amounts exactly", () => {
    expect(parseOne("1,000.5")).toBe(1000n * ONE + ONE / 2n);
    expect(parseOne(".25")).toBe(ONE / 4n);
    expect(parseOne("0.000000000000000001")).toBe(1n);
    for (const bad of ["0", "1.0000000000000000001", "1e3", "-1", ""]) expect(parseOne(bad)).toBeNull();
  });

  it("accepts 0x and one1 recipients", () => {
    expect(parseAddress("one1v0n7nw6c4fe88xnuasr0d65luult0fvclvvxmf")).toBe(FORTUNE);
    expect(parseAddress(FORTUNE.toLowerCase())).toBe(FORTUNE);
    expect(parseAddress("0x63e7E9BB58aA72739a7CEc06f6EA9Fe73eb7a598")).toBeNull();
    expect(parseAddress(ZERO)).toBeNull();
    expect(parseAddress("one1nope")).toBeNull();
  });
});

describe("governor agreement status", () => {
  const id = `0x${"ab".repeat(32)}` as Hex;
  const vault = { ...catalog([{ validator: FORTUNE, vault: "0xb75B9f48CF1e66e89727364c4df1d90FD84F6ba8" }]).vaults[0] };

  it("prefers the live registry read and falls back to the catalog snapshot", () => {
    const withAgreement = { ...vault, agreement: { id, signed: false } };
    expect(agreementStatus(withAgreement, undefined)).toEqual({ state: "unsigned", url: agreementUrl(id), live: false });
    expect(agreementStatus(withAgreement, new Map([[id, true]]))).toEqual({ state: "signed", url: agreementUrl(id), live: true });
    expect(agreementUrl(id)).toBe(`https://app.metalex.tech/cybersign/8453/${id}`);
  });

  it("says when governors.country lists no agreement", () => {
    expect(agreementStatus(vault, new Map()).state).toBe("none");
  });
});

describe("release agreement", () => {
  function memory() {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
  }

  it("is remembered per signer address", () => {
    const store = memory();
    expect(hasAcceptedRelease(FORTUNE, store)).toBe(false);
    recordRelease(FORTUNE.toLowerCase(), store, new Date("2026-10-11T00:00:00Z"));
    expect(hasAcceptedRelease(FORTUNE, store)).toBe(true);
    expect(hasAcceptedRelease(MODULO, store)).toBe(false);
    expect(JSON.parse([...store.data.values()][0])).toEqual({ text: RELEASE_TEXT, accepted_utc: "2026-10-11T00:00:00.000Z" });
  });

  it("asks again if the text changes", () => {
    const store = memory();
    store.setItem(`hcp.vault.release.${FORTUNE.toLowerCase()}`, JSON.stringify({ text: "an older text" }));
    expect(hasAcceptedRelease(FORTUNE, store)).toBe(false);
  });
});
