/**
 * Atto-ONE amount helpers. Amounts travel as decimal strings and are handled
 * with BigInt only; no floating point anywhere.
 */

export const ATTO_PER_ONE = 10n ** 18n;

export function toBigInt(value: string | bigint | number | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("unsafe integer amount");
    return BigInt(value);
  }
  const s = value.trim();
  if (!/^-?\d+$/.test(s)) throw new Error(`invalid atto amount: ${value}`);
  return BigInt(s);
}

/**
 * Exact decimal string in ONE (no rounding): trailing zeros trimmed, at most
 * `maxFraction` fractional digits when given (truncated, never rounded).
 */
export function attoToOne(value: string | bigint, maxFraction = 18): string {
  const atto = toBigInt(value);
  const negative = atto < 0n;
  const abs = negative ? -atto : atto;
  const whole = abs / ATTO_PER_ONE;
  let frac = (abs % ATTO_PER_ONE).toString().padStart(18, "0");
  frac = frac.slice(0, Math.max(0, Math.min(18, maxFraction))).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${frac ? "." + frac : ""}`;
}

/** Display formatting with thousands separators, e.g. "1,234.5678". */
export function formatOne(value: string | bigint, maxFraction = 4): string {
  const exact = attoToOne(value, maxFraction);
  const [whole, frac] = exact.split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}${frac ? "." + frac : ""}`;
}

export function sumAtto(values: Iterable<string | bigint>): bigint {
  let total = 0n;
  for (const v of values) total += toBigInt(v);
  return total;
}
