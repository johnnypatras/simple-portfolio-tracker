-- Allow users to update their own snapshots (needed for upsert on same day)
CREATE POLICY "users_update_own_snapshots" ON portfolio_snapshots
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
