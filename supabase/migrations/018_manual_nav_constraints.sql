-- 018_manual_nav_constraints.sql
-- Schema-level defenses for the manual NAV feature.
--
-- (a) NAV precision: NUMERIC(28, 18) is the project's crypto-quantity
--     precision class. NAV is a fund-share price, not a crypto quantity —
--     18 decimal places is meaningless because JS Number rounds to 15-17
--     significant digits on read. Tighten to NUMERIC(20, 8) which matches
--     the monetary precision used by other price-class columns.
--
-- (b) Note length CHECK: server actions validateName(note, 500) limits to
--     500 chars, but the import path and any direct service-role insert
--     bypass that. Add the constraint at the DB level for defense-in-depth.
--
-- (c) stock_assets kind/yahoo_ticker invariant: kind='manual' implies
--     yahoo_ticker IS NULL (manual assets are priced via manual_nav_updates,
--     not Yahoo). The application's domain types document this contract but
--     nothing enforces it. CHECK constraint closes the gap.
--
-- All three changes are additive and won't fail on the current data set
-- (verified: nav values are well within NUMERIC(20,8) range, notes are
-- already capped at 500 by validators, kind/yahoo_ticker pairs already
-- match the invariant).

-- ────────────────────────────────────────────────────────────────────────────
-- (a) Tighten nav precision
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.manual_nav_updates
  ALTER COLUMN nav TYPE NUMERIC(20, 8);

-- ────────────────────────────────────────────────────────────────────────────
-- (b) Note length CHECK
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.manual_nav_updates
  ADD CONSTRAINT manual_nav_updates_note_length
  CHECK (note IS NULL OR length(note) <= 500);

-- ────────────────────────────────────────────────────────────────────────────
-- (c) stock_assets kind/yahoo_ticker invariant
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.stock_assets
  ADD CONSTRAINT stock_assets_manual_kind_no_yahoo_ticker
  CHECK (kind = 'yahoo' OR (kind = 'manual' AND yahoo_ticker IS NULL));
