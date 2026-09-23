import { randomBytes } from "node:crypto";
import { getAddress, keccak256, recoverAddress, verifyMessage, type Address, type Hex } from "viem";
import {
  harmonyLedgerTx,
  type ConfirmationChallenge,
  type ConfirmationReceipt,
  type ConfirmationStatus,
  type SignatureScheme,
} from "@hcp/shared";
import { addressForms } from "../address.js";
import { confirmationMessage } from "./message.js";
import type { ConfirmStore } from "./store.js";

export class ConfirmError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ConfirmError";
    this.statusCode = statusCode;
  }
}

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const NONCE = /^[0-9a-f]{64}$/;
const ISSUED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NOT_ELIGIBLE =
  "This wallet cannot be confirmed here. Only wallets left out because they had no Harmony activity in the six months before the cutoff can use this page.";
const ALREADY_CONFIRMED = "This wallet has already confirmed activity.";
const BAD_REQUEST = "This signing request is invalid. Try again.";
const CLOCK_SKEW_MS = 60_000;

export interface ConfirmServiceOptions {
  domain: string;
  challengeTtlSeconds: number;
  now?: () => Date;
}

function sameSignature(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export async function signatureMatches(
  scheme: SignatureScheme,
  address: Address,
  message: string,
  signature: Hex,
): Promise<boolean> {
  try {
    if (scheme === "personal_sign") return await verifyMessage({ address, message, signature });
    const signer = await recoverAddress({ hash: keccak256(harmonyLedgerTx(address, message)), signature });
    return signer.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}

export class ConfirmService {
  private now: () => Date;

  constructor(
    private store: ConfirmStore,
    private opts: ConfirmServiceOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  async status(address: string): Promise<ConfirmationStatus> {
    const forms = addressForms(address);
    const candidate = await this.store.findCandidate(address);
    if (!candidate) {
      return {
        address: forms,
        eligible: false,
        stage_reason: null,
        data_version: null,
        policy_version: null,
        confirmation: null,
      };
    }
    const existing = await this.store.findConfirmation(address, candidate.data_version, candidate.policy_version);
    return {
      address: forms,
      eligible: true,
      stage_reason: candidate.stage_reason,
      data_version: candidate.data_version,
      policy_version: candidate.policy_version,
      confirmation: existing
        ? {
            recorded_at: existing.created_at,
            data_version: existing.data_version,
            policy_version: existing.policy_version,
          }
        : null,
    };
  }

  async challenge(address: string): Promise<ConfirmationChallenge> {
    const candidate = await this.store.findCandidate(address);
    if (!candidate) throw new ConfirmError(403, NOT_ELIGIBLE);
    const existing = await this.store.findConfirmation(address, candidate.data_version, candidate.policy_version);
    if (existing) throw new ConfirmError(409, ALREADY_CONFIRMED);
    const forms = addressForms(address);
    const issuedAt = this.now().toISOString();
    const nonce = randomBytes(32).toString("hex");
    const message = this.messageFor(candidate, forms.checksum, issuedAt, nonce);
    return {
      address: forms,
      message,
      nonce,
      issued_at: issuedAt,
      expires_at: new Date(this.now().getTime() + this.opts.challengeTtlSeconds * 1000).toISOString(),
      data_version: candidate.data_version,
      policy_version: candidate.policy_version,
    };
  }

  async submit(
    address: string,
    nonce: string,
    issuedAt: string,
    signature: string,
    signedVersion?: { dataVersion: string; policyVersion: string },
    scheme: SignatureScheme = "personal_sign",
  ): Promise<ConfirmationReceipt> {
    if (!NONCE.test(nonce) || !ISSUED.test(issuedAt)) throw new ConfirmError(400, BAD_REQUEST);
    if (!SIGNATURE.test(signature)) throw new ConfirmError(400, BAD_REQUEST);
    const issuedMs = Date.parse(issuedAt);
    const nowMs = this.now().getTime();
    if (issuedMs > nowMs + CLOCK_SKEW_MS) throw new ConfirmError(400, "This confirmation is not valid yet.");
    if (nowMs - issuedMs > this.opts.challengeTtlSeconds * 1000) throw new ConfirmError(400, "This confirmation expired. Sign again.");

    const candidate = await this.store.findCandidate(address);
    if (!candidate) throw new ConfirmError(403, NOT_ELIGIBLE);
    if (
      signedVersion &&
      (signedVersion.dataVersion !== candidate.data_version ||
        signedVersion.policyVersion !== candidate.policy_version)
    ) {
      throw new ConfirmError(409, "The migration data was updated. Sign again.");
    }

    const existing = await this.store.findConfirmation(address, candidate.data_version, candidate.policy_version);
    if (existing) return this.replay(address, existing, signature);

    const message = this.messageFor(candidate, getAddress(address), issuedAt, nonce);
    if (!(await signatureMatches(scheme, getAddress(address), message, signature as Hex))) {
      throw new ConfirmError(400, "The signature does not match this wallet and message.");
    }

    const result = await this.store.insertConfirmation({
      address,
      dataVersion: candidate.data_version,
      policyVersion: candidate.policy_version,
      stageReason: candidate.stage_reason,
      message,
      signature,
      signatureScheme: scheme,
      signer: address,
    });
    if (result.ok) {
      return {
        address: addressForms(address),
        data_version: candidate.data_version,
        policy_version: candidate.policy_version,
        recorded_at: result.created_at,
        status: "recorded",
      };
    }
    if (result.reason === "conflict") {
      const again = await this.store.findConfirmation(address, candidate.data_version, candidate.policy_version);
      if (again) return this.replay(address, again, signature);
    }
    throw new ConfirmError(409, "The migration data was updated. Sign again.");
  }

  private messageFor(
    candidate: { cutoff_time_utc: string; policy_version: string; data_version: string },
    checksum: string,
    issuedAt: string,
    nonce: string,
  ): string {
    return confirmationMessage({
      domain: this.opts.domain,
      address: checksum,
      nonce,
      issuedAt,
      cutoffTime: candidate.cutoff_time_utc,
      policyVersion: candidate.policy_version,
      dataVersion: candidate.data_version,
    });
  }

  private replay(address: string, existing: { signature: string; data_version: string; policy_version: string; created_at: string }, signature: string): ConfirmationReceipt {
    if (!sameSignature(existing.signature, signature)) {
      throw new ConfirmError(409, ALREADY_CONFIRMED);
    }
    return {
      address: addressForms(address),
      data_version: existing.data_version,
      policy_version: existing.policy_version,
      recorded_at: existing.created_at,
      status: "recorded",
    };
  }
}
