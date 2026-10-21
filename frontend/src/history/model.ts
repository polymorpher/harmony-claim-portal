import { isBech32Address, isHexAddress, type ArchiveRecord } from "@hcp/shared";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export type HistoryQuery = { type: "address"; value: string } | { type: "tx"; value: string };

/** What the search box holds: an address (0x… or one1…) or a 32-byte transaction hash. */
export function parseQuery(input: string): HistoryQuery | null {
  const value = input.trim();
  if (HASH_RE.test(value)) return { type: "tx", value: value.toLowerCase() };
  if (isHexAddress(value) || isBech32Address(value)) return { type: "address", value };
  return null;
}

export function historyPath(query: HistoryQuery): string {
  return `/history/${query.type === "tx" ? "tx" : "address"}/${encodeURIComponent(query.value)}`;
}

/** /history, /history/address/<address>, /history/tx/<hash>. */
export function parseHistoryPath(path: string): HistoryQuery | null {
  const match = /^\/history\/(address|tx)\/([^/]+)$/.exec(path);
  if (!match) return null;
  let value: string;
  try {
    value = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  const parsed = parseQuery(value);
  if (!parsed) return null;
  return parsed.type === match[1] ? parsed : null;
}

const KIND_LABELS: Record<string, Record<string, string>> = {
  transaction: {
    transfer: "Transfer",
    call: "Contract call",
    create: "Contract creation",
    xshard_native: "Cross-shard transfer",
    xshard_precompile: "Cross-shard transfer (precompile)",
  },
  internal: {
    call: "Internal transfer",
    callcode: "Internal transfer",
    create: "Internal contract creation",
    selfdestruct: "Self-destruct payout",
  },
  staking: {
    Delegate: "Delegate",
    Undelegate: "Undelegate",
    CreateValidator: "Create validator",
    CollectRewards: "Collect rewards",
  },
};

export function recordLabel(record: Pick<ArchiveRecord, "record_type" | "kind">): string {
  if (record.record_type === "cross_shard") return "Cross-shard receipt";
  return KIND_LABELS[record.record_type]?.[record.kind] ?? record.kind;
}

export type Direction = "in" | "out" | "self";

export function direction(record: Pick<ArchiveRecord, "from" | "to">, addressHex: string): Direction {
  const self = addressHex.toLowerCase();
  const from = record.from.toLowerCase() === self;
  const to = (record.to ?? "").toLowerCase() === self;
  if (from && to) return "self";
  return from ? "out" : "in";
}

/** Short warnings shown next to a record; empty when it is final and succeeded. */
export function recordFlags(record: ArchiveRecord): string[] {
  const flags: string[] = [];
  if (record.branch === "rolled_back") flags.push("Rolled back, not final");
  if (record.status === "failed") {
    flags.push(record.record_type === "internal" ? "Reverted, not moved" : "Failed, value not moved");
  }
  if (record.record_type === "cross_shard" && record.ancestor_reverted) {
    flags.push("Created inside a reverted call");
  }
  return flags;
}

export function shardText(record: Pick<ArchiveRecord, "shard" | "to_shard">): string {
  return record.to_shard !== null && record.to_shard !== record.shard
    ? `${record.shard} → ${record.to_shard}`
    : String(record.shard);
}

export function destinationText(record: ArchiveRecord): string | null {
  const dest = record.destination;
  if (!dest) return null;
  if (dest.status === "credited") {
    return `Credited on shard ${record.to_shard} in block ${dest.block_number?.toLocaleString("en-US") ?? "?"}`;
  }
  if (dest.status === "not_found") return `Not credited on shard ${record.to_shard}`;
  if (dest.status === "unmapped") return "Destination not checked";
  return `Destination record differs (${dest.status})`;
}
