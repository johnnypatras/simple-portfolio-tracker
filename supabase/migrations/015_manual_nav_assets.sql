-- 015_manual_nav_assets.sql
-- Support NAV-priced stock assets (ELTIFs, SICAVs, illiquid funds).
--
-- Yahoo Finance doesn't cover ELTIFs (e.g., EQT Nexus / ENXF). They publish NAV
-- quarterly via fund statements. This migration adds a `kind` discriminator to
-- stock_assets (`'yahoo' | 'manual'`) and a manual_nav_updates table that
-- records the history of user-entered NAVs.
--
-- Steps:
--   1. Add 'private_equity' to asset_category enum (must be outside transaction)
--   2. Add `kind` column to stock_assets (default 'yahoo' for backwards compat)
--   3. Create manual_nav_updates table (one row per asset + effective_date)
--   4. Index manual_nav_updates for chart enrichment queries (asset + date DESC)
--   5. RLS + grants matching the rest of the schema
--
-- Notes:
--   - The chart pipeline reads the latest NAV at-or-before each snapshot date
--     (step-function forward-fill semantics). No interpolation between updates.
--   - kind='manual' assets are skipped by Yahoo's batch fetch (yahoo_ticker is
--     null for them — uq_stock_assets_ticker_active enforces uniqueness on
--     ticker alone for these).
--   - The `note` column captures provenance per NAV entry (e.g., "Q1 2026 fund
--     letter", "Adjusted for capital call").

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Add 'private_equity' to asset_category enum
--    (ALTER TYPE ADD VALUE cannot run inside a transaction block;
--    ADD VALUE IF NOT EXISTS is idempotent.)
-- ────────────────────────────────────────────────────────────────────────────

ALTER TYPE asset_category ADD VALUE IF NOT EXISTS 'private_equity';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Add `kind` discriminator to stock_assets
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.stock_assets
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'yahoo'
  CHECK (kind IN ('yahoo', 'manual'));

COMMENT ON COLUMN public.stock_assets.kind IS
  'Price source: ''yahoo'' (default, fetched from Yahoo Finance batch API) or ''manual'' (NAV looked up from manual_nav_updates by latest effective_date <= snapshot_date).';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Create manual_nav_updates table
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.manual_nav_updates (
  id             UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id       UUID            NOT NULL REFERENCES public.stock_assets(id) ON DELETE CASCADE,
  user_id        UUID            NOT NULL REFERENCES auth.users(id)          ON DELETE CASCADE,
  effective_date DATE            NOT NULL,
  nav            NUMERIC(28, 18) NOT NULL CHECK (nav > 0),
  note           TEXT,
  created_at     TIMESTAMPTZ     NOT NULL DEFAULT now(),
  UNIQUE (asset_id, effective_date)
);

COMMENT ON TABLE public.manual_nav_updates IS
  'NAV updates for stock_assets where kind=''manual''. One row per (asset, effective_date). Chart forward-fills between rows (latest at-or-before snapshot_date).';

COMMENT ON COLUMN public.manual_nav_updates.note IS
  'Free-form provenance: ''Q1 2026 fund letter'', ''Includes capital call XYZ'', etc.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Index for chart enrichment hot path: "latest NAV at-or-before date"
-- ────────────────────────────────────────────────────────────────────────────

CREATE INDEX idx_manual_nav_updates_asset_date
  ON public.manual_nav_updates (asset_id, effective_date DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. RLS + grants (mirrors the rest of the schema)
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.manual_nav_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_manage_own_manual_navs" ON public.manual_nav_updates
  USING       ((( SELECT auth.uid() AS uid) = user_id AND public.is_active_user()))
  WITH CHECK  ((( SELECT auth.uid() AS uid) = user_id AND public.is_active_user()));

GRANT ALL ON TABLE public.manual_nav_updates TO anon;
GRANT ALL ON TABLE public.manual_nav_updates TO authenticated;
GRANT ALL ON TABLE public.manual_nav_updates TO service_role;
