-- Fix performance warning: multiple permissive policies on portfolio_shares for SELECT.
-- The old setup had FOR ALL (owners) + FOR SELECT (viewers), both PERMISSIVE,
-- forcing Postgres to evaluate both policies for every SELECT row.
-- Solution: one consolidated SELECT policy, separate write policies.

-- Drop the two overlapping policies
DROP POLICY IF EXISTS "owners_manage_shares" ON portfolio_shares;
DROP POLICY IF EXISTS "viewers_read_shares" ON portfolio_shares;

-- Single consolidated SELECT policy (one evaluation per row)
CREATE POLICY "read_shares" ON portfolio_shares
  FOR SELECT USING (
    (select auth.uid()) = owner_id
    OR (
      (select auth.uid()) = viewer_id
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > NOW())
    )
  );

-- Owners-only for write operations
CREATE POLICY "owners_insert_shares" ON portfolio_shares
  FOR INSERT WITH CHECK ((select auth.uid()) = owner_id);

CREATE POLICY "owners_update_shares" ON portfolio_shares
  FOR UPDATE USING ((select auth.uid()) = owner_id);

CREATE POLICY "owners_delete_shares" ON portfolio_shares
  FOR DELETE USING ((select auth.uid()) = owner_id);
