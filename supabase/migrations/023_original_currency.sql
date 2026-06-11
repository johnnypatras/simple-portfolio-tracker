-- 023_original_currency.sql
-- B-minimal original-currency metadata (spec 2026-06-11-currency-uniform-fix-design v2).
-- NUMERIC(18,4): lossless for every ISO-4217 minor unit (BHD/KWD/OMR/TND=3dp, CLF=4dp).
-- Reference metadata ONLY — cost-basis engine & benchmark read the EUR/USD columns.
ALTER TABLE public.activity_log
  ADD COLUMN original_amount NUMERIC(18,4),
  ADD COLUMN original_currency TEXT;

COMMENT ON COLUMN public.activity_log.original_amount IS
  'Magnitude the user transacted, in original_currency. NULL = market-derived or pre-feature row.';
COMMENT ON COLUMN public.activity_log.original_currency IS
  'ISO-4217 code the user transacted in.';
