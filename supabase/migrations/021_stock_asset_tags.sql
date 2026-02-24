-- Add tags column for multi-type asset classification.
-- An asset like a UCITS bond ETF can have tags ['etf_ucits', 'bond']
-- instead of relying on subcategory string matching for classification.

ALTER TABLE stock_assets ADD COLUMN tags TEXT[] DEFAULT '{}';

-- Backfill: set tags from existing category
UPDATE stock_assets SET tags = ARRAY[category::TEXT];

-- Bond ETFs: add 'bond' tag where subcategory indicates bond
UPDATE stock_assets
SET tags = ARRAY[category::TEXT, 'bond']
WHERE (category = 'etf_ucits' OR category = 'etf_non_ucits')
  AND subcategory ILIKE '%bond%';

-- GIN index for efficient array containment queries
CREATE INDEX idx_stock_assets_tags ON stock_assets USING GIN (tags);
