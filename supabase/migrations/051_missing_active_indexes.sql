-- Partial indexes for soft-deletable tables missing them.
-- Migration 024 covered crypto_assets, stock_assets, wallets, brokers.
-- This adds the remaining three.

CREATE INDEX IF NOT EXISTS idx_bank_accounts_active
  ON bank_accounts(user_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_trade_entries_active
  ON trade_entries(user_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_diary_entries_active
  ON diary_entries(user_id) WHERE deleted_at IS NULL;

-- Activity-log indexes for deriveCashFlows() and adjustment queries
-- that run on every dashboard/detail page load.

CREATE INDEX IF NOT EXISTS idx_activity_log_cashflows
  ON activity_log(user_id, created_at DESC)
  WHERE is_adjustment = false AND undone_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_activity_log_adjustments
  ON activity_log(user_id)
  WHERE is_adjustment = true AND undone_at IS NULL AND delta_usd IS NOT NULL;
