-- Allow same display ticker with different exchange listings (e.g. VWCE.DE + VWCE.AS)
-- by replacing the single UNIQUE(user_id, ticker) with two partial unique indexes.

-- Drop old constraint (one ticker per user)
ALTER TABLE stock_assets DROP CONSTRAINT stock_assets_user_id_ticker_key;

-- When yahoo_ticker is set: unique by yahoo_ticker per user
-- (prevents adding the same exchange listing twice)
CREATE UNIQUE INDEX stock_assets_user_yahoo_ticker_unique
  ON stock_assets (user_id, yahoo_ticker)
  WHERE yahoo_ticker IS NOT NULL;

-- When yahoo_ticker is null: unique by ticker per user
-- (preserves original behavior for manually-entered assets)
CREATE UNIQUE INDEX stock_assets_user_ticker_no_yahoo_unique
  ON stock_assets (user_id, ticker)
  WHERE yahoo_ticker IS NULL;

-- Reload PostgREST schema cache so it picks up the new constraint structure
NOTIFY pgrst, 'reload schema';
