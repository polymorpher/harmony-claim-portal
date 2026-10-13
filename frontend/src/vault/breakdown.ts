import type { Totals } from "./activity";
import type { CutoffDelegations } from "./catalog";

export type Category =
  | "initial"
  | "confirmed"
  | "inactive"
  | "next_stage"
  | "manual_review"
  | "below_threshold"
  | "exchange"
  | "not_issued";

export interface Part {
  category: Category;
  /** Credited into the vault by the reserve, or still outside it. */
  credited: boolean;
  count: number;
  atto: bigint;
}

/** Stages the reserve credits into the vault, in the order it funds them. */
const CREDITABLE: Category[] = ["initial", "confirmed", "inactive", "next_stage", "manual_review"];

export type Group = "airdropped" | "funding" | "not_airdropped" | "separate";

const GROUP_ORDER: Group[] = ["airdropped", "funding", "not_airdropped", "separate"];
/** Display order of the stages outside the vault. */
const OUTSIDE_ORDER: Category[] = ["initial", "confirmed", "inactive", "below_threshold", "next_stage", "manual_review", "exchange", "not_issued"];

export function groupOf(p: Part): Group {
  if (p.credited) return "airdropped";
  if (p.category === "initial" || p.category === "confirmed") return "funding";
  if (p.category === "inactive" || p.category === "below_threshold") return "not_airdropped";
  return "separate";
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const ZERO = { count: 0, atto: "0" };

/**
 * Splits the cutoff stake into what the reserve has credited and what is
 * still outside the vault. The reserve credits each delegator's cutoff stake:
 * the whole initial stage and the approved confirmations when it funds the
 * vault, later confirmations in later runs, then later-stage contracts, so
 * its credits are allocated to the stages in that order. The parts always sum
 * to the cutoff totals and come in display order; credits beyond every stage
 * are returned as `unexplained`.
 */
export function cutoffParts(cutoff: CutoffDelegations, credits: Totals): { parts: Part[]; unexplained: Totals } {
  let count = credits.count;
  let atto = credits.atto;
  const credited: Part[] = [];
  const outside = new Map<Category, Part>();
  for (const category of CREDITABLE) {
    const total = cutoff[category] ?? ZERO;
    const n = Math.min(count, total.count);
    const a = min(atto, BigInt(total.atto));
    count -= n;
    atto -= a;
    credited.push({ category, credited: true, count: n, atto: a });
    outside.set(category, { category, credited: false, count: total.count - n, atto: BigInt(total.atto) - a });
  }
  for (const category of ["below_threshold", "exchange", "not_issued"] as const) {
    outside.set(category, { category, credited: false, count: cutoff[category].count, atto: BigInt(cutoff[category].atto) });
  }
  const parts = [...credited, ...OUTSIDE_ORDER.map((c) => outside.get(c)!)]
    .filter((p) => p.count > 0 || p.atto > 0n)
    .sort((a, b) => GROUP_ORDER.indexOf(groupOf(a)) - GROUP_ORDER.indexOf(groupOf(b)));
  return { parts, unexplained: { count, atto } };
}

/** Approved delegators the reserve has not credited yet: what the next funding adds. */
export function awaitingFunding(parts: Part[]): Totals {
  return parts
    .filter((p) => groupOf(p) === "funding")
    .reduce((t, p) => ({ count: t.count + p.count, atto: t.atto + p.atto }), { count: 0, atto: 0n });
}

export function roundAtto(atto: bigint, unit: bigint): bigint {
  const r = ((atto < 0n ? -atto : atto) + unit / 2n) / unit;
  return atto < 0n ? -r : r;
}

/**
 * Rounds signed terms to `unit` so the rounded terms add up to `target`
 * (default: the rounded exact total), moving the fewest terms the least
 * (largest-remainder rounding).
 */
export function roundToTotal(terms: { sign: 1 | -1; atto: bigint }[], unit: bigint, target?: bigint): { values: bigint[]; total: bigint } {
  const exact = terms.reduce((s, t) => s + BigInt(t.sign) * t.atto, 0n);
  const values = terms.map((t) => roundAtto(t.atto, unit));
  const total = target ?? roundAtto(exact, unit);
  let diff = total - terms.reduce((s, t, i) => s + BigInt(t.sign) * values[i], 0n);
  while (diff !== 0n) {
    const step = diff > 0n ? 1n : -1n;
    let best = -1;
    let bestError = 0n;
    terms.forEach((t, i) => {
      const next = values[i] + step * BigInt(t.sign);
      if (next < 0n) return;
      const error = next * unit - t.atto;
      const abs = error < 0n ? -error : error;
      if (best === -1 || abs < bestError) {
        best = i;
        bestError = abs;
      }
    });
    if (best === -1) break;
    values[best] += step * BigInt(terms[best].sign);
    diff -= step;
  }
  return { values, total };
}

export interface RoundedGroup {
  group: Group;
  count: number;
  value: bigint;
  parts: { part: Part; value: bigint }[];
}

/**
 * Groups the parts and rounds them in two levels: the group subtotals add up
 * to the rounded cutoff total, and each group's rows add up to its subtotal.
 */
export function roundedGroups(parts: Part[], unit: bigint): { groups: RoundedGroup[]; total: bigint } {
  const grouped = GROUP_ORDER.map((group) => ({ group, parts: parts.filter((p) => groupOf(p) === group) })).filter(
    (g) => g.parts.length > 0,
  );
  const sums = grouped.map((g) => g.parts.reduce((a, p) => a + p.atto, 0n));
  const total = roundAtto(sums.reduce((a, b) => a + b, 0n), unit);
  // Airdropped and awaiting-funding subtotals keep their own rounding (the page states them elsewhere);
  // the other groups absorb the difference.
  const fixed = grouped.map((g) => g.group === "airdropped" || g.group === "funding");
  let values: bigint[];
  if (fixed.every(Boolean)) {
    values = roundToTotal(sums.map((atto) => ({ sign: 1, atto })), unit, total).values;
  } else {
    const fixedSum = sums.reduce((a, s, i) => (fixed[i] ? a + roundAtto(s, unit) : a), 0n);
    const free = roundToTotal(sums.filter((_, i) => !fixed[i]).map((atto) => ({ sign: 1, atto })), unit, total - fixedSum).values;
    values = sums.map((s, i) => (fixed[i] ? roundAtto(s, unit) : free.shift()!));
  }
  const groups = grouped.map((g, i) => {
    const inner = roundToTotal(g.parts.map((p) => ({ sign: 1, atto: p.atto })), unit, values[i]).values;
    return {
      group: g.group,
      count: g.parts.reduce((n, p) => n + p.count, 0),
      value: values[i],
      parts: g.parts.map((part, j) => ({ part, value: inner[j] })),
    };
  });
  return { groups, total };
}

/** Airdropped + deposited − withdrawn = held, with the airdropped term rounded as in roundedGroups. */
export function roundedHoldings(credited: bigint, deposited: bigint, withdrawn: bigint, unit: bigint): { values: bigint[]; total: bigint } {
  const first = roundAtto(credited, unit);
  const total = roundAtto(credited + deposited - withdrawn, unit);
  const rest = roundToTotal([{ sign: 1, atto: deposited }, { sign: -1, atto: withdrawn }], unit, total - first).values;
  return { values: [first, ...rest], total };
}

const ONE = 10n ** 18n;

/** Whole ONE for large amounts, hundredths when they are small. */
export function displayUnit(totalAtto: bigint): { unit: bigint; decimals: number } {
  return totalAtto >= 10_000n * ONE ? { unit: ONE, decimals: 0 } : { unit: ONE / 100n, decimals: 2 };
}

/** An amount rounded to the nearest display unit, e.g. "64,836,230". */
export function formatRounded(atto: bigint, display = displayUnit(atto)): string {
  return formatFixed(roundAtto(atto, display.unit), display.decimals);
}

/** A count of `decimals`-place units with thousands separators: 123456, 2 -> "1,234.56". */
export function formatFixed(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const whole = (abs / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = decimals > 0 ? `.${(abs % scale).toString().padStart(decimals, "0")}` : "";
  return `${negative ? "−" : ""}${whole}${frac}`;
}
