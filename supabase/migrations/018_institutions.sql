-- ================================================================
-- 018: Institutions — multi-role entity grouping
-- ================================================================
-- An institution (e.g. "Revolut") can simultaneously be a wallet/exchange,
-- broker, and bank. This migration creates the institutions table, adds
-- institution_id FKs to existing entity tables, and back-fills from
-- existing data.
-- ================================================================

-- ── 1. Create institutions table ────────────────────────────────

CREATE TABLE institutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name)
);

ALTER TABLE institutions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_manage_own_institutions" ON institutions
  FOR ALL USING (auth.uid() = user_id);

CREATE TRIGGER update_institutions_updated_at
  BEFORE UPDATE ON institutions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Add 'institution' to entity_type enum for activity logging
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'institution';

-- ── 2. Add institution_id FK to existing tables ─────────────────

ALTER TABLE wallets ADD COLUMN institution_id UUID REFERENCES institutions(id) ON DELETE SET NULL;
ALTER TABLE brokers ADD COLUMN institution_id UUID REFERENCES institutions(id) ON DELETE SET NULL;
ALTER TABLE bank_accounts ADD COLUMN institution_id UUID REFERENCES institutions(id) ON DELETE SET NULL;

CREATE INDEX idx_wallets_institution ON wallets(institution_id);
CREATE INDEX idx_brokers_institution ON brokers(institution_id);
CREATE INDEX idx_bank_accounts_institution ON bank_accounts(institution_id);

-- ── 3. Name-sync trigger ────────────────────────────────────────
-- When an institution is renamed, propagate to all linked child records.

CREATE OR REPLACE FUNCTION sync_institution_name()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE wallets SET name = NEW.name WHERE institution_id = NEW.id;
    UPDATE brokers SET name = NEW.name WHERE institution_id = NEW.id;
    UPDATE bank_accounts SET bank_name = NEW.name WHERE institution_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_institution_name_change
  AFTER UPDATE ON institutions
  FOR EACH ROW EXECUTE FUNCTION sync_institution_name();

-- ── 4. Back-fill institutions from existing data ────────────────
-- Create institutions from unique entity names, then link.

-- 4a. From wallets
INSERT INTO institutions (user_id, name)
SELECT DISTINCT user_id, name FROM wallets
ON CONFLICT (user_id, name) DO NOTHING;

UPDATE wallets w
SET institution_id = i.id
FROM institutions i
WHERE i.user_id = w.user_id AND i.name = w.name
  AND w.institution_id IS NULL;

-- 4b. From brokers
INSERT INTO institutions (user_id, name)
SELECT DISTINCT user_id, name FROM brokers
ON CONFLICT (user_id, name) DO NOTHING;

UPDATE brokers b
SET institution_id = i.id
FROM institutions i
WHERE i.user_id = b.user_id AND i.name = b.name
  AND b.institution_id IS NULL;

-- 4c. From bank_accounts (uses bank_name)
INSERT INTO institutions (user_id, name)
SELECT DISTINCT user_id, bank_name FROM bank_accounts
ON CONFLICT (user_id, name) DO NOTHING;

UPDATE bank_accounts ba
SET institution_id = i.id
FROM institutions i
WHERE i.user_id = ba.user_id AND i.name = ba.bank_name
  AND ba.institution_id IS NULL;
