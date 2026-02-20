-- Add broker_deposit to entity_type enum (for activity log)
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'broker_deposit';

-- Broker deposits table (mirrors exchange_deposits, linked to brokers instead of wallets)
CREATE TABLE broker_deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  broker_id UUID NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  currency currency_type DEFAULT 'USD',
  amount NUMERIC(18, 2) DEFAULT 0,
  apy NUMERIC(6, 4) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, broker_id, currency)
);

ALTER TABLE broker_deposits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_manage_own_broker_deposits" ON broker_deposits
  FOR ALL USING (auth.uid() = user_id);

CREATE TRIGGER update_broker_deposits_updated_at
  BEFORE UPDATE ON broker_deposits FOR EACH ROW EXECUTE FUNCTION update_updated_at();
