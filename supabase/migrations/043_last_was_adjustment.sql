-- Add last_was_adjustment flag to all 5 entity tables.
-- Tracks whether the most recent save was marked as a portfolio adjustment,
-- so the UI can show a persistent "adj" badge inside editors/modals.

ALTER TABLE crypto_positions ADD COLUMN last_was_adjustment BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE stock_positions ADD COLUMN last_was_adjustment BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bank_accounts ADD COLUMN last_was_adjustment BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE broker_deposits ADD COLUMN last_was_adjustment BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE exchange_deposits ADD COLUMN last_was_adjustment BOOLEAN NOT NULL DEFAULT false;
