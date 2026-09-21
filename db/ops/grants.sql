-- Runtime grants for the claim lookup and confirmation roles.
-- Apply as the database owner or a superuser, after 005_confirm_schema.sql
-- and after claim_read / claim_confirm exist:
--   db/ops/setup-roles.sh
--
-- claim_read can select the public ledger and nothing in schema confirm.
-- claim_confirm can insert confirmation evidence.
-- It cannot update that evidence, the candidate list, or any ledger table.

BEGIN;

DO $$
DECLARE
  db text := current_database();
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', db);
  EXECUTE format('GRANT CONNECT, TEMP, CREATE ON DATABASE %I TO claimapi', db);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO claim_read, claim_confirm', db);
END $$;

GRANT ALL ON SCHEMA public TO claimapi;
GRANT ALL ON SCHEMA confirm TO claimapi;
GRANT ALL ON ALL TABLES IN SCHEMA public TO claimapi;
GRANT ALL ON ALL TABLES IN SCHEMA confirm TO claimapi;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO claimapi;
GRANT ALL ON ALL SEQUENCES IN SCHEMA confirm TO claimapi;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO claim_read;

REVOKE ALL ON SCHEMA confirm FROM PUBLIC;
GRANT USAGE ON SCHEMA confirm TO claim_confirm;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO claim_read;
ALTER DEFAULT PRIVILEGES FOR ROLE claimapi GRANT SELECT ON TABLES TO claim_read;
ALTER DEFAULT PRIVILEGES FOR ROLE claimapi IN SCHEMA public GRANT SELECT ON TABLES TO claim_read;

GRANT SELECT ON confirm.candidates TO claim_confirm;
GRANT SELECT, INSERT ON confirm.confirmations TO claim_confirm;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA confirm TO claim_confirm;

-- Future sequences created by the owner in schema confirm stay usable.
-- Future tables are not granted: reviews and candidate_loads must stay owner-only.
ALTER DEFAULT PRIVILEGES FOR ROLE claimapi IN SCHEMA confirm
  GRANT USAGE, SELECT ON SEQUENCES TO claim_confirm;

COMMIT;
