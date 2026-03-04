-- ================================================================
-- 026: Add 'undone' to action_type enum + backfill existing entries
-- ================================================================
-- Extends the action_type enum so undo operations get their own
-- distinct action type rather than reusing 'updated'.
-- Uses text cast to bypass Postgres restriction on using newly-added
-- enum values in the same transaction (supabase local runs all
-- migrations in one transaction).
-- ================================================================

ALTER TYPE action_type ADD VALUE IF NOT EXISTS 'undone';

UPDATE activity_log
  SET action = 'undone'::text::action_type
  WHERE description LIKE 'Undid %'
    AND action = 'updated';
