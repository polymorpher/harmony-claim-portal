/**
 * Wire types for the transaction archive (/history): a fixed record of Harmony
 * transactions of at least 1 ONE, kept after the Harmony explorer shut down.
 */
import type { AddressForms } from "./api-types.js";

export type ArchiveRecordType = "transaction" | "internal" | "cross_shard" | "staking";
export type ArchiveBranch = "canonical" | "rolled_back";

export interface ArchiveDestination {
  /** credited | not_found | mismatch | unmapped */
  status: string;
  block_number: number | null;
  block_hash: string | null;
  time_utc: string | null;
}

export interface ArchiveRecord {
  /** Chronological position; also the pagination cursor. */
  id: string;
  record_type: ArchiveRecordType;
  /**
   * transaction: transfer | call | create | xshard_native | xshard_precompile
   * internal: call | callcode | create | selfdestruct
   * cross_shard: native | precompile | precompile_replay_incompatible[_delegatecall] | precompile_delegatecall
   * staking: Delegate | Undelegate | CreateValidator | CollectRewards
   */
  kind: string;
  shard: number;
  to_shard: number | null;
  branch: ArchiveBranch;
  block_number: number;
  block_hash: string;
  time_utc: string;
  tx_index: number;
  trace_address: string | null;
  tx_hash: string;
  eth_hash: string | null;
  /** lowercase 0x hex */
  from: string;
  to: string | null;
  value_atto: string;
  value_one: string;
  fee_atto: string | null;
  /** Receipt status, or for internal transfers whether no enclosing call reverted. */
  status: "success" | "failed";
  method: string | null;
  /** cross_shard only: the receipt was created inside a reverted call (credited before the epoch-2964 fix). */
  ancestor_reverted: boolean | null;
  destination: ArchiveDestination | null;
}

export interface ArchiveCoverage {
  shard: number;
  branch: ArchiveBranch;
  start_block: number;
  end_block: number;
  start_time_utc: string | null;
  end_time_utc: string | null;
}

export interface ArchiveMetaResponse {
  available: boolean;
  min_value_atto: string | null;
  min_value_one: string | null;
  data_version: string | null;
  loaded_at: string | null;
  fixture: boolean;
  coverage: ArchiveCoverage[];
  notes: string[];
  row_counts: Record<string, number>;
}

export interface ArchiveAddressResponse {
  address: AddressForms;
  records: ArchiveRecord[];
  /** Pass as ?before= to fetch the next (older) page; null when there is none. */
  next_before: string | null;
}

export interface ArchiveTxResponse {
  hash: string;
  records: ArchiveRecord[];
}
