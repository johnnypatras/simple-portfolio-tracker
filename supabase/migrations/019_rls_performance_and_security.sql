-- ================================================================
-- 019: RLS performance + security hardening
-- ================================================================
-- Fixes all Supabase Advisor warnings:
--
-- PERFORMANCE (22 warnings):
--   Wrap auth.uid() in (select auth.uid()) so Postgres evaluates
--   it once per statement instead of once per row.
--
-- SECURITY (2 warnings):
--   Pin search_path on SECURITY DEFINER functions to prevent
--   schema-injection attacks.
--
-- NOTE: "Leaked Password Protection" must be enabled manually
-- in Supabase Dashboard → Authentication → Settings.
-- ================================================================

BEGIN;

-- ── Profiles ────────────────────────────────────────────────────

DROP POLICY IF EXISTS "users_read_own_profile" ON profiles;
CREATE POLICY "users_read_own_profile" ON profiles
  FOR SELECT USING ((select auth.uid()) = id);

DROP POLICY IF EXISTS "users_update_own_profile" ON profiles;
CREATE POLICY "users_update_own_profile" ON profiles
  FOR UPDATE USING ((select auth.uid()) = id);

DROP POLICY IF EXISTS "users_delete_own_profile" ON profiles;
CREATE POLICY "users_delete_own_profile" ON profiles
  FOR DELETE USING ((select auth.uid()) = id);

-- ── Invite Codes ────────────────────────────────────────────────

DROP POLICY IF EXISTS "users_read_own_invites" ON invite_codes;
CREATE POLICY "users_read_own_invites" ON invite_codes
  FOR SELECT USING (
    (select auth.uid()) = created_by OR (select auth.uid()) = used_by
  );

DROP POLICY IF EXISTS "users_create_invites" ON invite_codes;
CREATE POLICY "users_create_invites" ON invite_codes
  FOR INSERT WITH CHECK ((select auth.uid()) = created_by);

-- ── Wallets ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "users_manage_own_wallets" ON wallets;
CREATE POLICY "users_manage_own_wallets" ON wallets
  FOR ALL USING ((select auth.uid()) = user_id);

-- ── Brokers ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "users_manage_own_brokers" ON brokers;
CREATE POLICY "users_manage_own_brokers" ON brokers
  FOR ALL USING ((select auth.uid()) = user_id);

-- ── Bank Accounts ───────────────────────────────────────────────

DROP POLICY IF EXISTS "users_manage_own_banks" ON bank_accounts;
CREATE POLICY "users_manage_own_banks" ON bank_accounts
  FOR ALL USING ((select auth.uid()) = user_id);

-- ── Crypto Assets ───────────────────────────────────────────────

DROP POLICY IF EXISTS "users_manage_own_crypto" ON crypto_assets;
CREATE POLICY "users_manage_own_crypto" ON crypto_assets
  FOR ALL USING ((select auth.uid()) = user_id);

-- ── Crypto Positions (join through crypto_assets) ───────────────

DROP POLICY IF EXISTS "users_manage_own_crypto_positions" ON crypto_positions;
CREATE POLICY "users_manage_own_crypto_positions" ON crypto_positions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM crypto_assets
      WHERE crypto_assets.id = crypto_positions.crypto_asset_id
      AND crypto_assets.user_id = (select auth.uid())
    )
  );

-- ── Goal Prices (join through crypto_assets) ────────────────────

DROP POLICY IF EXISTS "users_manage_own_goals" ON goal_prices;
CREATE POLICY "users_manage_own_goals" ON goal_prices
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM crypto_assets
      WHERE crypto_assets.id = goal_prices.crypto_asset_id
      AND crypto_assets.user_id = (select auth.uid())
    )
  );

-- ── Stock Assets ────────────────────────────────────────────────

DROP POLICY IF EXISTS "users_manage_own_stocks" ON stock_assets;
CREATE POLICY "users_manage_own_stocks" ON stock_assets
  FOR ALL USING ((select auth.uid()) = user_id);

-- ── Stock Positions (join through stock_assets) ─────────────────

DROP POLICY IF EXISTS "users_manage_own_stock_positions" ON stock_positions;
CREATE POLICY "users_manage_own_stock_positions" ON stock_positions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM stock_assets
      WHERE stock_assets.id = stock_positions.stock_asset_id
      AND stock_assets.user_id = (select auth.uid())
    )
  );

-- ── Exchange Deposits ───────────────────────────────────────────

DROP POLICY IF EXISTS "users_manage_own_deposits" ON exchange_deposits;
CREATE POLICY "users_manage_own_deposits" ON exchange_deposits
  FOR ALL USING ((select auth.uid()) = user_id);

-- ── Broker Deposits ─────────────────────────────────────────────

DROP POLICY IF EXISTS "users_manage_own_broker_deposits" ON broker_deposits;
CREATE POLICY "users_manage_own_broker_deposits" ON broker_deposits
  FOR ALL USING ((select auth.uid()) = user_id);

-- ── Trade Entries ───────────────────────────────────────────────

DROP POLICY IF EXISTS "users_manage_own_trades" ON trade_entries;
CREATE POLICY "users_manage_own_trades" ON trade_entries
  FOR ALL USING ((select auth.uid()) = user_id);

-- ── Activity Log ────────────────────────────────────────────────

DROP POLICY IF EXISTS "users_read_own_activity" ON activity_log;
CREATE POLICY "users_read_own_activity" ON activity_log
  FOR SELECT USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "users_insert_own_activity" ON activity_log;
CREATE POLICY "users_insert_own_activity" ON activity_log
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

-- ── Diary Entries ───────────────────────────────────────────────

DROP POLICY IF EXISTS "users_manage_own_diary" ON diary_entries;
CREATE POLICY "users_manage_own_diary" ON diary_entries
  FOR ALL USING ((select auth.uid()) = user_id);

-- ── Portfolio Snapshots ─────────────────────────────────────────

DROP POLICY IF EXISTS "users_read_own_snapshots" ON portfolio_snapshots;
CREATE POLICY "users_read_own_snapshots" ON portfolio_snapshots
  FOR SELECT USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "users_insert_own_snapshots" ON portfolio_snapshots;
CREATE POLICY "users_insert_own_snapshots" ON portfolio_snapshots
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "users_update_own_snapshots" ON portfolio_snapshots;
CREATE POLICY "users_update_own_snapshots" ON portfolio_snapshots
  FOR UPDATE USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "users_delete_own_snapshots" ON portfolio_snapshots;
CREATE POLICY "users_delete_own_snapshots" ON portfolio_snapshots
  FOR DELETE USING ((select auth.uid()) = user_id);

-- ── Institutions ────────────────────────────────────────────────

DROP POLICY IF EXISTS "users_manage_own_institutions" ON institutions;
CREATE POLICY "users_manage_own_institutions" ON institutions
  FOR ALL USING ((select auth.uid()) = user_id);

-- ================================================================
-- SECURITY: Pin search_path on SECURITY DEFINER functions
-- ================================================================

-- sync_institution_name: propagates institution name to child entities
CREATE OR REPLACE FUNCTION sync_institution_name()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE wallets SET name = NEW.name WHERE institution_id = NEW.id;
    UPDATE brokers SET name = NEW.name WHERE institution_id = NEW.id;
    UPDATE bank_accounts SET bank_name = NEW.name WHERE institution_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- update_updated_at: generic trigger for auto-setting updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

COMMIT;
