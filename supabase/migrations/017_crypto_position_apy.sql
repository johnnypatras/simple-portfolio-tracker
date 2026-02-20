-- Add APY field to crypto positions (useful for stablecoins, staking, etc.)
ALTER TABLE crypto_positions ADD COLUMN apy NUMERIC(6, 4) DEFAULT 0;
