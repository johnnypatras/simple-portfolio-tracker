-- 023: Clean up stock asset taxonomy
-- Strips "ETF " prefix from subcategory (now just regulatory wrapper: UCITS, Non-UCITS)
-- Extracts "Bonds" theme from subcategory into tags array

-- 1. Add "Bonds" tag where subcategory contains "Bonds" (skip if already present)
UPDATE stock_assets
SET tags = array_append(tags, 'Bonds')
WHERE subcategory ILIKE '%Bonds%'
  AND NOT ('Bonds' = ANY(coalesce(tags, '{}')));

-- 2. Strip "ETF " prefix from subcategory values
UPDATE stock_assets
SET subcategory = regexp_replace(subcategory, '^ETF ', '')
WHERE subcategory LIKE 'ETF %';

-- 3. Strip trailing " Bonds" from subcategory values
UPDATE stock_assets
SET subcategory = regexp_replace(subcategory, ' Bonds$', '')
WHERE subcategory LIKE '% Bonds';
