-- ================================================================
-- 024: Soft Deletes + Enhanced Audit Log
-- ================================================================
-- Adds deleted_at column to portfolio tables for reversible deletions,
-- converts unique constraints to partial indexes, creates cascade
-- soft-delete triggers, and enhances activity_log for undo support.
-- ================================================================

-- ── 1. Add deleted_at column to 13 portfolio tables ─────────────

ALTER TABLE crypto_assets      ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE crypto_positions   ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE goal_prices        ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE stock_assets       ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE stock_positions    ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE wallets            ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE brokers            ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE bank_accounts      ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE exchange_deposits  ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE broker_deposits    ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE institutions       ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE trade_entries      ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE diary_entries      ADD COLUMN deleted_at TIMESTAMPTZ;

-- NOT added to: profiles, invite_codes, portfolio_snapshots, activity_log

-- ── 2. Convert unique constraints to partial indexes ────────────
-- Soft-deleted rows no longer block re-creation of active records.

-- crypto_assets: UNIQUE(user_id, coingecko_id)
ALTER TABLE crypto_assets DROP CONSTRAINT crypto_assets_user_id_coingecko_id_key;
CREATE UNIQUE INDEX uq_crypto_assets_active
  ON crypto_assets(user_id, coingecko_id) WHERE deleted_at IS NULL;

-- crypto_positions: UNIQUE(crypto_asset_id, wallet_id)
ALTER TABLE crypto_positions DROP CONSTRAINT crypto_positions_crypto_asset_id_wallet_id_key;
CREATE UNIQUE INDEX uq_crypto_positions_active
  ON crypto_positions(crypto_asset_id, wallet_id) WHERE deleted_at IS NULL;

-- goal_prices: UNIQUE(crypto_asset_id, label)
ALTER TABLE goal_prices DROP CONSTRAINT goal_prices_crypto_asset_id_label_key;
CREATE UNIQUE INDEX uq_goal_prices_active
  ON goal_prices(crypto_asset_id, label) WHERE deleted_at IS NULL;

-- stock_assets: UNIQUE(user_id, ticker)
ALTER TABLE stock_assets DROP CONSTRAINT stock_assets_user_id_ticker_key;
CREATE UNIQUE INDEX uq_stock_assets_active
  ON stock_assets(user_id, ticker) WHERE deleted_at IS NULL;

-- stock_positions: UNIQUE(stock_asset_id, broker_id)
ALTER TABLE stock_positions DROP CONSTRAINT stock_positions_stock_asset_id_broker_id_key;
CREATE UNIQUE INDEX uq_stock_positions_active
  ON stock_positions(stock_asset_id, broker_id) WHERE deleted_at IS NULL;

-- exchange_deposits: UNIQUE(user_id, wallet_id, currency)
ALTER TABLE exchange_deposits DROP CONSTRAINT exchange_deposits_user_id_wallet_id_currency_key;
CREATE UNIQUE INDEX uq_exchange_deposits_active
  ON exchange_deposits(user_id, wallet_id, currency) WHERE deleted_at IS NULL;

-- broker_deposits: UNIQUE(user_id, broker_id, currency)
ALTER TABLE broker_deposits DROP CONSTRAINT broker_deposits_user_id_broker_id_currency_key;
CREATE UNIQUE INDEX uq_broker_deposits_active
  ON broker_deposits(user_id, broker_id, currency) WHERE deleted_at IS NULL;

-- institutions: UNIQUE(user_id, name)
ALTER TABLE institutions DROP CONSTRAINT institutions_user_id_name_key;
CREATE UNIQUE INDEX uq_institutions_active
  ON institutions(user_id, name) WHERE deleted_at IS NULL;

-- ── 3. Cascade soft-delete trigger ──────────────────────────────
-- When deleted_at is set on a parent, cascade to child tables.
-- When cleared (undo), restore children deleted at the same timestamp.

CREATE OR REPLACE FUNCTION cascade_soft_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- Soft-delete cascade: parent → children
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    CASE TG_TABLE_NAME
      WHEN 'crypto_assets' THEN
        UPDATE crypto_positions SET deleted_at = NEW.deleted_at
          WHERE crypto_asset_id = NEW.id AND deleted_at IS NULL;
        UPDATE goal_prices SET deleted_at = NEW.deleted_at
          WHERE crypto_asset_id = NEW.id AND deleted_at IS NULL;
      WHEN 'stock_assets' THEN
        UPDATE stock_positions SET deleted_at = NEW.deleted_at
          WHERE stock_asset_id = NEW.id AND deleted_at IS NULL;
      WHEN 'wallets' THEN
        UPDATE crypto_positions SET deleted_at = NEW.deleted_at
          WHERE wallet_id = NEW.id AND deleted_at IS NULL;
        UPDATE exchange_deposits SET deleted_at = NEW.deleted_at
          WHERE wallet_id = NEW.id AND deleted_at IS NULL;
      WHEN 'brokers' THEN
        UPDATE stock_positions SET deleted_at = NEW.deleted_at
          WHERE broker_id = NEW.id AND deleted_at IS NULL;
        UPDATE broker_deposits SET deleted_at = NEW.deleted_at
          WHERE broker_id = NEW.id AND deleted_at IS NULL;
      ELSE
        -- No children for other tables
        NULL;
    END CASE;
  END IF;

  -- Restore cascade: parent restored → restore children
  -- Only restores children that were cascade-deleted at the same time
  IF NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL THEN
    CASE TG_TABLE_NAME
      WHEN 'crypto_assets' THEN
        UPDATE crypto_positions SET deleted_at = NULL
          WHERE crypto_asset_id = NEW.id AND deleted_at = OLD.deleted_at;
        UPDATE goal_prices SET deleted_at = NULL
          WHERE crypto_asset_id = NEW.id AND deleted_at = OLD.deleted_at;
      WHEN 'stock_assets' THEN
        UPDATE stock_positions SET deleted_at = NULL
          WHERE stock_asset_id = NEW.id AND deleted_at = OLD.deleted_at;
      WHEN 'wallets' THEN
        UPDATE crypto_positions SET deleted_at = NULL
          WHERE wallet_id = NEW.id AND deleted_at = OLD.deleted_at;
        UPDATE exchange_deposits SET deleted_at = NULL
          WHERE wallet_id = NEW.id AND deleted_at = OLD.deleted_at;
      WHEN 'brokers' THEN
        UPDATE stock_positions SET deleted_at = NULL
          WHERE broker_id = NEW.id AND deleted_at = OLD.deleted_at;
        UPDATE broker_deposits SET deleted_at = NULL
          WHERE broker_id = NEW.id AND deleted_at = OLD.deleted_at;
      ELSE
        NULL;
    END CASE;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach cascade triggers to parent tables
CREATE TRIGGER soft_delete_cascade_crypto_assets
  AFTER UPDATE OF deleted_at ON crypto_assets
  FOR EACH ROW EXECUTE FUNCTION cascade_soft_delete();

CREATE TRIGGER soft_delete_cascade_stock_assets
  AFTER UPDATE OF deleted_at ON stock_assets
  FOR EACH ROW EXECUTE FUNCTION cascade_soft_delete();

CREATE TRIGGER soft_delete_cascade_wallets
  AFTER UPDATE OF deleted_at ON wallets
  FOR EACH ROW EXECUTE FUNCTION cascade_soft_delete();

CREATE TRIGGER soft_delete_cascade_brokers
  AFTER UPDATE OF deleted_at ON brokers
  FOR EACH ROW EXECUTE FUNCTION cascade_soft_delete();

-- ── 4. Enhance activity_log for undo support ────────────────────

ALTER TABLE activity_log ADD COLUMN entity_id UUID;
ALTER TABLE activity_log ADD COLUMN entity_table TEXT;
ALTER TABLE activity_log ADD COLUMN before_snapshot JSONB;
ALTER TABLE activity_log ADD COLUMN after_snapshot JSONB;
ALTER TABLE activity_log ADD COLUMN undone_at TIMESTAMPTZ;

-- Fast lookup for undo by entity
CREATE INDEX idx_activity_log_entity
  ON activity_log(entity_id) WHERE entity_id IS NOT NULL;

-- ── 5. Performance indexes for soft-delete filtering ────────────

CREATE INDEX idx_crypto_assets_active ON crypto_assets(user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_stock_assets_active ON stock_assets(user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_wallets_active ON wallets(user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_brokers_active ON brokers(user_id) WHERE deleted_at IS NULL;
