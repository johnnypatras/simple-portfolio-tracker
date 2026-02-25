-- 029_user_management.sql
-- Add role + status columns to profiles for admin-approved registration.
-- Admin operations use the service-role client (bypasses RLS), so no
-- admin RLS policies are needed on profiles or invite_codes.

-- ─── New columns ───────────────────────────────
ALTER TABLE profiles ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

-- Seed admin role for primary user
UPDATE profiles SET role = 'admin' WHERE email = 'johnnypatras@gmail.com';

-- ─── Triggers ──────────────────────────────────
CREATE TRIGGER update_profiles_role_status
  BEFORE UPDATE OF role, status ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
