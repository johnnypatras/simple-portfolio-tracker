-- 003_cashflow_columns.sql
-- Pre-computed cashflow and delta status tracking on activity_log

-- New columns for cashflow values
ALTER TABLE activity_log ADD COLUMN cashflow_amount_usd NUMERIC(18,2);
ALTER TABLE activity_log ADD COLUMN cashflow_amount_eur NUMERIC(18,2);
ALTER TABLE activity_log ADD COLUMN cashflow_asset_class TEXT;
ALTER TABLE activity_log ADD COLUMN cashflow_status TEXT;
ALTER TABLE activity_log ADD COLUMN delta_status TEXT;
ALTER TABLE activity_log ADD COLUMN cashflow_attempted_at TIMESTAMPTZ;
ALTER TABLE activity_log ADD COLUMN delta_attempted_at TIMESTAMPTZ;

-- Partial indexes for backfill queries
CREATE INDEX idx_activity_log_pending_cashflows
  ON activity_log (user_id) WHERE cashflow_status = 'pending';
CREATE INDEX idx_activity_log_pending_deltas
  ON activity_log (user_id) WHERE delta_status = 'pending';

-- Seed delta_status = 'pending' for legacy adjustment rows with NULL deltas
-- (FX failures before status tracking existed). Without this, backfill won't find them.
UPDATE activity_log
SET delta_status = 'pending'
WHERE is_adjustment = true
  AND delta_usd IS NULL
  AND delta_status IS NULL
  AND undone_at IS NULL
  AND entity_type IN (
    'crypto_position', 'stock_position',
    'exchange_deposit', 'broker_deposit', 'bank_account'
  );
