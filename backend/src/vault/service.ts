import { randomBytes } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import {
  isSignatureScheme,
  normalizeVaultName,
  vaultNameMessage,
  type SignatureScheme,
  type VaultNameChallenge,
  type VaultNameRecord,
} from "@hcp/shared";
import { normalizeAddress } from "../address.js";
import { signatureMatches } from "../confirm/service.js";
import { VaultChainError, type VaultChain } from "./chain.js";
import type { VaultMetadataStore } from "./store.js";

export class VaultMetadataError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "VaultMetadataError";
    this.statusCode = statusCode;
  }
}

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const NONCE = /^[0-9a-f]{64}$/;
const ISSUED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CLOCK_SKEW_MS = 60_000;
const BAD_NAME = "Enter a name of 1 to 80 characters, without a line break.";
const BAD_REQUEST = "This signing request is invalid. Try again.";
const NOT_VAULT = "That address is not a deployed governor vault.";
const NOT_GOVERNOR = "Only this vault's governor can change its name.";
const STALE = "This vault's name was changed more recently. Sign again.";

export interface VaultNameServiceOptions {
  domain: string;
  challengeTtlSeconds: number;
  now?: () => Date;
}

export class VaultNameService {
  private now: () => Date;

  constructor(
    private store: VaultMetadataStore,
    private chain: VaultChain,
    private opts: VaultNameServiceOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  async list(): Promise<VaultNameRecord[]> {
    return this.store.list();
  }

  async challenge(vaultRaw: string, nameRaw: string): Promise<VaultNameChallenge> {
    const name = normalizeVaultName(nameRaw);
    if (!name) throw new VaultMetadataError(400, BAD_NAME);
    const vault = getAddress(normalizeAddress(vaultRaw));
    const issuedAt = this.now().toISOString();
    const nonce = randomBytes(32).toString("hex");
    return {
      vault,
      name,
      message: vaultNameMessage({ domain: this.opts.domain, vault, name, issuedAt, nonce }),
      nonce,
      issued_at: issuedAt,
      expires_at: new Date(this.now().getTime() + this.opts.challengeTtlSeconds * 1000).toISOString(),
    };
  }

  async submit(
    vaultRaw: string,
    nameRaw: string,
    nonce: string,
    issuedAt: string,
    signature: string,
    scheme: SignatureScheme,
  ): Promise<VaultNameRecord> {
    if (!NONCE.test(nonce) || !ISSUED.test(issuedAt) || !SIGNATURE.test(signature)) {
      throw new VaultMetadataError(400, BAD_REQUEST);
    }
    const name = normalizeVaultName(nameRaw);
    if (!name) throw new VaultMetadataError(400, BAD_NAME);
    const issuedMs = Date.parse(issuedAt);
    const nowMs = this.now().getTime();
    if (issuedMs > nowMs + CLOCK_SKEW_MS) throw new VaultMetadataError(400, "This name change is not valid yet.");
    if (nowMs - issuedMs > this.opts.challengeTtlSeconds * 1000) {
      throw new VaultMetadataError(400, "This name change expired. Sign again.");
    }

    const vault = getAddress(normalizeAddress(vaultRaw));
    const governor = await this.governor(vault);
    const message = vaultNameMessage({ domain: this.opts.domain, vault, name, issuedAt, nonce });
    if (!(await signatureMatches(scheme, governor, message, signature as Hex))) {
      throw new VaultMetadataError(400, NOT_GOVERNOR);
    }

    const result = await this.store.apply({
      vault: vault.toLowerCase(),
      name,
      message,
      signature,
      signer: governor.toLowerCase(),
      issuedAt,
    });
    if (!result.ok) throw new VaultMetadataError(409, STALE);
    return result.row;
  }

  private async governor(vault: Address): Promise<Address> {
    try {
      const governor = await this.chain.governorOf(vault);
      if (!governor) throw new VaultMetadataError(400, NOT_VAULT);
      return governor;
    } catch (err) {
      if (err instanceof VaultMetadataError) throw err;
      if (err instanceof VaultChainError) throw new VaultMetadataError(503, err.message);
      throw new VaultMetadataError(503, new VaultChainError().message);
    }
  }
}

export function readSignatureScheme(value: unknown): SignatureScheme {
  const scheme = value ?? "personal_sign";
  if (!isSignatureScheme(scheme)) {
    throw new VaultMetadataError(400, "signature_scheme must be personal_sign or harmony_ledger_tx");
  }
  return scheme;
}
