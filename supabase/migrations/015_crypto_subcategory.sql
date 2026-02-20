-- Add optional subcategory field to crypto_assets
-- Used for user-defined grouping like "L1", "Ethereum L2", "DeFi", "Stablecoins", etc.
ALTER TABLE crypto_assets ADD COLUMN subcategory TEXT;
