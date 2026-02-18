-- Change stock_assets.currency from currency_type enum to TEXT
-- so it can store any currency code returned by Yahoo Finance (GBP, CHF, SEK, etc.)
-- Bank accounts, exchange deposits, and profile keep the enum.

ALTER TABLE stock_assets
  ALTER COLUMN currency TYPE TEXT USING currency::TEXT;

ALTER TABLE stock_assets
  ALTER COLUMN currency SET DEFAULT 'USD';
