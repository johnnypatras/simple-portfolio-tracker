-- 020_historical_prices.sql
-- Global, shared, append-only cache of historical daily prices.
--
-- Purpose: reconstruct the portfolio chart back to each backdated crypto/stock
-- lot's real purchase date using exact qty × historical-price, replacing the
-- flat-line back-fill (getAdjustmentDeltas) that is badly wrong for sizable,
-- multi-year, volatile lots.
--
-- Design:
--   - NO user_id: a BTC price on a given date is identical for every user.
--     This is a shared market-data cache, not user data. Written by the
--     fetch layer via the service-role (admin) client; readable by any
--     authenticated user.
--   - Append-only: past prices never change after the trading day closes, so
--     the table grows monotonically and is never invalidated.
--   - asset_key is canonical PER KIND: crypto = coingecko_id (NOT the Yahoo
--     symbol — Yahoo is only the fetch mechanism), stock = yahoo_ticker,
--     fx = ISO currency code (price = USD per 1 unit of that currency).
--   - UNIQUE(asset_kind, asset_key, price_date) makes re-fetch idempotent
--     (ON CONFLICT DO NOTHING / upsert).
--
-- RLS posture: RLS ENABLED with a permissive authenticated SELECT policy
-- (defense-in-depth consistency with the rest of the schema, even though the
-- data is non-sensitive public market data). NO write policy — writes go
-- through the service-role client, which bypasses RLS. anon is REVOKEd
-- (consistency with migration 019's manual_nav hardening).

CREATE TABLE public.historical_prices (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_kind   TEXT          NOT NULL CHECK (asset_kind IN ('crypto','stock','fx')),
  asset_key    TEXT          NOT NULL,
  price_date   DATE          NOT NULL,
  price        NUMERIC(20,8) NOT NULL CHECK (price > 0),
  currency     TEXT          NOT NULL,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (asset_kind, asset_key, price_date)
);

COMMENT ON TABLE public.historical_prices IS
  'Global append-only daily price cache for chart back-extension. asset_key: crypto=coingecko_id, stock=yahoo_ticker, fx=currency code (price=USD per 1 unit). No user_id — shared market data, written by service-role only.';

-- The UNIQUE constraint already creates a btree index on
-- (asset_kind, asset_key, price_date) which serves the lookup
-- "all prices for one asset, ordered by date". No extra index needed.

ALTER TABLE public.historical_prices ENABLE ROW LEVEL SECURITY;

-- Read-only for authenticated users (shared market data). No USING clause
-- on user_id because there is none — every authenticated user may read all
-- rows. Writes are not granted to authenticated; only service-role writes.
CREATE POLICY "authenticated_read_historical_prices"
  ON public.historical_prices
  FOR SELECT
  TO authenticated
  USING (public.is_active_user());

GRANT SELECT ON TABLE public.historical_prices TO authenticated;
GRANT ALL    ON TABLE public.historical_prices TO service_role;
REVOKE ALL   ON TABLE public.historical_prices FROM anon;
