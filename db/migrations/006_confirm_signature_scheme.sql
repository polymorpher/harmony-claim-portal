-- Which signing method produced each confirmation. Rows written before this
-- migration are personal_sign. harmony_ledger_tx rows come from the pre-2025
-- Harmony Ledger app, which signs a zero-gas Harmony transaction instead of a
-- message; shared/src/harmony-ledger-tx.ts defines the signed bytes.
-- The confirm role's table-level INSERT grant covers the new column.

ALTER TABLE confirm.confirmations
  ADD COLUMN IF NOT EXISTS signature_scheme text NOT NULL DEFAULT 'personal_sign'
    CONSTRAINT confirmations_signature_scheme_check
    CHECK (signature_scheme IN ('personal_sign', 'harmony_ledger_tx'));

INSERT INTO schema_migrations (version) VALUES ('006_confirm_signature_scheme')
ON CONFLICT (version) DO NOTHING;
