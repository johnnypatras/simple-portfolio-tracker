-- Restructure asset categories:
--   Old: stock | etf_ucits | etf_non_ucits | bond | other
--   New: individual_stock | etf | bond_fixed_income | other
--
-- Subcategory is repurposed from theme (e.g. "S&P 500") to instrument
-- subtype (e.g. "ETF UCITS", "ETF UCITS Bonds"). Old theme values move
-- into the tags[] array.

-- ─── Step 1: Add new enum values ──────────────────────────────
ALTER TYPE asset_category ADD VALUE IF NOT EXISTS 'individual_stock';
ALTER TYPE asset_category ADD VALUE IF NOT EXISTS 'etf';
ALTER TYPE asset_category ADD VALUE IF NOT EXISTS 'bond_fixed_income';

-- Enum additions require a commit before they can be used in DML
COMMIT;
BEGIN;

-- ─── Step 2: Move old subcategory values into tags ────────────
-- Only move non-empty values that aren't already instrument subtypes
UPDATE stock_assets
SET tags = CASE
  WHEN subcategory IS NOT NULL
    AND subcategory != ''
    AND subcategory NOT ILIKE 'ETF%'
    AND subcategory NOT ILIKE '%UCITS%'
    AND subcategory NOT ILIKE '%Non-UCITS%'
  THEN array_append(tags, subcategory)
  ELSE tags
END;

-- ─── Step 3: Set new subcategory from old category ────────────
-- etf_ucits → "ETF UCITS" (or "ETF UCITS Bonds" if bond tags/subcategory)
-- etf_non_ucits → "ETF Non-UCITS" (or "ETF Non-UCITS Bonds")
-- bond → null (it IS the category now)
-- stock → null
UPDATE stock_assets
SET subcategory = CASE
  WHEN category = 'etf_ucits' AND (
    subcategory ILIKE '%bond%'
    OR 'bond' = ANY(tags)
  ) THEN 'ETF UCITS Bonds'
  WHEN category = 'etf_ucits' THEN 'ETF UCITS'
  WHEN category = 'etf_non_ucits' AND (
    subcategory ILIKE '%bond%'
    OR 'bond' = ANY(tags)
  ) THEN 'ETF Non-UCITS Bonds'
  WHEN category = 'etf_non_ucits' THEN 'ETF Non-UCITS'
  ELSE NULL
END;

-- ─── Step 4: Remap category values ───────────────────────────
UPDATE stock_assets SET category = 'individual_stock' WHERE category = 'stock';
UPDATE stock_assets SET category = 'etf' WHERE category IN ('etf_ucits', 'etf_non_ucits');
UPDATE stock_assets SET category = 'bond_fixed_income' WHERE category = 'bond';

-- ─── Step 5: Clean up tags — remove old category values ──────
-- Tags should now contain only theme/strategy strings, not category enums
UPDATE stock_assets
SET tags = (
  SELECT COALESCE(array_agg(t), '{}')
  FROM unnest(tags) AS t
  WHERE t NOT IN ('stock', 'etf_ucits', 'etf_non_ucits', 'bond', 'other',
                  'individual_stock', 'etf', 'bond_fixed_income')
);

-- ─── Step 6: Recreate enum without old values ─────────────────
-- PostgreSQL doesn't support DROP VALUE from enums, so we recreate.
-- Must drop the column default first — it holds a reference to the enum type.

ALTER TABLE stock_assets ALTER COLUMN category DROP DEFAULT;
ALTER TABLE stock_assets ALTER COLUMN category TYPE TEXT;
DROP TYPE asset_category;
CREATE TYPE asset_category AS ENUM ('individual_stock', 'etf', 'bond_fixed_income', 'other');
ALTER TABLE stock_assets ALTER COLUMN category TYPE asset_category USING category::asset_category;
ALTER TABLE stock_assets ALTER COLUMN category SET DEFAULT 'individual_stock';
