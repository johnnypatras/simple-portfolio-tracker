-- Migration 008: RLS policy hardening
-- Addresses: profiles UPDATE missing WITH CHECK, cash_accounts bare auth.uid()

-- 1. Add WITH CHECK to profiles UPDATE policy
-- Without WITH CHECK, a user could theoretically modify their own role/status fields
-- via a direct Supabase client call, bypassing admin-controlled approval flow.
DROP POLICY IF EXISTS "users_update_own_profile" ON "public"."profiles";
CREATE POLICY "users_update_own_profile" ON "public"."profiles"
  FOR UPDATE
  USING ((( SELECT auth.uid() AS uid) = id))
  WITH CHECK ((( SELECT auth.uid() AS uid) = id));

-- 2. Fix cash_accounts RLS to use ( SELECT auth.uid()) form for consistency + performance
-- Bare auth.uid() is re-evaluated per row; ( SELECT auth.uid()) is evaluated once per statement
DROP POLICY IF EXISTS "users_manage_own_cash_accounts" ON "public"."cash_accounts";
CREATE POLICY "users_manage_own_cash_accounts" ON "public"."cash_accounts"
  FOR ALL
  USING ((( SELECT auth.uid() AS uid) = user_id AND public.is_active_user()))
  WITH CHECK ((( SELECT auth.uid() AS uid) = user_id AND public.is_active_user()));

-- 3. Column-level REVOKE on profiles — prevent users from modifying role/status via PostgREST
-- The server action updateProfile only allows first_name, last_name, display_name, primary_currency, theme.
-- But the RLS UPDATE policy allows any column. Revoke UPDATE on sensitive columns from authenticated role.
REVOKE UPDATE (role, status) ON "public"."profiles" FROM authenticated;
