-- Add theme preference to user profiles
ALTER TABLE profiles ADD COLUMN theme TEXT DEFAULT 'zinc-dark';
