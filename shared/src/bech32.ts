/**
 * Minimal BIP-173 bech32 for Harmony `one1...` addresses (20-byte payload).
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
export const ONE_HRP = "one";

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >>> i) & 1) chk ^= GENERATOR[i];
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const out: number[] = [];
  for (let p = 0; p < 6; p++) out.push((mod >>> (5 * (5 - p))) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >>> from !== 0) throw new Error("invalid bech32 data");
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new Error("invalid bech32 padding");
  }
  return out;
}

function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 40 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error("expected a 20-byte hex address");
  }
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
  return bytes;
}

/** Lowercase 0x hex -> one1... */
export function hexToBech32(hex: string, hrp = ONE_HRP): string {
  const data = convertBits(hexToBytes(hex), 8, 5, true);
  const combined = [...data, ...createChecksum(hrp, data)];
  return `${hrp}1${combined.map((d) => CHARSET[d]).join("")}`;
}

/** one1... -> lowercase 0x hex. Throws on any malformation. */
export function bech32ToHex(addr: string, hrp = ONE_HRP): string {
  const lower = addr.toLowerCase();
  if (lower !== addr && addr.toUpperCase() !== addr) throw new Error("mixed-case bech32");
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length || lower.length > 90) throw new Error("invalid bech32");
  const gotHrp = lower.slice(0, pos);
  if (gotHrp !== hrp) throw new Error(`unexpected bech32 prefix ${gotHrp}`);
  const data: number[] = [];
  for (const c of lower.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v === -1) throw new Error("invalid bech32 character");
    data.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error("bad bech32 checksum");
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  if (bytes.length !== 20) throw new Error("bech32 payload is not 20 bytes");
  return "0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isBech32Address(value: string): boolean {
  return /^one1[02-9ac-hj-np-z]{38}$/i.test(value.trim());
}

export function isHexAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}
