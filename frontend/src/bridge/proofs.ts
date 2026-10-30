import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { chainName } from "../chains";
import { assetOf, BRIDGE, PROOFS_URL, type BridgeAsset, type BridgeContract, type BridgeDeployments } from "./deployments";
import { claimLeaf, verifyProof } from "./merkle";

export const PROOFS_FORMAT = "bridge-proofs/v1";
const MAX_PROOF = 64;

/** One row of a claim list with its proof, checked against the contract's root. */
export interface BridgeRow {
  contract: BridgeContract;
  asset: BridgeAsset;
  index: number;
  account: Address;
  amount: bigint;
  proof: Hex[];
}

interface ShardRow {
  index: number;
  token: string;
  amount: string;
  proof: string[];
}

interface Shard {
  format: string;
  run: string;
  prefix: string;
  accounts: Record<string, Record<string, ShardRow[]>>;
}

export class ProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofError";
  }
}

/** The proof file an address is in: the first `digits` hex digits after 0x. */
export function shardPrefix(account: Address, digits: number = BRIDGE.proof_prefix_digits): string {
  return account.slice(2, 2 + digits).toLowerCase();
}

export function shardUrl(account: Address, base: string = PROOFS_URL, digits: number = BRIDGE.proof_prefix_digits): string {
  return `${base}/${shardPrefix(account, digits)}.json`;
}

/**
 * The account's rows in a proof file. Every row must name a known contract and asset and its proof
 * must lead to that contract's root, so a wrong or tampered file can only leave rows out.
 */
export function rowsFromShard(raw: unknown, account: Address, deployments: BridgeDeployments = BRIDGE): BridgeRow[] {
  const shard = raw as Shard;
  if (!shard || shard.format !== PROOFS_FORMAT || typeof shard.accounts !== "object" || shard.accounts === null) {
    throw new ProofError("The claim list file has an unknown format.");
  }
  if (shard.run !== deployments.run) throw new ProofError(`The claim list file is from ${String(shard.run)}, not ${deployments.run}.`);
  if (shard.prefix !== shardPrefix(account, deployments.proof_prefix_digits)) {
    throw new ProofError("The claim list file does not cover this address.");
  }
  const payee = account.toLowerCase() as Address;
  const byChain = Object.prototype.hasOwnProperty.call(shard.accounts, payee) ? shard.accounts[payee] : undefined;
  if (!byChain) return [];

  const rows: BridgeRow[] = [];
  for (const [label, list] of Object.entries(byChain)) {
    const contract = deployments.contracts.find((c) => c.label === label);
    if (!contract) throw new ProofError(`The claim list file names an unknown chain, ${label}.`);
    const name = chainName(contract.chain_id);
    if (!Array.isArray(list)) throw new ProofError(`The claim list file has bad ${name} rows.`);
    const seen = new Set<number>();
    for (const r of list) {
      const index = r?.index;
      if (!Number.isSafeInteger(index) || index < 0 || index >= contract.claim_count || seen.has(index)) {
        throw new ProofError(`The claim list file has a bad ${name} row number.`);
      }
      seen.add(index);
      const asset = typeof r.token === "string" && isAddress(r.token, { strict: false }) ? assetOf(contract, r.token) : undefined;
      if (!asset) throw new ProofError(`${name} row ${index} names a token the contract does not pay.`);
      if (typeof r.amount !== "string" || !/^[1-9]\d{0,77}$/.test(r.amount)) throw new ProofError(`${name} row ${index} has a bad amount.`);
      const proof = r.proof;
      if (!Array.isArray(proof) || proof.length > MAX_PROOF || !proof.every((p) => typeof p === "string" && isHex(p) && p.length === 66)) {
        throw new ProofError(`${name} row ${index} has a bad proof.`);
      }
      const amount = BigInt(r.amount);
      const token = asset.token.toLowerCase() as Address;
      if (!verifyProof(proof as Hex[], contract.root, claimLeaf(index, payee, token, amount))) {
        throw new ProofError(`The proof of ${name} row ${index} does not match the contract's list.`);
      }
      rows.push({ contract, asset, index, account: getAddress(payee), amount, proof: proof.map((p) => p.toLowerCase() as Hex) });
    }
  }
  const order = new Map(deployments.contracts.map((c, i) => [c.label, i]));
  return rows.sort((a, b) => order.get(a.contract.label)! - order.get(b.contract.label)! || a.index - b.index);
}

export const PROOF_TIMEOUT_MS = 30_000;

function downloadError(err: unknown): ProofError {
  return (err as { name?: string } | null)?.name === "TimeoutError"
    ? new ProofError(`The claim list did not load within ${PROOF_TIMEOUT_MS / 1000} seconds. Check your connection and try again.`)
    : new ProofError("The claim list could not be downloaded. Check your connection and try again.");
}

export async function loadRows(account: Address): Promise<BridgeRow[]> {
  const signal = AbortSignal.timeout(PROOF_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(shardUrl(account), { signal });
  } catch (err) {
    throw downloadError(err);
  }
  if (!res.ok) throw new ProofError(`The claim list could not be loaded (HTTP ${res.status}).`);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    throw err instanceof SyntaxError ? new ProofError("The claim list file is not valid JSON.") : downloadError(err);
  }
  return rowsFromShard(raw, account);
}
