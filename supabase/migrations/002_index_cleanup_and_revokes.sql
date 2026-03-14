-- Add missing FK indexes (cascade_soft_delete trigger + JOIN performance)
CREATE INDEX IF NOT EXISTS idx_broker_deposits_broker ON broker_deposits(broker_id);
CREATE INDEX IF NOT EXISTS idx_crypto_positions_wallet ON crypto_positions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_exchange_deposits_wallet ON exchange_deposits(wallet_id);
CREATE INDEX IF NOT EXISTS idx_stock_positions_broker ON stock_positions(broker_id);

-- Drop redundant indexes (covered by existing unique/composite indexes)
DROP INDEX IF EXISTS idx_crypto_assets_active;   -- covered by uq_crypto_assets_active
DROP INDEX IF EXISTS idx_trade_entries_active;    -- covered by idx_trade_entries_user_date
-- Note: portfolio_shares_token_key is a UNIQUE constraint, not droppable via DROP INDEX.
-- The partial index idx_portfolio_shares_token covers all actual lookups. Keeping the
-- constraint for schema correctness (token uniqueness is a business rule).

-- REVOKE trigger functions from anon/authenticated (least privilege).
-- These are only invoked by their triggers (as postgres), never via PostgREST RPC.
REVOKE EXECUTE ON FUNCTION cascade_soft_delete() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION sync_institution_name() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION update_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION rls_auto_enable() FROM PUBLIC, anon, authenticated;

-- REVOKE table grants on cron_config (RLS blocks access, but REVOKE is defense-in-depth)
REVOKE ALL ON TABLE cron_config FROM anon, authenticated;
