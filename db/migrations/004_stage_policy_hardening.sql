-- Backfill the brief schema-before-data-load transition and enforce the
-- independent stage/treatment/component invariants accepted by the importer.

UPDATE routing_exceptions
   SET issuance_treatment = CASE destination_status
     WHEN 'not_issuing' THEN 'not_issued'
     WHEN 'redistributed' THEN 'redistributed'
     ELSE 'issue'
   END
 WHERE issuance_treatment IS NULL;
ALTER TABLE routing_exceptions ALTER COLUMN issuance_treatment SET DEFAULT 'issue';
ALTER TABLE routing_exceptions ALTER COLUMN issuance_treatment SET NOT NULL;

UPDATE exchange_wallets
   SET issuance_treatment = 'issue'
 WHERE issuance_treatment IS NULL;
ALTER TABLE exchange_wallets ALTER COLUMN issuance_treatment SET DEFAULT 'issue';
ALTER TABLE exchange_wallets ALTER COLUMN issuance_treatment SET NOT NULL;

UPDATE validator_vaults
   SET post_policy_assets_atto = vault_assets_atto
 WHERE initial_assets_atto = 0
   AND next_stage_assets_atto = 0
   AND qualified_deferred_assets_atto = 0
   AND manual_review_assets_atto = 0
   AND uncompiled_deferred_assets_atto = 0
   AND not_issued_assets_atto = 0
   AND post_policy_assets_atto = 0;

ALTER TABLE accounts ADD CONSTRAINT accounts_migration_stage_check
  CHECK (migration_stage IS NULL OR migration_stage IN ('initial', 'next_stage', 'deferred', 'manual_review', 'below_threshold'));
ALTER TABLE accounts ADD CONSTRAINT accounts_issuance_treatment_check
  CHECK (issuance_treatment IN ('issue', 'not_issued'));
ALTER TABLE accounts ADD CONSTRAINT accounts_migration_allocation_nonnegative_check
  CHECK (
    migration_wallet_allocation_atto >= 0 AND
    migration_staked_to_vault_atto >= 0 AND
    migration_allocation_atto >= 0
  );
ALTER TABLE accounts ADD CONSTRAINT accounts_migration_allocation_closure_check
  CHECK (migration_wallet_allocation_atto + migration_staked_to_vault_atto = migration_allocation_atto);
ALTER TABLE accounts ADD CONSTRAINT accounts_terminal_stage_check
  CHECK (
    issuance_treatment <> 'not_issued' OR
    (migration_stage IS NULL AND migration_allocation_atto = 0)
  );

ALTER TABLE routing_exceptions ADD CONSTRAINT routing_exceptions_migration_stage_check
  CHECK (migration_stage IS NULL OR migration_stage IN ('initial', 'next_stage', 'deferred', 'manual_review'));
ALTER TABLE routing_exceptions ADD CONSTRAINT routing_exceptions_issuance_treatment_check
  CHECK (issuance_treatment IN ('issue', 'not_issued', 'redistributed'));
ALTER TABLE routing_exceptions ADD CONSTRAINT routing_exceptions_terminal_treatment_check
  CHECK (
    (destination_status = 'not_issuing' AND issuance_treatment = 'not_issued') OR
    (destination_status = 'redistributed' AND issuance_treatment = 'redistributed') OR
    (destination_status IN ('ready', 'hold') AND issuance_treatment = 'issue')
  );

ALTER TABLE exchange_wallets ADD CONSTRAINT exchange_wallets_migration_stage_check
  CHECK (migration_stage IS NULL OR migration_stage IN ('initial', 'next_stage', 'deferred', 'manual_review', 'below_threshold'));
ALTER TABLE exchange_wallets ADD CONSTRAINT exchange_wallets_issuance_treatment_check
  CHECK (issuance_treatment IN ('issue', 'not_issued'));

ALTER TABLE validator_vaults ADD CONSTRAINT validator_vaults_stage_nonnegative_check
  CHECK (
    initial_assets_atto >= 0 AND
    next_stage_assets_atto >= 0 AND
    qualified_deferred_assets_atto >= 0 AND
    manual_review_assets_atto >= 0 AND
    uncompiled_deferred_assets_atto >= 0 AND
    not_issued_assets_atto >= 0 AND
    post_policy_assets_atto >= 0
  );
ALTER TABLE validator_vaults ADD CONSTRAINT validator_vaults_policy_closure_check
  CHECK (post_policy_assets_atto + not_issued_assets_atto = vault_assets_atto);

INSERT INTO schema_migrations (version) VALUES ('004_stage_policy_hardening')
ON CONFLICT (version) DO NOTHING;
