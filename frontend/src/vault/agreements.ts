import { createPublicClient, fallback, http, parseAbi, type Hex, type PublicClient } from "viem";
import { base } from "viem/chains";
import type { CatalogVault } from "./catalog";

/** governors.country: each validator's governor agreement, a MetaLeX cyberSign agreement on Base. */
export const AGREEMENTS_SITE = "https://governors.country/";
export const AGREEMENT_REGISTRY = "0xa9E808B8eCBB60Bb19abF026B5b863215BC4c134";
const BASE_RPC_URLS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co"];

// The getter returns more fields; the signature count is the second word, which is what governors.country reads.
const registryAbi = parseAbi(["function agreements(bytes32) view returns (bytes32 templateId, uint256 numSignatures)"]);

export function agreementUrl(id: Hex): string {
  return `https://app.metalex.tech/cybersign/8453/${id}`;
}

let client: PublicClient | null = null;

function baseClient(): PublicClient {
  client ??= createPublicClient({
    chain: base,
    transport: fallback(BASE_RPC_URLS.map((url) => http(url, { retryCount: 1, timeout: 15_000 }))),
  }) as PublicClient;
  return client;
}

/** Agreement id (lower case) to whether it is signed, read live from the registry. */
export async function readAgreements(ids: Hex[]): Promise<Map<string, boolean>> {
  const results = await baseClient().multicall({
    contracts: ids.map((id) => ({ address: AGREEMENT_REGISTRY, abi: registryAbi, functionName: "agreements", args: [id] }) as const),
    allowFailure: true,
    batchSize: 32_768,
  });
  const out = new Map<string, boolean>();
  results.forEach((r, i) => {
    if (r.status === "success") out.set(ids[i].toLowerCase(), r.result[1] > 0n);
  });
  return out;
}

/** Live statuses once read, and the date of the catalog's snapshot shown until then (or if the read fails). */
export interface AgreementInfo {
  live: Map<string, boolean> | undefined;
  asOf: string | null;
}

export interface AgreementStatus {
  /** `none`: governors.country has no agreement for this validator. */
  state: "signed" | "unsigned" | "none";
  url: string | null;
  /** False while the live read is pending or failed and the catalog's snapshot is shown. */
  live: boolean;
}

/** The live status when known, else the catalog's snapshot. */
export function agreementStatus(vault: CatalogVault, live: Map<string, boolean> | undefined): AgreementStatus {
  if (!vault.agreement) return { state: "none", url: null, live: true };
  const known = live?.get(vault.agreement.id.toLowerCase());
  const signed = known ?? vault.agreement.signed;
  return { state: signed ? "signed" : "unsigned", url: agreementUrl(vault.agreement.id), live: known !== undefined };
}
