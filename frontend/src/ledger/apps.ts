import { bech32ToHex } from "@hcp/shared";
import { bytesToHex, getAddress, keccak256, type Address, type Hex } from "viem";
import { LedgerError, LedgerStatusError, type Apdu } from "./transport";

/**
 * - `harmony`: the 2025 Harmony app, Ledger's Ethereum-app build for Harmony
 *   (coin type 1023). Same commands as the Ethereum app, locked to 44'/1023'.
 * - `harmony-legacy`: the pre-2025 "Harmony One" app. Only signs Harmony
 *   transactions, from the single path 44'/1023'/0'/0/0.
 * - `ethereum`: the Ethereum app (Ledger Wallet and MetaMask accounts).
 */
export type LedgerAppKind = "harmony" | "harmony-legacy" | "ethereum";

export interface LedgerApp {
  kind: LedgerAppKind;
  version: string;
}

export type PathScheme = "harmony" | "ledger-live" | "bip44" | "legacy";

export const PATH_SCHEMES: Record<PathScheme, { label: string; path: (index: number) => string }> = {
  harmony: { label: "Harmony (44'/1023'/0'/0/N)", path: (i) => `44'/1023'/0'/0/${i}` },
  "ledger-live": { label: "Ledger Wallet / Ledger Live (44'/60'/N'/0/0)", path: (i) => `44'/60'/${i}'/0/0` },
  bip44: { label: "MetaMask (44'/60'/0'/0/N)", path: (i) => `44'/60'/0'/0/${i}` },
  legacy: { label: "MyEtherWallet legacy (44'/60'/0'/N)", path: (i) => `44'/60'/0'/${i}` },
};

export const LEGACY_HARMONY_PATH = "44'/1023'/0'/0/0";

const CLA_BOLOS = 0xb0;
const CLA_APP = 0xe0;

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

async function openAppName(apdu: Apdu): Promise<{ name: string; version: string } | null> {
  try {
    const r = await apdu(CLA_BOLOS, 0x01, 0x00, 0x00);
    const nameLength = r[1];
    const name = ascii(r.subarray(2, 2 + nameLength));
    const versionLength = r[2 + nameLength];
    const version = ascii(r.subarray(3 + nameLength, 3 + nameLength + versionLength));
    return { name, version };
  } catch (err) {
    // The pre-2025 Harmony app was built with an SDK that rejects this class.
    if (err instanceof LedgerStatusError && (err.status === 0x6e00 || err.status === 0x6d00)) return null;
    throw err;
  }
}

/** Ethereum-app GET_APP_CONFIGURATION: flags, major, minor, patch. The pre-2025 Harmony app has no INS 0x06. */
async function ethAppVersion(apdu: Apdu): Promise<string | null> {
  try {
    const r = await apdu(CLA_APP, 0x06, 0x00, 0x00);
    return r.length >= 4 ? `${r[1]}.${r[2]}.${r[3]}` : null;
  } catch (err) {
    if (err instanceof LedgerStatusError) return null;
    throw err;
  }
}

/** Pre-2025 Harmony app GET_VERSION: exactly three bytes. */
async function legacyAppVersion(apdu: Apdu): Promise<string | null> {
  try {
    const r = await apdu(CLA_APP, 0x01, 0x00, 0x00);
    return r.length === 3 ? `${r[0]}.${r[1]}.${r[2]}` : null;
  } catch (err) {
    if (err instanceof LedgerStatusError) return null;
    throw err;
  }
}

/**
 * The two Harmony apps have been published under the names "Harmony",
 * "Harmony One" and "One", so the name only narrows it down; the command set
 * decides which protocol to speak.
 */
export async function detectApp(apdu: Apdu): Promise<LedgerApp> {
  const open = await openAppName(apdu);
  if (open?.name === "BOLOS") throw new LedgerError("Open the Harmony app on the Ledger, then connect again.");
  if (open?.name === "Ethereum") return { kind: "ethereum", version: open.version };
  if (open && !/harmony|^one$/i.test(open.name)) {
    throw new LedgerError(`The Ledger has the ${open.name} app open. Open the Harmony app or the Ethereum app, then connect again.`);
  }
  const ethVersion = await ethAppVersion(apdu);
  if (ethVersion) return { kind: "harmony", version: open?.version || ethVersion };
  const legacyVersion = await legacyAppVersion(apdu);
  if (legacyVersion) return { kind: "harmony-legacy", version: open?.version || legacyVersion };
  throw new LedgerError("Open the Harmony app on the Ledger, then connect again.");
}

export function encodePath(path: string): Uint8Array {
  const parts = path.split("/");
  const out = new Uint8Array(1 + parts.length * 4);
  out[0] = parts.length;
  parts.forEach((part, i) => {
    const hardened = part.endsWith("'");
    const index = Number(hardened ? part.slice(0, -1) : part);
    if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new Error(`bad path element ${part}`);
    const value = (hardened ? index + 0x80000000 : index) >>> 0;
    new DataView(out.buffer).setUint32(1 + i * 4, value);
  });
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Ethereum-app GET_PUBLIC_KEY without on-device display. */
export async function ethGetAddress(apdu: Apdu, path: string): Promise<Address> {
  const r = await apdu(CLA_APP, 0x02, 0x00, 0x00, encodePath(path));
  const publicKey = r.subarray(1, 1 + r[0]);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) throw new LedgerError("The Ledger returned an unexpected public key.");
  return getAddress(`0x${keccak256(publicKey.subarray(1)).slice(-40)}`);
}

/**
 * Ethereum-app SIGN_PERSONAL_MESSAGE (EIP-191). Chunked like hw-app-eth: 150
 * bytes per APDU, the first carrying the path and the 4-byte message length.
 * Returns the 65-byte r || s || v signature.
 */
export async function ethSignPersonalMessage(apdu: Apdu, path: string, message: Uint8Array): Promise<Hex> {
  const pathBytes = encodePath(path);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, message.length);
  const chunks: Uint8Array[] = [];
  const firstRoom = 150 - pathBytes.length - 4;
  chunks.push(concat(pathBytes, length, message.subarray(0, firstRoom)));
  for (let offset = firstRoom; offset < message.length; offset += 150) {
    chunks.push(message.subarray(offset, offset + 150));
  }
  let response: Uint8Array = new Uint8Array(0);
  for (let i = 0; i < chunks.length; i++) {
    response = await apdu(CLA_APP, 0x08, i === 0 ? 0x00 : 0x80, 0x00, chunks[i]);
  }
  if (response.length < 65) throw new LedgerError("The Ledger returned an incomplete signature.");
  let v = response[0];
  if (v < 27) v += 27;
  return bytesToHex(concat(response.subarray(1, 65), Uint8Array.of(v)));
}

/** Pre-2025 Harmony app: GET_PUBLIC_KEY in silent mode returns the one1 address. */
export async function legacyGetAddress(apdu: Apdu): Promise<Address> {
  const r = await apdu(CLA_APP, 0x02, 0x00, 0x01);
  try {
    return getAddress(bech32ToHex(ascii(r.subarray(0, 42))));
  } catch {
    throw new LedgerError("The Ledger returned an unexpected address.");
  }
}

/**
 * Pre-2025 Harmony app SIGN_TX. The app parses the leading transaction fields
 * for display and signs keccak256 of every byte sent. Chunks are 255 bytes:
 * P1 0x00 first / 0x80 after, P2 0x02 on the last chunk / 0x01 before it.
 * The app returns r || s || recovery id; this returns r || s || 27 + id.
 */
export async function legacySignTx(apdu: Apdu, payload: Uint8Array): Promise<Hex> {
  let response: Uint8Array = new Uint8Array(0);
  for (let offset = 0; offset < payload.length; offset += 255) {
    const last = offset + 255 >= payload.length;
    response = await apdu(CLA_APP, 0x08, offset === 0 ? 0x00 : 0x80, last ? 0x02 : 0x01, payload.subarray(offset, offset + 255));
  }
  if (response.length < 65) throw new LedgerError("The Ledger returned an incomplete signature.");
  const recovery = response[64];
  if (recovery > 1) throw new LedgerError("The Ledger returned a signature this page cannot use. Try again.");
  return bytesToHex(concat(response.subarray(0, 64), Uint8Array.of(27 + recovery)));
}

export function ledgerErrorText(err: unknown): string {
  if (err instanceof LedgerStatusError) {
    switch (err.status) {
      case 0x6985:
      case 0x5501:
        return "The request was rejected on the Ledger.";
      case 0x5515:
      case 0x6982:
        return "Unlock the Ledger, open the Harmony app, then try again.";
      case 0x6e00:
      case 0x6e01:
      case 0x6d00:
      case 0x6d02:
      case 0x6511:
        return "Open the Harmony app on the Ledger, then connect again.";
      case 0x6a80:
        return "The Ledger app refused the request. Update the app in Ledger Wallet, then try again.";
      default:
        return `The Ledger returned error 0x${err.status.toString(16).padStart(4, "0")}.`;
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong while talking to the Ledger.";
}
