-- Transaction archive: a fixed record of Harmony transactions of at least 1 ONE
-- from 2025-01-01 to the end of the chain, for the /history page. Built by
-- harmony-migration (docs/tx-archive.md) and loaded by injector/inject_archive.py
-- through its own staging-schema swap, so loading claims never touches these
-- tables and loading the archive never touches the claim tables.
--
-- One row per record, of four types:
--   transaction  a plain transaction (kind: transfer, call, create, xshard_native, xshard_precompile)
--   internal     a value-moving trace frame (kind: call, callcode, create, selfdestruct)
--   cross_shard  an outgoing cross-shard receipt (kind: native, precompile, ...)
--   staking      a staking transaction (kind: Delegate, Undelegate, CreateValidator, CollectRewards)
-- id is assigned by the injector in chronological order (time, shard, block,
-- transaction index, record type, trace order), so ORDER BY id DESC is newest
-- first and serves as the pagination cursor.
-- Hashes and addresses are raw bytes; amounts are atto-ONE.

BEGIN;

CREATE TABLE IF NOT EXISTS archive_meta (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_records (
  id                bigint PRIMARY KEY,
  record_type       text NOT NULL CHECK (record_type IN ('transaction', 'internal', 'cross_shard', 'staking')),
  kind              text NOT NULL,
  shard             smallint NOT NULL CHECK (shard IN (0, 1)),
  to_shard          smallint,
  rolled_back       boolean NOT NULL,
  block_number      bigint NOT NULL,
  block_hash        bytea NOT NULL,
  block_time        timestamptz NOT NULL,
  tx_index          integer NOT NULL,
  trace_address     text,
  tx_hash           bytea NOT NULL,
  eth_hash          bytea,
  from_addr         bytea NOT NULL,
  to_addr           bytea,
  value_atto        numeric(78,0) NOT NULL,
  fee_atto          numeric(78,0),
  -- transaction/staking: receipt status; internal: 1 when no frame up to the root reverted;
  -- cross_shard: 1 (the receipt exists)
  status            smallint NOT NULL CHECK (status IN (0, 1)),
  method            bytea,
  ancestor_reverted boolean,
  dest_status       text,
  dest_block_number bigint,
  dest_block_hash   bytea,
  dest_time         timestamptz
);
CREATE INDEX IF NOT EXISTS archive_records_tx_hash_idx ON archive_records (tx_hash);
CREATE INDEX IF NOT EXISTS archive_records_eth_hash_idx ON archive_records (eth_hash) WHERE eth_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS archive_records_from_idx ON archive_records (from_addr, id DESC);
CREATE INDEX IF NOT EXISTS archive_records_to_idx ON archive_records (to_addr, id DESC) INCLUDE (from_addr);

INSERT INTO schema_migrations (version) VALUES ('009_tx_archive')
ON CONFLICT (version) DO NOTHING;

COMMIT;
