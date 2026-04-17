-- Migration 014: Tighten NOT NULL constraints on defaulted columns
--
-- Many columns were declared with a DEFAULT but no NOT NULL. DEFAULT populates
-- the column on INSERT, so in practice these are never null — but the schema
-- still allows NULL, which propagates into generated TypeScript types as
-- `string | null` / `number | null` / `boolean | null`.
--
-- This migration reifies the de facto invariant: if a column has a DEFAULT
-- that the application always relies on, the column should be NOT NULL.
-- This aligns generated types with actual behavior and eliminates spurious
-- null checks in UI code.
--
-- SAFE BECAUSE: every ALTER here targets a column that already has a DEFAULT.
-- No existing row can have a NULL value for these columns (DEFAULT applies
-- on INSERT and we never SET ... = NULL in application code).

BEGIN;

-- ─── Timestamps: created_at (all tables with DEFAULT now()) ───
ALTER TABLE public.activity_log        ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE public.brokers             ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE public.cash_accounts       ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE public.crypto_assets       ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE public.diary_entries       ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE public.institutions        ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE public.invite_codes        ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE public.portfolio_snapshots ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE public.profiles            ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE public.stock_assets        ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE public.trade_entries       ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE public.wallets             ALTER COLUMN created_at SET NOT NULL;
-- NOTE: goal_prices has no created_at/updated_at (user can re-create goals
-- freely so timestamps were intentionally omitted). No migration needed.

-- ─── Timestamps: updated_at (all tables with DEFAULT now()) ───
ALTER TABLE public.cash_accounts    ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE public.crypto_positions ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE public.diary_entries    ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE public.institutions     ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE public.profiles         ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE public.stock_positions  ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE public.trade_entries    ALTER COLUMN updated_at SET NOT NULL;

-- ─── Numeric columns with DEFAULT 0 ───
-- Backfill any NULLs from early rows before enforcing (zero-cost if none exist)
UPDATE public.cash_accounts    SET apy = 0     WHERE apy IS NULL;
UPDATE public.cash_accounts    SET balance = 0 WHERE balance IS NULL;
UPDATE public.crypto_positions SET apy = 0     WHERE apy IS NULL;
ALTER TABLE public.cash_accounts    ALTER COLUMN apy SET NOT NULL;
ALTER TABLE public.cash_accounts    ALTER COLUMN balance SET NOT NULL;
ALTER TABLE public.crypto_positions ALTER COLUMN apy SET NOT NULL;

-- ─── Profile business-critical columns ───
-- primary_currency has DEFAULT 'EUR' — make NOT NULL
UPDATE public.profiles SET primary_currency = 'EUR' WHERE primary_currency IS NULL;
ALTER TABLE public.profiles ALTER COLUMN primary_currency SET NOT NULL;

-- ─── Stock asset defaults ───
-- currency has DEFAULT 'USD', tags has DEFAULT '{}'
UPDATE public.stock_assets SET currency = 'USD' WHERE currency IS NULL;
UPDATE public.stock_assets SET tags = '{}'::text[] WHERE tags IS NULL;
ALTER TABLE public.stock_assets ALTER COLUMN currency SET NOT NULL;
ALTER TABLE public.stock_assets ALTER COLUMN tags     SET NOT NULL;

COMMIT;
