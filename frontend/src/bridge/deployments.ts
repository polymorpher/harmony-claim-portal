import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { chainById } from "../chains";
import published from "./deployments.json";

export const DEPLOYMENTS_FORMAT = "bridge-deployments/v1";
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";

export type SnapshotLabel = "cutoff" | "rollback";

/** A bridge pool behind an asset's rows: whose balances count (`holders`, a chain label) and at which moment. */
export interface AssetPool {
  id: string;
  holders: string;
  snapshot: SnapshotLabel;
}

export interface BridgeAsset {
  token: Address;
  symbol: string;
  decimals: number;
  pools: AssetPool[];
}

export interface SnapshotBlock {
  number: number;
  time: string;
}

export interface Snapshots {
  /** Per chain label ("harmony", "ethereum", ...): its block at the cutoff, before the rollback, and where escrows were read ("state"). */
  blocks: Record<string, Partial<Record<SnapshotLabel | "state", SnapshotBlock>>>;
  /** ONE deliveries a chain received from Harmony's rolled-back blocks. */
  orphaned_one_deliveries: Record<string, number>;
}

/** One BridgeClaims contract, as `injector/build_bridge_proofs.py` checked it against its run. */
export interface BridgeContract {
  label: string;
  chain_id: number;
  address: Address;
  funder: Address;
  wrapped_native: Address | null;
  root: Hex;
  claim_count: number;
  list_sha256: string;
  manifest_sha256: string;
  runtime_keccak256: Hex;
  deploy_tx: Hex;
  deploy_block: number;
  assets: BridgeAsset[];
}

export interface BridgeDeployments {
  format: string;
  run: string;
  published_url: string;
  published_index_sha256: string;
  proof_prefix_digits: number;
  snapshots: Snapshots;
  contracts: BridgeContract[];
}

const isHash = (value: unknown): value is Hex => typeof value === "string" && isHex(value) && value.length === 66;

export function checkDeployments(raw: unknown): BridgeDeployments {
  const d = raw as BridgeDeployments;
  if (!d || d.format !== DEPLOYMENTS_FORMAT) throw new Error("The bridge contract list has an unknown format.");
  if (!Number.isInteger(d.proof_prefix_digits) || d.proof_prefix_digits < 1 || d.proof_prefix_digits > 4) {
    throw new Error("The bridge contract list has a bad proof prefix length.");
  }
  const blocks = d.snapshots?.blocks ?? {};
  const isBlock = (b: SnapshotBlock | undefined) => !!b && Number.isSafeInteger(b.number) && !Number.isNaN(Date.parse(b.time));
  if (!isBlock(blocks.harmony?.cutoff) || !isBlock(blocks.harmony?.rollback)) {
    throw new Error("The bridge contract list has no Harmony cutoff or rollback block.");
  }
  const labels = new Set<string>();
  const contracts = d.contracts.map((c) => {
    if (labels.has(c.label)) throw new Error(`The bridge contract list names ${c.label} twice.`);
    labels.add(c.label);
    chainById(c.chain_id);
    if (!isAddress(c.address) || !isAddress(c.funder) || (c.wrapped_native !== null && !isAddress(c.wrapped_native))) {
      throw new Error(`The bridge contract list has a bad address for ${c.label}.`);
    }
    if (!isHash(c.root) || !isHash(c.runtime_keccak256) || !Number.isSafeInteger(c.claim_count) || c.claim_count <= 0) {
      throw new Error(`The bridge contract list has a bad root, code hash, or row count for ${c.label}.`);
    }
    const assets = c.assets.map((a) => {
      if (!isAddress(a.token) || !Number.isInteger(a.decimals) || a.decimals < 0 || a.decimals > 36) {
        throw new Error(`The bridge contract list has a bad asset for ${c.label}.`);
      }
      const known = (p: AssetPool) => (p.snapshot === "cutoff" || p.snapshot === "rollback") && isBlock(blocks[p.holders]?.[p.snapshot]);
      if (!Array.isArray(a.pools) || a.pools.length === 0 || !a.pools.every(known)) {
        throw new Error(`The bridge contract list has no snapshot block for ${a.symbol} on ${c.label}.`);
      }
      return { ...a, token: getAddress(a.token) };
    });
    if (assets.some((a) => a.token === NATIVE) !== (c.wrapped_native !== null)) {
      throw new Error(`The bridge contract list disagrees with itself about the native coin on ${c.label}.`);
    }
    return {
      ...c,
      address: getAddress(c.address),
      funder: getAddress(c.funder),
      wrapped_native: c.wrapped_native ? getAddress(c.wrapped_native) : null,
      root: c.root.toLowerCase() as Hex,
      runtime_keccak256: c.runtime_keccak256.toLowerCase() as Hex,
      assets,
    };
  });
  return { ...d, contracts };
}

export const BRIDGE = checkDeployments(published);

export const PROOFS_URL = (import.meta.env.VITE_BRIDGE_PROOFS_URL || `${BRIDGE.published_url}/proofs`).replace(/\/+$/, "");

export function contractByLabel(label: string, deployments: BridgeDeployments = BRIDGE): BridgeContract | undefined {
  return deployments.contracts.find((c) => c.label === label);
}

export function assetOf(contract: BridgeContract, token: string): BridgeAsset | undefined {
  const target = token.toLowerCase();
  return contract.assets.find((a) => a.token.toLowerCase() === target);
}

/** The published claim list and manifest of one contract. */
export function listUrls(contract: BridgeContract, deployments: BridgeDeployments = BRIDGE) {
  const base = `${deployments.published_url}/${contract.label}`;
  return { claims: `${base}/claims.csv`, manifest: `${base}/manifest.json`, tree: `${base}/tree.txt` };
}
