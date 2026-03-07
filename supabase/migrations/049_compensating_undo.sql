-- Compensating transaction undo: adds compensates_for column and drops
-- the old snapshot-based transfer undo RPC.
--
-- compensates_for links an undo entry to the original activity_log entry
-- it reverses, enabling double-undo prevention and redo chains.

-- Add compensates_for column
ALTER TABLE activity_log
  ADD COLUMN compensates_for UUID REFERENCES activity_log(id);

-- Index for quick lookup: "has this entry already been compensated?"
CREATE INDEX idx_activity_log_compensates_for
  ON activity_log (compensates_for)
  WHERE compensates_for IS NOT NULL;

-- Drop old snapshot-based transfer undo RPC
DROP FUNCTION IF EXISTS undo_transfer_group(UUID);
