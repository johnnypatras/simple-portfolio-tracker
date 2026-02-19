-- Allow users to delete their own snapshots
CREATE POLICY "users_delete_own_snapshots" ON portfolio_snapshots
  FOR DELETE USING (auth.uid() = user_id);
