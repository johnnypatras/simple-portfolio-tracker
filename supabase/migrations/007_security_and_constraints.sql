-- Migration 007: Security hardening and data integrity constraints
-- Addresses: is_active_user() missing REVOKE, default privilege footgun, balance constraints

-- 1. REVOKE execute on is_active_user() from anon/authenticated
-- (Added in 004 but missing the REVOKE that all other SECURITY DEFINER functions have in 002)
REVOKE EXECUTE ON FUNCTION public.is_active_user() FROM PUBLIC, anon, authenticated;

-- 2. Revoke the broad default privilege grant on functions
-- This was set in 001_baseline.sql and auto-grants ALL ON FUNCTIONS to anon/authenticated
-- for any new function created by the postgres role. This is a security footgun.
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public"
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- 3. CHECK constraints to prevent negative balances/quantities (defense-in-depth)
-- These make overdraft impossible at the DB level regardless of application bugs.
ALTER TABLE cash_accounts ADD CONSTRAINT chk_cash_balance_non_negative CHECK (balance >= 0);
ALTER TABLE crypto_positions ADD CONSTRAINT chk_crypto_qty_non_negative CHECK (quantity >= 0);
ALTER TABLE stock_positions ADD CONSTRAINT chk_stock_qty_non_negative CHECK (quantity >= 0);
