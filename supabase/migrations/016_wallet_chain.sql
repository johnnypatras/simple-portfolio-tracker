-- Add optional chain field to wallets
-- Used to define what blockchain a wallet supports (e.g. "Bitcoin", "Ethereum")
-- Especially useful for non-custodial wallets to validate asset compatibility
ALTER TABLE wallets ADD COLUMN chain TEXT;
