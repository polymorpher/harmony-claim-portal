-- Confirmations attested outside the site, for candidate wallets whose holder
-- confirmed activity to us directly instead of signing. db/ops/record-attestation.sh
-- writes them as the owner role. Such a row has signature_scheme 'attestation',
-- no signature and no signer, and records who attested and the SHA-256 of their
-- statement. Reviews reference it like any confirmation, and its
-- (address, data_version, policy_version) blocks a later signature for the same
-- candidate set.

BEGIN;

ALTER TABLE confirm.confirmations ADD COLUMN IF NOT EXISTS attested_by text;
ALTER TABLE confirm.confirmations ADD COLUMN IF NOT EXISTS evidence_sha256 text;
ALTER TABLE confirm.confirmations ALTER COLUMN signature DROP NOT NULL;
ALTER TABLE confirm.confirmations ALTER COLUMN signer DROP NOT NULL;

ALTER TABLE confirm.confirmations DROP CONSTRAINT IF EXISTS confirmations_signature_scheme_check;
ALTER TABLE confirm.confirmations ADD CONSTRAINT confirmations_signature_scheme_check
  CHECK (signature_scheme IN ('personal_sign', 'harmony_ledger_tx', 'attestation'));

ALTER TABLE confirm.confirmations DROP CONSTRAINT IF EXISTS confirmations_evidence_check;
ALTER TABLE confirm.confirmations ADD CONSTRAINT confirmations_evidence_check CHECK (
  CASE WHEN signature_scheme = 'attestation' THEN
    signature IS NULL AND signer IS NULL
    AND attested_by IS NOT NULL AND attested_by !~ '[[:cntrl:]]' AND length(attested_by) BETWEEN 1 AND 80
    AND evidence_sha256 IS NOT NULL AND evidence_sha256 ~ '^[0-9a-f]{64}$'
  ELSE
    signature IS NOT NULL AND signer IS NOT NULL AND attested_by IS NULL AND evidence_sha256 IS NULL
  END
);

-- claim_confirm holds table-level INSERT, which the confirm API's startup check
-- requires, so a grant cannot keep it from writing an attestation; this does.
CREATE OR REPLACE FUNCTION confirm.attestations_by_owner_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.signature_scheme = 'attestation' AND NOT pg_catalog.pg_has_role(
       current_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE') THEN
    RAISE EXCEPTION 'only the table owner records attestations (db/ops/record-attestation.sh)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS confirmations_attestations_by_owner_only ON confirm.confirmations;
CREATE TRIGGER confirmations_attestations_by_owner_only
  BEFORE INSERT OR UPDATE ON confirm.confirmations
  FOR EACH ROW EXECUTE FUNCTION confirm.attestations_by_owner_only();

INSERT INTO schema_migrations (version) VALUES ('008_confirm_attestation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
