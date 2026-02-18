-- ══════════════════════════════════════════════
-- Portfolio Tracker — Initial Schema
-- ══════════════════════════════════════════════

-- ─── Custom Types ────────────────────────────
CREATE TYPE currency_type AS ENUM ('USD', 'EUR');
CREATE TYPE wallet_type AS ENUM ('custodial', 'non_custodial');
CREATE TYPE privacy_label AS ENUM ('anon', 'doxxed');
CREATE TYPE asset_category AS ENUM ('stock', 'etf_sp500', 'etf_world', 'bond', 'other');
CREATE TYPE action_type AS ENUM ('created', 'updated', 'removed');
CREATE TYPE entity_type AS ENUM (
  'crypto_asset', 'stock_asset', 'wallet', 'broker',
  'bank_account', 'exchange_deposit', 'crypto_position',
  'stock_position', 'diary_entry', 'goal_price'
);

-- ─── Profiles ────────────────────────────────
-- Extends Supabase auth.users with app-specific data
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  primary_currency currency_type DEFAULT 'EUR',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_read_own_profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "users_update_own_profile" ON profiles FOR UPDATE USING (auth.uid() = id);

-- ─── Invite Codes ────────────────────────────
CREATE TABLE invite_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  used_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE invite_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_read_own_invites" ON invite_codes
  FOR SELECT USING (auth.uid() = created_by OR auth.uid() = used_by);
CREATE POLICY "users_create_invites" ON invite_codes
  FOR INSERT WITH CHECK (auth.uid() = created_by);

-- ─── Wallets (crypto exchanges & self-custody) ─
CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  wallet_type wallet_type NOT NULL,
  privacy_label privacy_label,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_manage_own_wallets" ON wallets
  FOR ALL USING (auth.uid() = user_id);

-- ─── Brokers (stock/ETF platforms) ───────────
CREATE TABLE brokers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE brokers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_manage_own_brokers" ON brokers
  FOR ALL USING (auth.uid() = user_id);

-- ─── Bank Accounts ───────────────────────────
CREATE TABLE bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  region TEXT DEFAULT 'EU',
  currency currency_type DEFAULT 'EUR',
  balance NUMERIC(18, 2) DEFAULT 0,
  apy NUMERIC(6, 4) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_manage_own_banks" ON bank_accounts
  FOR ALL USING (auth.uid() = user_id);

-- ─── Crypto Assets ───────────────────────────
CREATE TABLE crypto_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  name TEXT NOT NULL,
  coingecko_id TEXT NOT NULL,
  chain TEXT,
  acquisition_method TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, coingecko_id)
);

ALTER TABLE crypto_assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_manage_own_crypto" ON crypto_assets
  FOR ALL USING (auth.uid() = user_id);

-- ─── Crypto Positions (quantity per wallet) ──
CREATE TABLE crypto_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crypto_asset_id UUID NOT NULL REFERENCES crypto_assets(id) ON DELETE CASCADE,
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  quantity NUMERIC(28, 18) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(crypto_asset_id, wallet_id)
);

ALTER TABLE crypto_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_manage_own_crypto_positions" ON crypto_positions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM crypto_assets
      WHERE crypto_assets.id = crypto_positions.crypto_asset_id
      AND crypto_assets.user_id = auth.uid()
    )
  );

-- ─── Goal Prices ─────────────────────────────
CREATE TABLE goal_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crypto_asset_id UUID NOT NULL REFERENCES crypto_assets(id) ON DELETE CASCADE,
  target_price NUMERIC(18, 8) NOT NULL,
  weight NUMERIC(4, 2) DEFAULT 0.25,
  label TEXT,
  UNIQUE(crypto_asset_id, label)
);

ALTER TABLE goal_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_manage_own_goals" ON goal_prices
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM crypto_assets
      WHERE crypto_assets.id = goal_prices.crypto_asset_id
      AND crypto_assets.user_id = auth.uid()
    )
  );

-- ─── Stock/ETF Assets ────────────────────────
CREATE TABLE stock_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  name TEXT NOT NULL,
  isin TEXT,
  category asset_category DEFAULT 'stock',
  currency currency_type DEFAULT 'USD',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, ticker)
);

ALTER TABLE stock_assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_manage_own_stocks" ON stock_assets
  FOR ALL USING (auth.uid() = user_id);

-- ─── Stock Positions (quantity per broker) ───
CREATE TABLE stock_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_asset_id UUID NOT NULL REFERENCES stock_assets(id) ON DELETE CASCADE,
  broker_id UUID NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  quantity NUMERIC(18, 8) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(stock_asset_id, broker_id)
);

ALTER TABLE stock_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_manage_own_stock_positions" ON stock_positions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM stock_assets
      WHERE stock_assets.id = stock_positions.stock_asset_id
      AND stock_assets.user_id = auth.uid()
    )
  );

-- ─── Exchange Deposits (fiat sitting on exchanges) ─
CREATE TABLE exchange_deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  currency currency_type DEFAULT 'USD',
  amount NUMERIC(18, 2) DEFAULT 0,
  apy NUMERIC(6, 4) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, wallet_id, currency)
);

ALTER TABLE exchange_deposits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_manage_own_deposits" ON exchange_deposits
  FOR ALL USING (auth.uid() = user_id);

-- ─── Activity Log (audit trail) ──────────────
CREATE TABLE activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action action_type NOT NULL,
  entity_type entity_type NOT NULL,
  entity_name TEXT NOT NULL,
  description TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_read_own_activity" ON activity_log
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users_insert_own_activity" ON activity_log
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Index for fast chronological queries
CREATE INDEX idx_activity_log_user_date ON activity_log(user_id, created_at DESC);

-- ─── Diary Entries ───────────────────────────
CREATE TABLE diary_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE diary_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_manage_own_diary" ON diary_entries
  FOR ALL USING (auth.uid() = user_id);

-- ─── Portfolio Snapshots (daily value history) ─
CREATE TABLE portfolio_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  total_value_usd NUMERIC(18, 2),
  total_value_eur NUMERIC(18, 2),
  crypto_value_usd NUMERIC(18, 2),
  stocks_value_usd NUMERIC(18, 2),
  cash_value_usd NUMERIC(18, 2),
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, snapshot_date)
);

ALTER TABLE portfolio_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_read_own_snapshots" ON portfolio_snapshots
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users_insert_own_snapshots" ON portfolio_snapshots
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ─── Auto-create profile on signup ───────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ─── Auto-update updated_at timestamps ───────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_bank_accounts_updated_at
  BEFORE UPDATE ON bank_accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_exchange_deposits_updated_at
  BEFORE UPDATE ON exchange_deposits FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_diary_entries_updated_at
  BEFORE UPDATE ON diary_entries FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_crypto_positions_updated_at
  BEFORE UPDATE ON crypto_positions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_stock_positions_updated_at
  BEFORE UPDATE ON stock_positions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
