-- 021_transaction_cost_basis.sql
-- Foundational columns for the cost-basis feature.
--
-- Two additive boolean columns on activity_log:
--
--   is_yield          — marks income/return transactions (interest, staking,
--                       airdrop): units are added at zero cost, and these rows
--                       are excluded from benchmark cash-flow replay.  Distinct
--                       from is_adjustment (balance correction vs. true income).
--
--   cashflow_user_set — tracks provenance of the cashflow amount: true when the
--                       user explicitly typed it; false = auto-computed market
--                       value.  Backdate-recompute only rewrites false rows,
--                       preserving intentional overrides.
--
-- Both columns are NOT NULL with a DEFAULT so they are transparent to all
-- existing INSERT paths — no callsite changes required for this migration.

ALTER TABLE activity_log
  ADD COLUMN is_yield          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN cashflow_user_set BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN activity_log.is_yield IS
  'Income/return (interest, staking, airdrop): units added at cost 0, excluded from benchmark cash flows. Distinct from is_adjustment.';
COMMENT ON COLUMN activity_log.cashflow_user_set IS
  'True when the user explicitly typed the amount; false = auto-computed market value. Backdate-recompute only touches false rows.';
