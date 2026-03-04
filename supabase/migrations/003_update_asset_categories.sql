-- Rename ETF categories: etf_sp500/etf_world → etf_ucits/etf_non_ucits
-- This better reflects the regulatory distinction (UCITS vs non-UCITS)
-- which affects tax treatment and availability for EU investors.
-- RENAME VALUE renames in-place; existing rows automatically get the new name.
ALTER TYPE asset_category RENAME VALUE 'etf_world' TO 'etf_ucits';
ALTER TYPE asset_category RENAME VALUE 'etf_sp500' TO 'etf_non_ucits';
