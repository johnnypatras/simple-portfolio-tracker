-- 022_backfill_failed_index.sql
-- Broaden the backfill work-queue partial indexes to include 'failed' rows.
-- Task 5 widened backfillCashflowsAndDeltas' batch queries from status = 'pending'
-- to status IN ('pending','failed') (failed rows now auto-retry under throttle).
-- The migration-019 partial indexes only covered 'pending', so the 'failed'
-- branch fell back to a sequential scan. Renamed to reflect "needs backfill".

DROP INDEX IF EXISTS public.idx_activity_log_pending_cashflows;
DROP INDEX IF EXISTS public.idx_activity_log_pending_deltas;

CREATE INDEX idx_activity_log_backfill_cashflows
  ON public.activity_log (user_id)
  WHERE cashflow_status IN ('pending', 'failed') AND undone_at IS NULL;

CREATE INDEX idx_activity_log_backfill_deltas
  ON public.activity_log (user_id)
  WHERE delta_status IN ('pending', 'failed') AND undone_at IS NULL;
