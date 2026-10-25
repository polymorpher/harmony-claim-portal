import { hexToBech32 } from "@hcp/shared";
import { sha256, toHex, type Address, type Hex } from "viem";
import { english, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

/** The path the Harmony Ledger apps derive addresses on: m/44'/1023'/0'/0/N. */
export const HARMONY_BRANCH = "m/44'/1023'/0'/0";

export interface DerivedKey {
  index: number;
  path: string;
  address: Address;
  one1: string;
  privateKey: Hex;
}

/** Recovery phrase as BIP-39 hashes it: NFKD, lower case, single spaces. */
export function normalizePhrase(text: string): string {
  return text.normalize("NFKD").toLowerCase().trim().split(/\s+/).filter(Boolean).join(" ");
}

/** Why the phrase is not a valid English BIP-39 recovery phrase, or null when it is. */
export function phraseProblem(phrase: string): string | null {
  const words = phrase ? phrase.split(" ") : [];
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    return `A recovery phrase has 12, 18 or 24 words; this has ${words.length}.`;
  }
  const unknown = words.filter((w) => !english.includes(w));
  if (unknown.length > 0) {
    return `Not in the recovery-phrase word list: ${[...new Set(unknown)].join(", ")}. Check the spelling.`;
  }
  const bits = words.map((w) => english.indexOf(w).toString(2).padStart(11, "0")).join("");
  const entropyBits = (words.length * 11 * 32) / 33;
  const entropy = new Uint8Array(entropyBits / 8);
  for (let i = 0; i < entropy.length; i++) entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const hash = sha256(entropy, "bytes");
  const expected = Array.from(hash, (b) => b.toString(2).padStart(8, "0"))
    .join("")
    .slice(0, entropyBits / 32);
  if (bits.slice(entropyBits) !== expected) {
    return "The words are all valid, but the phrase's checksum does not match: a word is wrong or out of order.";
  }
  return null;
}

/**
 * Keys `from` to `from + count - 1` on the Harmony path. `passphrase` is the optional BIP-39
 * passphrase (Ledger's "passphrase" setting), used exactly as typed. The seed is computed once.
 */
export function deriveHarmonyKeys(phrase: string, passphrase: string, from: number, count: number): DerivedKey[] {
  // viem types the path as an Ethereum one; @scure/bip32 derives any BIP-32 path.
  const path = HARMONY_BRANCH as `m/44'/60'/${string}`;
  const branch = mnemonicToAccount(phrase, { passphrase, path }).getHdKey();
  const out: DerivedKey[] = [];
  for (let index = from; index < from + count; index++) {
    const privateKey = toHex(branch.deriveChild(index).privateKey!);
    const address = privateKeyToAccount(privateKey).address;
    out.push({ index, path: `${HARMONY_BRANCH}/${index}`, address, one1: hexToBech32(address.toLowerCase()), privateKey });
  }
  return out;
}
