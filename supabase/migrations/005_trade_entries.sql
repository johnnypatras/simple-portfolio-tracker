-- ─── Trade Entries (structured trade diary) ─────────────────────────
-- Logs significant buys/sells with date, asset, quantity, price.
-- Separate from diary_entries (freeform text) — this is structured data.

CREATE TABLE trade_entries (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trade_date  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  asset_type  TEXT        NOT NULL CHECK (asset_type IN ('crypto', 'stock', 'cash', 'other')),
  asset_name  TEXT        NOT NULL,
  action      TEXT        NOT NULL CHECK (action IN ('buy', 'sell')),
  quantity    NUMERIC(28, 18) NOT NULL,
  price       NUMERIC(18, 8)  NOT NULL,
  currency    TEXT        NOT NULL DEFAULT 'USD',
  total_value NUMERIC(18, 2)  NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Row-level security
ALTER TABLE trade_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_manage_own_trades" ON trade_entries
  FOR ALL USING (auth.uid() = user_id);

-- Reuse the existing trigger function from 001_initial_schema
CREATE TRIGGER update_trade_entries_updated_at
  BEFORE UPDATE ON trade_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Fast reverse-chronological queries per user
CREATE INDEX idx_trade_entries_user_date
  ON trade_entries(user_id, trade_date DESC);
