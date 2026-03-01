-- Add is_adjustment flag to activity_log.
-- When true, the entry represents a portfolio adjustment (e.g. importing
-- existing holdings) rather than a real cash transaction. deriveCashFlows()
-- excludes these entries so they don't inflate deposit/withdrawal totals.

ALTER TABLE activity_log ADD COLUMN is_adjustment BOOLEAN NOT NULL DEFAULT false;
