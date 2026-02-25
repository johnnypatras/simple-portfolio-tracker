-- 030_profile_name_fields.sql
-- Add first_name and last_name to profiles (separate from display_name).

ALTER TABLE profiles ADD COLUMN first_name TEXT;
ALTER TABLE profiles ADD COLUMN last_name TEXT;
