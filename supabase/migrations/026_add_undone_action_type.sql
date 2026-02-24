-- ================================================================
-- 026: Add 'undone' to action_type enum
-- ================================================================
-- Extends the action_type enum so undo operations get their own
-- distinct action type rather than reusing 'updated'.
-- ================================================================

ALTER TYPE action_type ADD VALUE IF NOT EXISTS 'undone';
