-- 004_rls_active_status_check.sql
-- Add profile status check to all RLS policies.
-- Prevents pending (unapproved) users from accessing data tables.
-- Only profiles table is exempt (pending users need to read/update their own profile).

-- Helper function: returns true if current auth user has status = 'active'
CREATE OR REPLACE FUNCTION public.is_active_user() RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND status = 'active'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = 'public';

COMMENT ON FUNCTION public.is_active_user() IS
  'Returns true if the current auth user has active profile status. Used in RLS policies to enforce invite-only access.';

-- ── Tables with ALL policies (simple uid = user_id) ──

ALTER POLICY "users_manage_own_banks" ON bank_accounts
  USING (( SELECT auth.uid()) = user_id AND is_active_user());

ALTER POLICY "users_manage_own_broker_deposits" ON broker_deposits
  USING (( SELECT auth.uid()) = user_id AND is_active_user());

ALTER POLICY "users_manage_own_brokers" ON brokers
  USING (( SELECT auth.uid()) = user_id AND is_active_user());

ALTER POLICY "users_manage_own_crypto" ON crypto_assets
  USING (( SELECT auth.uid()) = user_id AND is_active_user());

ALTER POLICY "users_manage_own_deposits" ON exchange_deposits
  USING (( SELECT auth.uid()) = user_id AND is_active_user());

ALTER POLICY "users_manage_own_institutions" ON institutions
  USING (( SELECT auth.uid()) = user_id AND is_active_user());

ALTER POLICY "users_manage_own_stocks" ON stock_assets
  USING (( SELECT auth.uid()) = user_id AND is_active_user());

ALTER POLICY "users_manage_own_trades" ON trade_entries
  USING (( SELECT auth.uid()) = user_id AND is_active_user());

ALTER POLICY "users_manage_own_wallets" ON wallets
  USING (( SELECT auth.uid()) = user_id AND is_active_user());

ALTER POLICY "users_manage_own_diary" ON diary_entries
  USING (( SELECT auth.uid()) = user_id AND is_active_user());

-- ── activity_log (4 separate policies) ──

ALTER POLICY "users_read_own_activity" ON activity_log
  USING (( SELECT auth.uid()) = user_id AND is_active_user());

ALTER POLICY "users_insert_own_activity" ON activity_log
  WITH CHECK (( SELECT auth.uid()) = user_id AND is_active_user());

ALTER POLICY "users_update_own_activity" ON activity_log
  USING (( SELECT auth.uid()) = user_id AND is_active_user())
  WITH CHECK (( SELECT auth.uid()) = user_id AND is_active_user());

ALTER POLICY "users_delete_own_activity" ON activity_log
  USING (( SELECT auth.uid()) = user_id AND is_active_user());

-- ── portfolio_snapshots (4 separate policies) ──

ALTER POLICY "users_read_own_snapshots" ON portfolio_snapshots
  USING (( SELECT auth.uid()) = user_id AND is_active_user());

ALTER POLICY "users_insert_own_snapshots" ON portfolio_snapshots
  WITH CHECK (( SELECT auth.uid()) = user_id AND is_active_user());

ALTER POLICY "users_update_own_snapshots" ON portfolio_snapshots
  USING (( SELECT auth.uid()) = user_id AND is_active_user())
  WITH CHECK (( SELECT auth.uid()) = user_id AND is_active_user());

ALTER POLICY "users_delete_own_snapshots" ON portfolio_snapshots
  USING (( SELECT auth.uid()) = user_id AND is_active_user());

-- ── Child tables (EXISTS via parent + active check) ──

ALTER POLICY "users_manage_own_crypto_positions" ON crypto_positions
  USING (EXISTS (
    SELECT 1 FROM crypto_assets
    WHERE crypto_assets.id = crypto_positions.crypto_asset_id
      AND crypto_assets.user_id = ( SELECT auth.uid())
  ) AND is_active_user());

ALTER POLICY "users_manage_own_stock_positions" ON stock_positions
  USING (EXISTS (
    SELECT 1 FROM stock_assets
    WHERE stock_assets.id = stock_positions.stock_asset_id
      AND stock_assets.user_id = ( SELECT auth.uid())
  ) AND is_active_user());

ALTER POLICY "users_manage_own_goals" ON goal_prices
  USING (EXISTS (
    SELECT 1 FROM crypto_assets
    WHERE crypto_assets.id = goal_prices.crypto_asset_id
      AND crypto_assets.user_id = ( SELECT auth.uid())
  ) AND is_active_user());

-- ── invite_codes (INSERT only — pending users shouldn't create invites) ──

ALTER POLICY "users_create_invites" ON invite_codes
  WITH CHECK (( SELECT auth.uid()) = created_by AND is_active_user());
-- SELECT stays as-is (pending users can see their own used invite)

-- ── portfolio_shares (owner mutations only) ──

ALTER POLICY "owners_insert_shares" ON portfolio_shares
  WITH CHECK (( SELECT auth.uid()) = owner_id AND is_active_user());

ALTER POLICY "owners_update_shares" ON portfolio_shares
  USING (( SELECT auth.uid()) = owner_id AND is_active_user());

ALTER POLICY "owners_delete_shares" ON portfolio_shares
  USING (( SELECT auth.uid()) = owner_id AND is_active_user());
-- read_shares stays as-is (viewer access for shared portfolios doesn't require active status)

-- ── SKIPPED (intentionally no is_active_user check) ──
-- profiles: pending users must read/update/delete their own profile
-- cron_config: already deny_all
-- invite_codes SELECT: pending users can see their own invite
-- portfolio_shares SELECT: viewer access via share token
