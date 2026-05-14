-- 017_manual_nav_rls_hardening.sql
-- Tighten manual_nav_updates RLS so it enforces parent-asset ownership in
-- addition to the user_id match. Closes a defense-in-depth gap where an
-- authenticated client could insert/update a NAV row pointing to another
-- user's stock_asset (the existing policy only checked user_id, not the
-- relationship between user_id and asset_id).
--
-- Background:
--   Migration 015 created `users_manage_own_manual_navs` with
--   `auth.uid() = user_id`. The FK to stock_assets(id) only validates
--   existence — not ownership. Combined with the matching user_id, an
--   attacker could plant a NAV row with their own user_id but referencing
--   a victim's asset_id UUID. Since the FK to stock_assets requires only
--   existence, and RLS WITH CHECK passed (user_id matches auth.uid()), the
--   orphan row was insertable.
--
-- This migration replaces the policy with one that also requires:
--   EXISTS (stock_assets WHERE id = manual_nav_updates.asset_id
--           AND user_id = auth.uid())
--
-- Same pattern as goal_prices and stock_positions in the baseline schema.
-- Tightens insert/update; reads were already RLS-scoped by user_id (so the
-- attacker couldn't READ another user's NAVs — only PLANT them).
--
-- Also explicitly REVOKE FROM PUBLIC on the get_latest_manual_navs_at
-- function so future PostgreSQL role additions don't silently inherit
-- execute permission via the PUBLIC default grant.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Replace manual_nav_updates RLS policy with ownership-enforcing version
-- ────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "users_manage_own_manual_navs" ON public.manual_nav_updates;

CREATE POLICY "users_manage_own_manual_navs" ON public.manual_nav_updates
  USING (
    (SELECT auth.uid()) = user_id
    AND public.is_active_user()
    AND EXISTS (
      SELECT 1 FROM public.stock_assets
      WHERE stock_assets.id = manual_nav_updates.asset_id
        AND stock_assets.user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND public.is_active_user()
    AND EXISTS (
      SELECT 1 FROM public.stock_assets
      WHERE stock_assets.id = manual_nav_updates.asset_id
        AND stock_assets.user_id = (SELECT auth.uid())
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Defense-in-depth REVOKE on get_latest_manual_navs_at RPC
-- ────────────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.get_latest_manual_navs_at(DATE, UUID) FROM PUBLIC;
