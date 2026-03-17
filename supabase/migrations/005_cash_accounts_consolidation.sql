-- 005_cash_accounts_consolidation.sql
-- Consolidate bank_accounts, exchange_deposits, broker_deposits → cash_accounts
--
-- Steps:
--   1. Backfill NULL institution_id on bank_accounts + assert none remain
--   2. Pre-flight safety checks (orphaned deposits, NULL wallet/broker institution_ids)
--   3. Merge cross-table deposit duplicates (exchange+broker at same inst+currency)
--   4. Create cash_accounts table (constraints, indexes, trigger, RLS, grants)
--   5. Migrate data from all 3 old tables
--   6. Add 'cash_account' to entity_type enum
--   7. Replace cascade_soft_delete() function body
--   8. Update sync_institution_name() — remove bank_accounts line
--   9. Rename old tables to _deprecated, revoke grants, drop old triggers
--
-- Note: ALTER TYPE ... ADD VALUE cannot run inside a transaction block,
-- so step 6 is placed outside the transaction. Supabase migrations run
-- each file as a single implicit transaction, but ADD VALUE IF NOT EXISTS
-- is safe to run outside — it's idempotent and a no-op if the value exists.

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Add 'cash_account' to entity_type enum (must be outside transaction)
-- ────────────────────────────────────────────────────────────────────────────

ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'cash_account';

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Backfill NULL institution_id on bank_accounts
-- ────────────────────────────────────────────────────────────────────────────

-- Match bank_accounts to institutions by bank_name = institution.name for same user
UPDATE bank_accounts ba
SET institution_id = i.id
FROM institutions i
WHERE ba.institution_id IS NULL
  AND ba.deleted_at IS NULL
  AND i.user_id = ba.user_id
  AND i.deleted_at IS NULL
  AND lower(trim(i.name)) = lower(trim(ba.bank_name));

-- Assert: no active bank_accounts should have NULL institution_id after backfill
DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM bank_accounts
  WHERE institution_id IS NULL
    AND deleted_at IS NULL;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION '% active bank_account(s) still have NULL institution_id after backfill — fix manually before migrating', orphan_count;
  END IF;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Pre-flight safety checks
-- ────────────────────────────────────────────────────────────────────────────

-- Check for exchange_deposits referencing hard-deleted wallets (would be dropped by INNER JOIN)
DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM exchange_deposits ed
  LEFT JOIN wallets w ON w.id = ed.wallet_id
  WHERE w.id IS NULL;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION '% exchange_deposit(s) reference non-existent wallets — fix before migrating', orphan_count;
  END IF;
END;
$$;

-- Check for broker_deposits referencing hard-deleted brokers
DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM broker_deposits bd
  LEFT JOIN brokers b ON b.id = bd.broker_id
  WHERE b.id IS NULL;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION '% broker_deposit(s) reference non-existent brokers — fix before migrating', orphan_count;
  END IF;
END;
$$;

-- Check for active exchange_deposits whose wallet has NULL institution_id
DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM exchange_deposits ed
  JOIN wallets w ON w.id = ed.wallet_id
  WHERE ed.deleted_at IS NULL
    AND w.deleted_at IS NULL
    AND w.institution_id IS NULL;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION '% active exchange_deposit(s) have wallets with NULL institution_id — fix before migrating', orphan_count;
  END IF;
END;
$$;

-- Check for active broker_deposits whose broker has NULL institution_id
DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM broker_deposits bd
  JOIN brokers b ON b.id = bd.broker_id
  WHERE bd.deleted_at IS NULL
    AND b.deleted_at IS NULL
    AND b.institution_id IS NULL;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION '% active broker_deposit(s) have brokers with NULL institution_id — fix before migrating', orphan_count;
  END IF;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Merge cross-table deposit duplicates
--    Exchange + broker deposits at the same institution + currency → absorb
--    broker amounts into exchange deposits, soft-delete the broker rows.
-- ────────────────────────────────────────────────────────────────────────────

-- Add broker_deposit amounts to matching exchange_deposits (same user, institution, currency)
-- Uses implicit cross-join: PostgreSQL UPDATE FROM can't reference target alias in FROM JOINs
UPDATE exchange_deposits ed
SET amount = ed.amount + bd.amount,
    updated_at = now()
FROM broker_deposits bd, wallets w, brokers b
WHERE w.id = ed.wallet_id
  AND w.user_id = ed.user_id
  AND b.id = bd.broker_id
  AND b.user_id = bd.user_id
  AND bd.user_id = ed.user_id
  AND bd.deleted_at IS NULL
  AND ed.deleted_at IS NULL
  AND w.institution_id = b.institution_id
  AND ed.currency = bd.currency;

-- Soft-delete the absorbed broker_deposits
UPDATE broker_deposits bd
SET deleted_at = now(),
    updated_at = now()
FROM wallets w, exchange_deposits ed, brokers b
WHERE w.id = ed.wallet_id
  AND w.user_id = ed.user_id
  AND ed.deleted_at IS NULL
  AND b.id = bd.broker_id
  AND b.user_id = bd.user_id
  AND bd.deleted_at IS NULL
  AND w.institution_id = b.institution_id
  AND ed.currency = bd.currency;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Create cash_accounts table
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE cash_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  institution_id  uuid REFERENCES institutions(id) ON DELETE SET NULL,
  name            text,
  currency        text NOT NULL DEFAULT 'EUR',
  balance         numeric(18,2) DEFAULT 0,
  apy             numeric(6,4) DEFAULT 0,
  region          text DEFAULT 'EU',
  wallet_id       uuid REFERENCES wallets(id) ON DELETE SET NULL,
  broker_id       uuid REFERENCES brokers(id) ON DELETE SET NULL,
  last_was_adjustment boolean NOT NULL DEFAULT false,
  last_was_transfer   boolean NOT NULL DEFAULT false,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT chk_cash_origin CHECK (NOT (wallet_id IS NOT NULL AND broker_id IS NOT NULL)),
  CONSTRAINT chk_name_not_empty CHECK (name IS NULL OR name <> ''),
  CONSTRAINT chk_bank_requires_name CHECK (wallet_id IS NOT NULL OR broker_id IS NOT NULL OR name IS NOT NULL)
);

ALTER TABLE cash_accounts OWNER TO postgres;

-- Indexes
CREATE UNIQUE INDEX uq_cash_accounts_active
  ON cash_accounts (user_id, institution_id, currency, COALESCE(name, ''))
  WHERE deleted_at IS NULL;

CREATE INDEX idx_cash_accounts_institution_currency
  ON cash_accounts (institution_id, currency)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_cash_accounts_wallet
  ON cash_accounts (wallet_id, currency)
  WHERE wallet_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX idx_cash_accounts_broker
  ON cash_accounts (broker_id, currency)
  WHERE broker_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX idx_cash_accounts_active
  ON cash_accounts (user_id)
  WHERE deleted_at IS NULL;

-- updated_at trigger
CREATE TRIGGER trg_cash_accounts_updated_at
  BEFORE UPDATE ON cash_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Row-level security
ALTER TABLE cash_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_manage_own_cash" ON cash_accounts
  USING (auth.uid() = user_id AND public.is_active_user());

-- Grants
GRANT ALL ON TABLE cash_accounts TO anon;
GRANT ALL ON TABLE cash_accounts TO authenticated;
GRANT ALL ON TABLE cash_accounts TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Migrate data from all 3 old tables
-- ────────────────────────────────────────────────────────────────────────────

-- 5a. Bank accounts → cash_accounts (direct institution_id, wallet_id=NULL, broker_id=NULL)
INSERT INTO cash_accounts (
  id, user_id, institution_id, name, currency, balance, apy, region,
  wallet_id, broker_id,
  last_was_adjustment, last_was_transfer,
  created_at, updated_at, deleted_at
)
SELECT
  ba.id, ba.user_id, ba.institution_id, ba.name, ba.currency::text, ba.balance, ba.apy, ba.region,
  NULL, NULL,
  ba.last_was_adjustment, ba.last_was_transfer,
  ba.created_at, ba.updated_at, ba.deleted_at
FROM bank_accounts ba;

-- 5b. Exchange deposits → cash_accounts (institution via wallet, name=NULL)
INSERT INTO cash_accounts (
  id, user_id, institution_id, name, currency, balance, apy, region,
  wallet_id, broker_id,
  last_was_adjustment, last_was_transfer,
  created_at, updated_at, deleted_at
)
SELECT
  ed.id, ed.user_id, w.institution_id, NULL, ed.currency::text, ed.amount, ed.apy, NULL,
  ed.wallet_id, NULL,
  ed.last_was_adjustment, ed.last_was_transfer,
  ed.created_at, ed.updated_at, ed.deleted_at
FROM exchange_deposits ed
JOIN wallets w ON w.id = ed.wallet_id AND w.user_id = ed.user_id;

-- 5c. Broker deposits → cash_accounts (institution via broker, name=NULL)
INSERT INTO cash_accounts (
  id, user_id, institution_id, name, currency, balance, apy, region,
  wallet_id, broker_id,
  last_was_adjustment, last_was_transfer,
  created_at, updated_at, deleted_at
)
SELECT
  bd.id, bd.user_id, b.institution_id, NULL, bd.currency::text, bd.amount, bd.apy, NULL,
  NULL, bd.broker_id,
  bd.last_was_adjustment, bd.last_was_transfer,
  bd.created_at, bd.updated_at, bd.deleted_at
FROM broker_deposits bd
JOIN brokers b ON b.id = bd.broker_id AND b.user_id = bd.user_id;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Replace cascade_soft_delete() function body
--    Changes: exchange_deposits → cash_accounts WHERE wallet_id
--             broker_deposits  → cash_accounts WHERE broker_id
--             bank_accounts    → cash_accounts WHERE institution_id
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cascade_soft_delete() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
        UPDATE cash_accounts SET deleted_at = NEW.deleted_at
          WHERE wallet_id = NEW.id AND deleted_at IS NULL;
      WHEN 'brokers' THEN
        UPDATE stock_positions SET deleted_at = NEW.deleted_at
          WHERE broker_id = NEW.id AND deleted_at IS NULL;
        UPDATE cash_accounts SET deleted_at = NEW.deleted_at
          WHERE broker_id = NEW.id AND deleted_at IS NULL;
      WHEN 'institutions' THEN
        UPDATE wallets SET deleted_at = NEW.deleted_at
          WHERE institution_id = NEW.id AND deleted_at IS NULL;
        UPDATE brokers SET deleted_at = NEW.deleted_at
          WHERE institution_id = NEW.id AND deleted_at IS NULL;
        UPDATE cash_accounts SET deleted_at = NEW.deleted_at
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
        UPDATE cash_accounts SET deleted_at = NULL
          WHERE wallet_id = NEW.id AND deleted_at = OLD.deleted_at;
      WHEN 'brokers' THEN
        UPDATE stock_positions SET deleted_at = NULL
          WHERE broker_id = NEW.id AND deleted_at = OLD.deleted_at;
        UPDATE cash_accounts SET deleted_at = NULL
          WHERE broker_id = NEW.id AND deleted_at = OLD.deleted_at;
      WHEN 'institutions' THEN
        UPDATE wallets SET deleted_at = NULL
          WHERE institution_id = NEW.id AND deleted_at = OLD.deleted_at;
        UPDATE brokers SET deleted_at = NULL
          WHERE institution_id = NEW.id AND deleted_at = OLD.deleted_at;
        UPDATE cash_accounts SET deleted_at = NULL
          WHERE institution_id = NEW.id AND deleted_at = OLD.deleted_at;
      ELSE
        NULL;
    END CASE;
  END IF;

  RETURN NEW;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 8. Update sync_institution_name() — remove bank_accounts line
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.sync_institution_name() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE wallets SET name = NEW.name WHERE institution_id = NEW.id;
    UPDATE brokers SET name = NEW.name WHERE institution_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 9. Deprecate old tables: rename, revoke grants, drop triggers
-- ────────────────────────────────────────────────────────────────────────────

-- Rename
ALTER TABLE bank_accounts RENAME TO bank_accounts_deprecated;
ALTER TABLE exchange_deposits RENAME TO exchange_deposits_deprecated;
ALTER TABLE broker_deposits RENAME TO broker_deposits_deprecated;

-- Revoke grants (prevent app access to deprecated tables)
REVOKE ALL ON TABLE bank_accounts_deprecated FROM anon, authenticated;
REVOKE ALL ON TABLE exchange_deposits_deprecated FROM anon, authenticated;
REVOKE ALL ON TABLE broker_deposits_deprecated FROM anon, authenticated;

-- Drop updated_at triggers (no longer needed)
DROP TRIGGER IF EXISTS update_bank_accounts_updated_at ON bank_accounts_deprecated;
DROP TRIGGER IF EXISTS update_broker_deposits_updated_at ON broker_deposits_deprecated;
DROP TRIGGER IF EXISTS update_exchange_deposits_updated_at ON exchange_deposits_deprecated;
