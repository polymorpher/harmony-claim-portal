-- Synthetic confirmation candidates for local development. These addresses are
-- the portal's fixture wallets, not Harmony mainnet accounts. Do not load this
-- file into the public database.
--
--   psql "$CONFIRM_OWNER_URL" -v ON_ERROR_STOP=1 -f db/ops/fixture-candidates.sql

BEGIN;
TRUNCATE confirm.candidates;
INSERT INTO confirm.candidates
  (address, account_category, stage_reason, data_version, policy_version, cutoff_time_utc)
VALUES
  (
    '0x6666666666666666666666666666666666666666',
    'ordinary_eoa',
    'wallet activity predates initial window',
    'fixture-1',
    'fixture',
    '2026-09-10T14:00:00Z'
  );
INSERT INTO confirm.candidate_loads
  (data_version, policy_version, cutoff_time_utc, row_count, sha256)
VALUES
  ('fixture-1', 'fixture', '2026-09-10T14:00:00Z', 1, 'fixture');
COMMIT;
