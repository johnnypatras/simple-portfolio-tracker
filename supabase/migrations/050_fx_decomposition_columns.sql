-- Per-class EUR values (computed from class_usd × implied EUR/USD rate)
ALTER TABLE portfolio_snapshots ADD COLUMN crypto_value_eur NUMERIC(20,2);
ALTER TABLE portfolio_snapshots ADD COLUMN stocks_value_eur NUMERIC(20,2);
ALTER TABLE portfolio_snapshots ADD COLUMN cash_value_eur   NUMERIC(20,2);

-- Home-currency (EUR) denominated subtotals per class
-- These track the EUR value of positions denominated in the user's home currency (EUR).
-- Positions in home currency have zero FX sensitivity.
-- crypto has no EUR-denominated positions (all USD-priced via CoinGecko), so no column needed.
ALTER TABLE portfolio_snapshots ADD COLUMN stocks_eur_denominated_value NUMERIC(20,2);
ALTER TABLE portfolio_snapshots ADD COLUMN cash_eur_denominated_value   NUMERIC(20,2);

-- Backfill *_value_eur from existing USD values using portfolio's implied EUR/USD rate.
-- This is mathematically exact: the ratio total_eur/total_usd IS the EUR/USD rate
-- used when the snapshot was created.
UPDATE portfolio_snapshots
SET crypto_value_eur = CASE
      WHEN total_value_usd > 0
      THEN ROUND(crypto_value_usd * (total_value_eur / total_value_usd), 2)
      ELSE 0
    END,
    stocks_value_eur = CASE
      WHEN total_value_usd > 0
      THEN ROUND(stocks_value_usd * (total_value_eur / total_value_usd), 2)
      ELSE 0
    END,
    cash_value_eur = CASE
      WHEN total_value_usd > 0
      THEN ROUND(cash_value_usd * (total_value_eur / total_value_usd), 2)
      ELSE 0
    END
WHERE total_value_usd > 0;
