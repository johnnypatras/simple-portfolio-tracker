-- Add yahoo_ticker column to stock_assets for Yahoo Finance price lookups
-- Mirrors the coingecko_id pattern on crypto_assets
ALTER TABLE stock_assets ADD COLUMN yahoo_ticker TEXT;
