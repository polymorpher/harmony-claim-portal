-- Transaction archive: the full calldata of archived transactions and the
-- function signatures their selectors most likely name. Loaded by
-- injector/inject_archive.py in the same staging swap as archive_records.
--
-- input: calldata of a plain transaction (null for other record types and for
-- plain transfers). Only the transaction lookup reads it, so address pages never
-- touch the TOAST data.
-- archive_methods: selector -> signature from a public signature database;
-- verified = a verified contract uses the signature. A label, not a proof.

BEGIN;

ALTER TABLE archive_records ADD COLUMN IF NOT EXISTS input bytea;

CREATE TABLE IF NOT EXISTS archive_methods (
  selector   bytea PRIMARY KEY,
  signature  text NOT NULL,
  verified   boolean NOT NULL,
  candidates integer NOT NULL,
  source     text NOT NULL
);

INSERT INTO schema_migrations (version) VALUES ('010_tx_archive_calldata')
ON CONFLICT (version) DO NOTHING;

COMMIT;
