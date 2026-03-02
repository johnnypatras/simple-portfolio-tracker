-- Add delta columns to activity_log for caching adjustment value changes.
-- Nullable: non-adjustment rows stay NULL, pre-existing adjustments backfilled later.
ALTER TABLE activity_log ADD COLUMN delta_usd NUMERIC(18, 2);
ALTER TABLE activity_log ADD COLUMN delta_eur NUMERIC(18, 2);
