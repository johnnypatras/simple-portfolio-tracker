-- Migration 009: Diary entry dedup constraint
-- Prevents duplicate diary entries on the same date for the same user during re-import.
-- Existing duplicates (if any) are cleaned up first by keeping the latest entry per date.

-- Clean up any existing duplicates before adding the constraint
DELETE FROM diary_entries a
  USING diary_entries b
  WHERE a.user_id = b.user_id
    AND a.entry_date = b.entry_date
    AND a.id < b.id
    AND a.deleted_at IS NULL
    AND b.deleted_at IS NULL;

-- Add unique constraint (only active entries — soft-deleted entries excluded)
CREATE UNIQUE INDEX IF NOT EXISTS uq_diary_entries_user_date_active
  ON diary_entries (user_id, entry_date) WHERE deleted_at IS NULL;
