-- ================================================================
-- 027: Backfill existing undo entries with 'undone' action
-- ================================================================
-- Must run in a separate migration from 026 because PostgreSQL
-- cannot use a newly-added enum value in the same transaction.
-- ================================================================

UPDATE activity_log
  SET action = 'undone'
  WHERE description LIKE 'Undid %'
    AND action = 'updated';
