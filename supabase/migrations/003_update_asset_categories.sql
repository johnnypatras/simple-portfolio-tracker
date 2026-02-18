-- Rename ETF categories: etf_sp500/etf_world → etf_ucits/etf_non_ucits
-- This better reflects the regulatory distinction (UCITS vs non-UCITS)
-- which affects tax treatment and availability for EU investors.

-- Step 1: Migrate existing data to new values
UPDATE stock_assets SET category = 'etf_ucits' WHERE category = 'etf_world';
UPDATE stock_assets SET category = 'etf_non_ucits' WHERE category = 'etf_sp500';

-- Step 2: Rename the enum values
ALTER TYPE asset_category RENAME VALUE 'etf_world' TO 'etf_ucits';
ALTER TYPE asset_category RENAME VALUE 'etf_sp500' TO 'etf_non_ucits';
