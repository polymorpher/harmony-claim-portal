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

/**
 * Links use a query string, so a shared or reloaded link always loads the real
 * /history object from the bucket instead of its 404 fallback.
 */
export function historyPath(query: HistoryQuery): string {
  return `/history?${query.type === "tx" ? "tx" : "address"}=${encodeURIComponent(query.value)}`;
}

function typed(type: string, value: string): HistoryQuery | null {
  const parsed = parseQuery(value);
  return parsed && parsed.type === type ? parsed : null;
}

/** /history?address=<address>, /history?tx=<hash>, and the older /history/address/<address> and /history/tx/<hash>. */
export function parseHistoryLocation(path: string, search: string): HistoryQuery | null {
  const params = new URLSearchParams(search);
  for (const type of ["address", "tx"] as const) {
    const value = params.get(type);
    if (value !== null) return typed(type, value);
  }
  const match = /^\/history\/(address|tx)\/([^/]+)$/.exec(path);
  if (!match) return null;
  try {
    return typed(match[1], decodeURIComponent(match[2]));
  } catch {
    return null;
  }
}

/** Whether the location names a record that could not be parsed. */
export function isMalformedHistoryLocation(path: string, search: string): boolean {
  const params = new URLSearchParams(search);
  const named = path !== "/history" || params.has("address") || params.has("tx");
  return named && parseHistoryLocation(path, search) === null;
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

/** Whether the calldata is contract creation code rather than a function call. */
export function isCreation(record: Pick<ArchiveRecord, "record_type" | "kind">): boolean {
  return record.record_type === "transaction" && record.kind === "create";
}

/** "transfer(address,uint256)" -> "transfer". */
export function functionName(signature: string): string {
  const open = signature.indexOf("(");
  return open > 0 ? signature.slice(0, open) : signature;
}

/** Short function label for a call; null for creations, whose leading bytes are code. */
export function callLabel(record: Pick<ArchiveRecord, "record_type" | "kind" | "method_name">): string | null {
  if (isCreation(record) || !record.method_name) return null;
  return functionName(record.method_name);
}

export function calldataSize(input: string): number {
  return (input.length - 2) / 2;
}

/** Selector, then one 32-byte argument word per line, the layout block explorers use. */
export function calldataLines(input: string): string[] {
  const body = input.slice(2);
  if (body.length <= 8) return [input];
  const lines = [`0x${body.slice(0, 8)}`];
  for (let i = 8; i < body.length; i += 64) lines.push(body.slice(i, i + 64));
  return lines;
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
