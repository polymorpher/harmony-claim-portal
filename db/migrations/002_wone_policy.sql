-- WONE-aware claim fields, user-facing policy metadata, exchange custody, and
-- the terminal redistributed source-offset status.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS native_wallet_airdrop_atto numeric(78,0) NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS wone_balance_atto numeric(78,0) NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS wone_airdrop_atto numeric(78,0) NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS qualification_total_atto numeric(78,0) NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS native_total_claim_atto numeric(78,0) NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS policy_category text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS contract_subcategory text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS contract_identity text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS contract_treatment text;

ALTER TABLE routing_exceptions
  DROP CONSTRAINT IF EXISTS routing_exceptions_destination_status_check;
ALTER TABLE routing_exceptions
  ADD CONSTRAINT routing_exceptions_destination_status_check
  CHECK (destination_status IN ('ready', 'hold', 'not_issuing', 'redistributed'));

CREATE TABLE IF NOT EXISTS exchange_wallets (
  exchange_id                  text NOT NULL,
  display_name                 text NOT NULL,
  address                      char(42) NOT NULL,
  delivery_policy              text NOT NULL,
  qualification_status         text NOT NULL,
  planned_delivery_status      text NOT NULL,
  configured_destination       char(42),
  configured_destination_status text NOT NULL,
  PRIMARY KEY (exchange_id, address)
);
CREATE INDEX IF NOT EXISTS exchange_wallets_address_idx ON exchange_wallets (address);

INSERT INTO schema_migrations (version) VALUES ('002_wone_policy')
ON CONFLICT (version) DO NOTHING;
