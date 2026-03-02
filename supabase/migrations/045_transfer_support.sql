-- Transfer group linking for paired sell/buy/move operations
ALTER TABLE activity_log ADD COLUMN transfer_group_id UUID;
CREATE INDEX idx_activity_log_transfer_group
  ON activity_log(transfer_group_id) WHERE transfer_group_id IS NOT NULL;

-- Badge: distinguish transfers from manual adjustments
ALTER TABLE crypto_positions  ADD COLUMN last_was_transfer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE stock_positions   ADD COLUMN last_was_transfer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bank_accounts     ADD COLUMN last_was_transfer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE broker_deposits   ADD COLUMN last_was_transfer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE exchange_deposits ADD COLUMN last_was_transfer BOOLEAN NOT NULL DEFAULT false;
