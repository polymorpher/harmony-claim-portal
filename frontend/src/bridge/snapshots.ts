import { chainName } from "../chains";
import { formatDate, formatUtc } from "../format";
import { BRIDGE, type BridgeDeployments, type SnapshotBlock, type SnapshotLabel } from "./deployments";
import type { BridgeRow } from "./proofs";

/** Display name of a chain label used in the snapshot data, including "harmony". */
export function holderChainName(label: string, deployments: BridgeDeployments = BRIDGE): string {
  if (label === "harmony") return "Harmony";
  const contract = deployments.contracts.find((c) => c.label === label);
  return contract ? chainName(contract.chain_id) : label;
}

/** Chain labels with Harmony first, then the contract list's order. */
export function snapshotChains(deployments: BridgeDeployments = BRIDGE): string[] {
  const order = ["harmony", ...deployments.contracts.map((c) => c.label)];
  const rank = (label: string) => (order.includes(label) ? order.indexOf(label) : order.length);
  return Object.keys(deployments.snapshots.blocks).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** "10 September 2026, 14:00:00 UTC" */
export function formatMoment(iso: string): string {
  return `${formatDate(iso)}, ${iso.slice(11, 19)} UTC`;
}

/** The moment a snapshot label stands for: Harmony's block for it. */
export function momentOf(label: SnapshotLabel, deployments: BridgeDeployments = BRIDGE): string {
  return deployments.snapshots.blocks.harmony![label]!.time;
}

export interface SnapshotSource {
  holders: string;
  snapshot: SnapshotLabel;
  block: SnapshotBlock;
}

/** Assets whose rows come from the same balances: the same holder chains at the same moments. */
export interface SnapshotBasis {
  key: string;
  symbols: string[];
  sources: SnapshotSource[];
}

export function snapshotBases(rows: BridgeRow[], deployments: BridgeDeployments = BRIDGE): SnapshotBasis[] {
  const chains = snapshotChains(deployments);
  const out = new Map<string, SnapshotBasis>();
  for (const row of rows) {
    const sources = new Map<string, SnapshotSource>();
    for (const pool of row.asset.pools) {
      const block = deployments.snapshots.blocks[pool.holders]![pool.snapshot]!;
      sources.set(`${pool.holders}:${pool.snapshot}`, { holders: pool.holders, snapshot: pool.snapshot, block });
    }
    const sorted = [...sources.values()].sort((a, b) => chains.indexOf(a.holders) - chains.indexOf(b.holders));
    const key = sorted.map((s) => `${s.holders}:${s.snapshot}`).join("+");
    const basis = out.get(key) ?? { key, symbols: [], sources: sorted };
    if (!basis.symbols.includes(row.asset.symbol)) basis.symbols.push(row.asset.symbol);
    out.set(key, basis);
  }
  return [...out.values()];
}

export function joinList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** How a basis reads on the page, e.g. "balances of the bridged tokens on Harmony at the cutoff". */
export function describeBasis(basis: SnapshotBasis, deployments: BridgeDeployments = BRIDGE) {
  const holders = [...new Set(basis.sources.map((s) => s.holders))];
  const labels = [...new Set(basis.sources.map((s) => s.snapshot))];
  const what =
    holders.length === 1 && holders[0] === "harmony"
      ? `balances of the bridged ${basis.symbols.length === 1 ? "token" : "tokens"} on Harmony`
      : `balances of bridged ${joinList(basis.symbols)} on ${joinList(holders.map((h) => holderChainName(h, deployments)))}`;
  const moment = labels.length === 1 ? labels[0] : null;
  const when = moment === "cutoff" ? "at the cutoff" : moment === "rollback" ? "just before Harmony's rollback" : "at their snapshots";
  const blocks = basis.sources
    .map((s) => `${holderChainName(s.holders, deployments)} block ${s.block.number.toLocaleString("en-US")} (${formatUtc(s.block.time)})`)
    .join("; ");
  return { what, when, moment: moment ? momentOf(moment, deployments) : null, blocks };
}

/** Chains other than Harmony whose own balances count at `label`, in display order. */
export function remoteHoldersAt(label: SnapshotLabel, deployments: BridgeDeployments = BRIDGE): string[] {
  return snapshotChains(deployments).filter(
    (chain) =>
      chain !== "harmony" &&
      deployments.contracts.some((c) => c.assets.some((a) => a.pools.some((p) => p.holders === chain && p.snapshot === label))),
  );
}


/** Per holder chain: which balances count there, at which moments, e.g. "bridged ONE before the rollback". */
export function countedOn(holders: string, deployments: BridgeDeployments = BRIDGE): string | null {
  const byLabel = new Map<SnapshotLabel, Set<string>>();
  for (const contract of deployments.contracts) {
    for (const asset of contract.assets) {
      for (const pool of asset.pools) {
        if (pool.holders !== holders) continue;
        const symbols = byLabel.get(pool.snapshot) ?? new Set<string>();
        symbols.add(asset.symbol);
        byLabel.set(pool.snapshot, symbols);
      }
    }
  }
  if (byLabel.size === 0) return null;
  const order: SnapshotLabel[] = ["cutoff", "rollback"];
  return order
    .filter((label) => byLabel.has(label))
    .map((label) => {
      const symbols = [...byLabel.get(label)!];
      const what = holders === "harmony" ? "bridged tokens" : `bridged ${joinList(symbols)}`;
      return `${what} ${label === "cutoff" ? "at the cutoff" : "before the rollback"}`;
    })
    .join("; ");
}
