import { bech32ToHex, isBech32Address } from "@hcp/shared";
import { getAddress, isAddress, parseUnits, zeroAddress, type Address } from "viem";

/** Percent text for a fraction such as Harmony's commission rate "0.07" -> "7". */
export function percentFromRate(rate: string): string {
  const [whole, frac = ""] = rate.split(".");
  const digits = `${whole}${frac.padEnd(2, "0")}`;
  const percent = `${BigInt(digits.slice(0, whole.length + 2))}`;
  const rest = frac.slice(2).replace(/0+$/, "");
  return rest ? `${percent}.${rest}` : percent;
}

/** Percent text for basis points: 750 -> "7.5". */
export function percentFromBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * The fee in effect. The contract starts at 0 and the migration reads 0 as
 * "the validator's Harmony commission at the cutoff still applies".
 */
export function effectiveFee(feeBps: number, commissionRate: string): { percent: string; fromHarmony: boolean } {
  return feeBps === 0
    ? { percent: percentFromRate(commissionRate), fromHarmony: true }
    : { percent: percentFromBps(feeBps), fromHarmony: false };
}

/** Basis points for a percent typed by the governor, or null: "7.5" -> 750. 0 is not accepted. */
export function parseFeePercent(text: string): number | null {
  const value = text.trim().replace(/%$/, "").trim();
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bps >= 1 && bps <= 10_000 ? bps : null;
}

/** Atto-ONE for an amount typed in ONE, or null. Commas are ignored. */
export function parseOne(text: string): bigint | null {
  const value = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,18})?$/.test(value) && !/^\.\d{1,18}$/.test(value)) return null;
  const atto = parseUnits(value.startsWith(".") ? `0${value}` : value, 18);
  return atto > 0n ? atto : null;
}

/** A 0x or one1 address as a checksummed 0x address, or null. */
export function parseAddress(text: string): Address | null {
  const value = text.trim();
  try {
    if (isBech32Address(value)) return getAddress(bech32ToHex(value));
  } catch {
    return null;
  }
  if (!isAddress(value)) return null;
  const address = getAddress(value);
  return address === zeroAddress ? null : address;
}
