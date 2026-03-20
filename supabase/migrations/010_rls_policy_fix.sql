-- Migration 010: Fix RLS policy naming and add portfolio_shares hardening
--
-- BUG: Migration 008 tried to DROP "users_manage_own_cash_accounts" but the actual
-- policy from migration 005 is named "users_manage_own_cash". The IF EXISTS made the
-- DROP a no-op, leaving TWO permissive policies on cash_accounts (OR-ed, defeating hardening).
--
-- Also: portfolio_shares UPDATE policy was missing WITH CHECK + owner_id column REVOKE.

-- 1. Drop the OLD policy (correct name from migration 005)
DROP POLICY IF EXISTS "users_manage_own_cash" ON "public"."cash_accounts";

-- 2. Add WITH CHECK to portfolio_shares UPDATE policy
DROP POLICY IF EXISTS "owners_update_shares" ON "public"."portfolio_shares";
CREATE POLICY "owners_update_shares" ON "public"."portfolio_shares"
  FOR UPDATE
  USING ((( SELECT auth.uid() AS uid) = owner_id AND public.is_active_user()))
  WITH CHECK ((( SELECT auth.uid() AS uid) = owner_id AND public.is_active_user()));

-- 3. Column-level REVOKE on owner_id — prevent owner transfer via PostgREST
REVOKE UPDATE (owner_id) ON "public"."portfolio_shares" FROM authenticated;

-- 4. Re-grant EXECUTE on is_active_user() to authenticated role
-- Migration 007 revoked from ALL including authenticated, but RLS policies call this
-- function in the context of the authenticated role. Without EXECUTE, all RLS fails
-- with "permission denied for function is_active_user".
-- The function is SECURITY DEFINER (from 004), so it runs as the definer regardless.
-- anon should NOT have execute (unauthenticated callers don't need active-user checks).
GRANT EXECUTE ON FUNCTION public.is_active_user() TO authenticated;

-- 5. Fix profiles column-level REVOKE — table-level GRANT ALL overrides column REVOKE.
-- Must revoke table-level UPDATE first, then grant only safe columns.
REVOKE UPDATE ON TABLE "public"."profiles" FROM authenticated;
GRANT UPDATE (first_name, last_name, display_name, primary_currency, theme, updated_at) ON TABLE "public"."profiles" TO authenticated;

-- 6. Same for portfolio_shares — revoke table UPDATE, grant only safe columns
REVOKE UPDATE ON TABLE "public"."portfolio_shares" FROM authenticated;
GRANT UPDATE (scope, label, expires_at, revoked_at) ON TABLE "public"."portfolio_shares" TO authenticated;
