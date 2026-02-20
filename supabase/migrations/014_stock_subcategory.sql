-- Add optional subcategory field to stock_assets
-- Used for user-defined grouping like "S&P 500", "World", "US Bonds", etc.
ALTER TABLE stock_assets ADD COLUMN subcategory TEXT;
