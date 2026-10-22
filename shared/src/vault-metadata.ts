/**
 * Off-chain governor vault metadata. The name is the only field a governor
 * can change today. The database keeps a `fields` object for later fields;
 * this module does not accept them until a change is defined here.
 */

export const VAULT_NAME_MAX = 80;

const CONTROLS = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

/** Trimmed NFC name, or null when it cannot be stored or signed. */
export function normalizeVaultName(raw: string): string | null {
  const name = raw.normalize("NFC").trim();
  if (name.length < 1 || name.length > VAULT_NAME_MAX) return null;
  if (CONTROLS.test(name)) return null;
  return name;
}

export interface VaultNameMessageInput {
  domain: string;
  /** EIP-55 checksum of the vault. */
  vault: string;
  name: string;
  /** Canonical UTC timestamp, `YYYY-MM-DDTHH:mm:ss.sssZ`. */
  issuedAt: string;
  nonce: string;
}

/** Exact bytes the governor signs. The server rebuilds this string; it is not trusted from the client. */
export function vaultNameMessage(input: VaultNameMessageInput): string {
  return [
    `${input.domain} governor vault name`,
    "",
    `Domain: ${input.domain}`,
    `Vault: ${input.vault}`,
    `Name: ${input.name}`,
    "This signature sets the public name of this governor vault.",
    "It does not transfer funds or change the vault's governor, fee, or balances.",
    `Issued: ${input.issuedAt}`,
    `Nonce: ${input.nonce}`,
  ].join("\n");
}

export interface VaultNameRecord {
  /** Lowercase 0x vault address. */
  vault: string;
  name: string;
  updated_at: string;
}

export interface VaultMetadataResponse {
  vaults: VaultNameRecord[];
}

export interface VaultNameChallenge {
  /** EIP-55 checksum, the address written into the signed message. */
  vault: string;
  name: string;
  message: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
}

export interface VaultNameSubmission {
  vault: string;
  name: string;
  nonce: string;
  issued_at: string;
  signature: string;
  signature_scheme?: string;
}
