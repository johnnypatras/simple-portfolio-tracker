-- Add image_url column to store CoinGecko thumbnail URLs for crypto icons.
ALTER TABLE crypto_assets ADD COLUMN image_url TEXT;
