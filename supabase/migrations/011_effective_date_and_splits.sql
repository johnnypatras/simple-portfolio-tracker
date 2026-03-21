-- Migration 011: Support for backdated entries and entry splitting
-- Adds trade-date vs entry-date distinction and parent-child split relationships

-- 1. Effective date — "when it really happened" (vs created_at = "when it was recorded")
ALTER TABLE activity_log ADD COLUMN effective_date DATE;

-- 2. Split parent reference — links split children to their original entry
ALTER TABLE activity_log ADD COLUMN split_from_id UUID
  REFERENCES activity_log(id) ON DELETE CASCADE;

-- 3. Self-reference guard
ALTER TABLE activity_log ADD CONSTRAINT chk_no_self_split
  CHECK (split_from_id IS DISTINCT FROM id);

-- 4. Index for efficient child lookups (undo, timeline grouping)
CREATE INDEX idx_activity_log_split_from ON activity_log(split_from_id)
  WHERE split_from_id IS NOT NULL;
