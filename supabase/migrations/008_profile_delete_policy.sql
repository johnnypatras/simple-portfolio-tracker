-- Allow users to delete their own profile (for account deletion)
CREATE POLICY "users_delete_own_profile" ON profiles
  FOR DELETE USING (auth.uid() = id);
