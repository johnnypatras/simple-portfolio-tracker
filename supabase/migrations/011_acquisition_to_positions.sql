-- Move acquisition_method from crypto_assets to crypto_positions (per-position, not per-asset)

-- 1. Add acquisition_method column to positions
ALTER TABLE crypto_positions ADD COLUMN acquisition_method TEXT DEFAULT 'bought';

-- 2. Copy existing values from parent asset to all its positions
UPDATE crypto_positions
SET acquisition_method = ca.acquisition_method
FROM crypto_assets ca
WHERE crypto_positions.crypto_asset_id = ca.id
  AND ca.acquisition_method IS NOT NULL;

-- 3. Backfill any remaining NULLs
UPDATE crypto_positions SET acquisition_method = 'bought' WHERE acquisition_method IS NULL;

-- 4. Drop the column from crypto_assets (no longer needed there)
ALTER TABLE crypto_assets DROP COLUMN acquisition_method;
