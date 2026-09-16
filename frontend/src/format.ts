import { formatOne, isBech32Address, isHexAddress } from "@hcp/shared";

/** Display an atto-ONE decimal string with thousands separators. */
export function one(atto: string | null | undefined, maxFraction = 4): string {
  if (atto === null || atto === undefined || atto === "") return "-";
  return formatOne(atto, maxFraction);
}

export function shortAddress(addr: string): string {
  return addr.length > 14 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;
}

export function looksLikeAddress(value: string): boolean {
  const v = value.trim();
  return isHexAddress(v) || isBech32Address(v);
}

export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}
