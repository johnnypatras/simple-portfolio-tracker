-- Add UPDATE policy for activity_log so the undo feature can set undone_at.
-- Previously only SELECT and INSERT policies existed, causing the undone_at
-- update in undoActivity() to silently affect 0 rows.

CREATE POLICY "users_update_own_activity" ON activity_log
  FOR UPDATE USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
