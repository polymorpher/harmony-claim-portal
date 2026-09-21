-- Separate snapshot qualification from migration stage, issuance treatment,
-- and routing readiness. These fields come from the reviewed stage-policy and
-- compiled routing artifacts.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS stage_policy_applied boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS migration_stage text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS issuance_treatment text NOT NULL DEFAULT 'issue';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS stage_reason text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS migration_wallet_allocation_atto numeric(78,0) NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS migration_staked_to_vault_atto numeric(78,0) NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS migration_allocation_atto numeric(78,0) NOT NULL DEFAULT 0;

ALTER TABLE routing_exceptions ADD COLUMN IF NOT EXISTS migration_stage text;
ALTER TABLE routing_exceptions ADD COLUMN IF NOT EXISTS issuance_treatment text;

ALTER TABLE exchange_wallets ADD COLUMN IF NOT EXISTS migration_stage text;
ALTER TABLE exchange_wallets ADD COLUMN IF NOT EXISTS issuance_treatment text;

ALTER TABLE validator_vaults ADD COLUMN IF NOT EXISTS initial_assets_atto numeric(78,0) NOT NULL DEFAULT 0;
ALTER TABLE validator_vaults ADD COLUMN IF NOT EXISTS next_stage_assets_atto numeric(78,0) NOT NULL DEFAULT 0;
ALTER TABLE validator_vaults ADD COLUMN IF NOT EXISTS qualified_deferred_assets_atto numeric(78,0) NOT NULL DEFAULT 0;
ALTER TABLE validator_vaults ADD COLUMN IF NOT EXISTS manual_review_assets_atto numeric(78,0) NOT NULL DEFAULT 0;
ALTER TABLE validator_vaults ADD COLUMN IF NOT EXISTS uncompiled_deferred_assets_atto numeric(78,0) NOT NULL DEFAULT 0;
ALTER TABLE validator_vaults ADD COLUMN IF NOT EXISTS not_issued_assets_atto numeric(78,0) NOT NULL DEFAULT 0;
ALTER TABLE validator_vaults ADD COLUMN IF NOT EXISTS post_policy_assets_atto numeric(78,0) NOT NULL DEFAULT 0;

INSERT INTO schema_migrations (version) VALUES ('003_migration_stages')
ON CONFLICT (version) DO NOTHING;
