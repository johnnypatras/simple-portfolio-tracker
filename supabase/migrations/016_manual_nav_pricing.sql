-- 016_manual_nav_pricing.sql
-- Server-side support for pricing kind='manual' stock assets via manual_nav_updates.
--
-- Companion to migration 015 (which added the schema). This migration provides:
--   1. `manual_nav_update` value in the entity_type enum, for audit logging of
--      NAV CRUD via activity_log.
--   2. `get_latest_manual_navs_at(p_as_of, p_user_id)` set-returning function —
--      one canonical implementation of "latest NAV at-or-before date for each
--      manual asset the caller owns". Called from:
--        - assemble.ts (live dashboard, uses auth.uid())
--        - daily-snapshot edge function (service_role, passes user_id explicitly)
--        - chart-enrichment pipeline (per historical snapshot date)
--      Single SQL definition keeps the DISTINCT ON / index-only-scan pattern in
--      one place. SECURITY INVOKER: RLS on manual_nav_updates naturally scopes
--      results to the calling user when p_user_id is null.
--
-- The function uses idx_manual_nav_updates_asset_date (from migration 015) for
-- an index-only scan in the DISTINCT ON branch.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Add 'manual_nav_update' to entity_type enum
--    (ALTER TYPE ADD VALUE cannot run inside a transaction block;
--    ADD VALUE IF NOT EXISTS is idempotent.)
-- ────────────────────────────────────────────────────────────────────────────

ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'manual_nav_update';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. get_latest_manual_navs_at — set-returning lookup
-- ────────────────────────────────────────────────────────────────────────────

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
  WHERE m.user_id = COALESCE(p_user_id, auth.uid())
    AND m.effective_date <= p_as_of
  ORDER BY m.asset_id, m.effective_date DESC;
$$;

COMMENT ON FUNCTION public.get_latest_manual_navs_at(DATE, UUID) IS
  'Returns the latest NAV (and metadata) at-or-before p_as_of for each kind=''manual'' stock_asset owned by the user. SECURITY INVOKER: RLS scopes results to auth.uid() when p_user_id is null; service_role passes p_user_id explicitly. Used by live dashboard, daily-snapshot cron, and chart-enrichment.';

GRANT EXECUTE ON FUNCTION public.get_latest_manual_navs_at(DATE, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_latest_manual_navs_at(DATE, UUID) TO service_role;
-- Explicit revoke from anon — anonymous users have no NAV history to look up.
REVOKE EXECUTE ON FUNCTION public.get_latest_manual_navs_at(DATE, UUID) FROM anon;
