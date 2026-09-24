-- Exchange wallets leave the airdrop: every confirmed exchange inventory row
-- compiles into the exchange_manual stage with issuance treatment
-- manual_from_reserve, and is delivered by hand from the 2050 supply reserve
-- to the destination(s) the exchange confirmed. Delegated principal owned by
-- exchange wallets is released from the validator vaults.

BEGIN;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_migration_stage_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_migration_stage_check
  CHECK (migration_stage IS NULL OR migration_stage IN
    ('initial', 'exchange_manual', 'next_stage', 'deferred', 'manual_review', 'below_threshold'));
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_issuance_treatment_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_issuance_treatment_check
  CHECK (issuance_treatment IN ('issue', 'manual_from_reserve', 'not_issued'));
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_exchange_manual_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_exchange_manual_check
  CHECK ((migration_stage IS NOT DISTINCT FROM 'exchange_manual') = (issuance_treatment = 'manual_from_reserve'));

ALTER TABLE routing_exceptions DROP CONSTRAINT IF EXISTS routing_exceptions_destination_status_check;
ALTER TABLE routing_exceptions ADD CONSTRAINT routing_exceptions_destination_status_check
  CHECK (destination_status IN ('ready', 'hold', 'exchange_manual', 'not_issuing', 'redistributed'));
ALTER TABLE routing_exceptions DROP CONSTRAINT IF EXISTS routing_exceptions_migration_stage_check;
ALTER TABLE routing_exceptions ADD CONSTRAINT routing_exceptions_migration_stage_check
  CHECK (migration_stage IS NULL OR migration_stage IN
    ('initial', 'exchange_manual', 'next_stage', 'deferred', 'manual_review'));
ALTER TABLE routing_exceptions DROP CONSTRAINT IF EXISTS routing_exceptions_issuance_treatment_check;
ALTER TABLE routing_exceptions ADD CONSTRAINT routing_exceptions_issuance_treatment_check
  CHECK (issuance_treatment IN ('issue', 'manual_from_reserve', 'not_issued', 'redistributed'));
ALTER TABLE routing_exceptions DROP CONSTRAINT IF EXISTS routing_exceptions_terminal_treatment_check;
ALTER TABLE routing_exceptions ADD CONSTRAINT routing_exceptions_terminal_treatment_check
  CHECK (
    (destination_status = 'not_issuing' AND issuance_treatment = 'not_issued') OR
    (destination_status = 'redistributed' AND issuance_treatment = 'redistributed') OR
    (destination_status = 'exchange_manual' AND issuance_treatment = 'manual_from_reserve') OR
    (destination_status = 'hold' AND issuance_treatment IN ('issue', 'manual_from_reserve')) OR
    (destination_status = 'ready' AND issuance_treatment = 'issue')
  );

ALTER TABLE exchange_wallets ADD COLUMN IF NOT EXISTS destination_mode text;
ALTER TABLE exchange_wallets ADD COLUMN IF NOT EXISTS delivery_tier text;
ALTER TABLE exchange_wallets ADD COLUMN IF NOT EXISTS planned_wallet_destination char(42);
ALTER TABLE exchange_wallets ADD COLUMN IF NOT EXISTS planned_staking_destination char(42);
ALTER TABLE exchange_wallets DROP CONSTRAINT IF EXISTS exchange_wallets_migration_stage_check;
ALTER TABLE exchange_wallets ADD CONSTRAINT exchange_wallets_migration_stage_check
  CHECK (migration_stage IS NULL OR migration_stage IN
    ('initial', 'exchange_manual', 'next_stage', 'deferred', 'manual_review', 'below_threshold'));
ALTER TABLE exchange_wallets DROP CONSTRAINT IF EXISTS exchange_wallets_issuance_treatment_check;
ALTER TABLE exchange_wallets ADD CONSTRAINT exchange_wallets_issuance_treatment_check
  CHECK (issuance_treatment IN ('issue', 'manual_from_reserve', 'not_issued'));
ALTER TABLE exchange_wallets DROP CONSTRAINT IF EXISTS exchange_wallets_destination_mode_check;
ALTER TABLE exchange_wallets ADD CONSTRAINT exchange_wallets_destination_mode_check
  CHECK (destination_mode IS NULL OR destination_mode IN
    ('aggregate', 'aggregate_split', 'same_address', 'tiered'));

ALTER TABLE validator_vaults ADD COLUMN IF NOT EXISTS exchange_manual_assets_atto numeric(78,0) NOT NULL DEFAULT 0;
ALTER TABLE validator_vaults DROP CONSTRAINT IF EXISTS validator_vaults_stage_nonnegative_check;
ALTER TABLE validator_vaults ADD CONSTRAINT validator_vaults_stage_nonnegative_check
  CHECK (
    initial_assets_atto >= 0 AND
    exchange_manual_assets_atto >= 0 AND
    next_stage_assets_atto >= 0 AND
    qualified_deferred_assets_atto >= 0 AND
    manual_review_assets_atto >= 0 AND
    uncompiled_deferred_assets_atto >= 0 AND
    not_issued_assets_atto >= 0 AND
    post_policy_assets_atto >= 0
  );
ALTER TABLE validator_vaults DROP CONSTRAINT IF EXISTS validator_vaults_policy_closure_check;
ALTER TABLE validator_vaults ADD CONSTRAINT validator_vaults_policy_closure_check
  CHECK (post_policy_assets_atto + not_issued_assets_atto + exchange_manual_assets_atto = vault_assets_atto);

INSERT INTO schema_migrations (version) VALUES ('007_exchange_manual_delivery')
ON CONFLICT (version) DO NOTHING;

COMMIT;
