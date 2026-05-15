-- 019_data_integrity_audit_round1.sql
-- Defense-in-depth + correctness improvements from Round 1 16-agent audit.
-- Addresses:
--   1. CRITICAL — activity_log.compensates_for FK had no ON DELETE action.
--      Direct DELETE of a row another row points to would fail with NO ACTION.
--      SET NULL preserves the compensator while signalling the original is gone.
--   2. HIGH — manual_nav_updates was GRANT ALL'd to anon. RLS already blocks
--      anon, but inconsistent with the explicit REVOKE on
--      get_latest_manual_navs_at from migration 016.
--   3. HIGH — goal_prices lacked an index on crypto_asset_id. The unique
--      partial uq_goal_prices_active covers active reads but not the cascade
--      soft-delete trigger's restore-branch full scan.
--   4. HIGH — uq_cash_accounts_active used COALESCE(name, '') but ignored
--      wallet_id / broker_id, allowing collisions between wallet-derived and
--      broker-derived rows at the same (user, institution, currency) with
--      NULL names. Include wallet_id / broker_id in the key.
--   5. HIGH — idx_activity_log_pending_cashflows / _deltas lacked the
--      undone_at IS NULL predicate. Undone rows lingered in the index.
--   6. MEDIUM — idx_brokers_institution / idx_wallets_institution included
--      soft-deleted rows. Make partial on deleted_at IS NULL.
--   7. MEDIUM (cross-domain) — get_latest_manual_navs_at returned NAVs for
--      soft-deleted parent stock_assets. Join + filter sa.deleted_at IS NULL.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. activity_log.compensates_for: NO ACTION → SET NULL
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.activity_log
  DROP CONSTRAINT IF EXISTS activity_log_compensates_for_fkey;
ALTER TABLE public.activity_log
  ADD CONSTRAINT activity_log_compensates_for_fkey
    FOREIGN KEY (compensates_for) REFERENCES public.activity_log(id)
    ON DELETE SET NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. manual_nav_updates: REVOKE from anon (defense in depth, consistency)
-- ──────────────────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE public.manual_nav_updates FROM anon;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. goal_prices: add covering index for cascade soft-delete + admin reads
-- ──────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_goal_prices_crypto_asset
  ON public.goal_prices (crypto_asset_id);

-- ──────────────────────────────────────────────────────────────────────────
-- 4. cash_accounts unique index: include wallet_id + broker_id so
--    wallet-derived and broker-derived rows at the same
--    (user, institution, currency) with NULL names don't collide.
--    The new key is strictly more permissive than the old one, so no
--    existing rows can be invalidated by the change.
-- ──────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS public.uq_cash_accounts_active;
CREATE UNIQUE INDEX uq_cash_accounts_active
  ON public.cash_accounts (
    user_id,
    institution_id,
    currency,
    COALESCE(name, ''),
    COALESCE(wallet_id::text, ''),
    COALESCE(broker_id::text, '')
  )
  WHERE deleted_at IS NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- 5. activity_log pending indexes: also exclude undone rows.
-- ──────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS public.idx_activity_log_pending_cashflows;
DROP INDEX IF EXISTS public.idx_activity_log_pending_deltas;

CREATE INDEX idx_activity_log_pending_cashflows
  ON public.activity_log (user_id)
  WHERE cashflow_status = 'pending' AND undone_at IS NULL;

CREATE INDEX idx_activity_log_pending_deltas
  ON public.activity_log (user_id)
  WHERE delta_status = 'pending' AND undone_at IS NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- 6. brokers + wallets institution indexes: partial on deleted_at IS NULL
-- ──────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS public.idx_brokers_institution;
DROP INDEX IF EXISTS public.idx_wallets_institution;

CREATE INDEX idx_brokers_institution
  ON public.brokers (institution_id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_wallets_institution
  ON public.wallets (institution_id)
  WHERE deleted_at IS NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- 7. get_latest_manual_navs_at: exclude NAVs whose parent stock_asset is
--    soft-deleted. Without this, NAV rows lingered and surfaced in the
--    chart pipeline after the user removed the asset.
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_latest_manual_navs_at(
  p_as_of DATE,
  p_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  asset_id       UUID,
  nav            NUMERIC,
  effective_date DATE,
  note           TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT DISTINCT ON (m.asset_id)
    m.asset_id,
    m.nav,
    m.effective_date,
    m.note
  FROM public.manual_nav_updates m
  JOIN public.stock_assets sa ON sa.id = m.asset_id
  WHERE m.user_id = COALESCE(p_user_id, auth.uid())
    AND m.effective_date <= p_as_of
    AND sa.deleted_at IS NULL
  ORDER BY m.asset_id, m.effective_date DESC;
$$;

COMMENT ON FUNCTION public.get_latest_manual_navs_at(DATE, UUID) IS
  'Returns the latest NAV (and metadata) at-or-before p_as_of for each kind=''manual'' stock_asset owned by the user. Excludes soft-deleted parent assets (added in migration 019). SECURITY INVOKER: RLS scopes results to auth.uid() when p_user_id is null; service_role passes p_user_id explicitly. Used by live dashboard, daily-snapshot cron, and chart-enrichment.';

GRANT EXECUTE ON FUNCTION public.get_latest_manual_navs_at(DATE, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_latest_manual_navs_at(DATE, UUID) TO service_role;
REVOKE EXECUTE ON FUNCTION public.get_latest_manual_navs_at(DATE, UUID) FROM anon;
