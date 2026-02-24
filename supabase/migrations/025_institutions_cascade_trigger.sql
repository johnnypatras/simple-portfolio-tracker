-- ================================================================
-- 025: Add institutions to cascade soft-delete trigger
-- ================================================================
-- Extends the cascade_soft_delete() function from 024 to also handle
-- institutions → wallets, brokers, bank_accounts.
--
-- The wallets/brokers triggers from 024 will further cascade to their
-- own children (crypto_positions, exchange_deposits, stock_positions,
-- broker_deposits), so the full chain is transitive.
-- ================================================================

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
      WHEN 'institutions' THEN
        UPDATE wallets SET deleted_at = NEW.deleted_at
          WHERE institution_id = NEW.id AND deleted_at IS NULL;
        UPDATE brokers SET deleted_at = NEW.deleted_at
          WHERE institution_id = NEW.id AND deleted_at IS NULL;
        UPDATE bank_accounts SET deleted_at = NEW.deleted_at
          WHERE institution_id = NEW.id AND deleted_at IS NULL;
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
      WHEN 'institutions' THEN
        UPDATE wallets SET deleted_at = NULL
          WHERE institution_id = NEW.id AND deleted_at = OLD.deleted_at;
        UPDATE brokers SET deleted_at = NULL
          WHERE institution_id = NEW.id AND deleted_at = OLD.deleted_at;
        UPDATE bank_accounts SET deleted_at = NULL
          WHERE institution_id = NEW.id AND deleted_at = OLD.deleted_at;
      ELSE
        NULL;
    END CASE;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach cascade trigger to institutions table
CREATE TRIGGER soft_delete_cascade_institutions
  AFTER UPDATE OF deleted_at ON institutions
  FOR EACH ROW EXECUTE FUNCTION cascade_soft_delete();
