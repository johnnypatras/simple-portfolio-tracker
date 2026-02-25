-- Migration 038: Enforce wallet/exchange correlation
-- Custodial wallets (exchanges) → always inside an institution
-- Non-custodial wallets (self-custody) → always standalone (no institution)

-- Step 1: Detach non-custodial wallets from institutions
UPDATE wallets
SET institution_id = NULL
WHERE wallet_type = 'non_custodial'
  AND institution_id IS NOT NULL
  AND deleted_at IS NULL;

-- Step 2: Soft-delete orphaned institutions (no active children in any table)
UPDATE institutions
SET deleted_at = NOW()
WHERE deleted_at IS NULL
  AND id NOT IN (
    SELECT DISTINCT institution_id FROM wallets
    WHERE institution_id IS NOT NULL AND deleted_at IS NULL
  )
  AND id NOT IN (
    SELECT DISTINCT institution_id FROM brokers
    WHERE institution_id IS NOT NULL AND deleted_at IS NULL
  )
  AND id NOT IN (
    SELECT DISTINCT institution_id FROM bank_accounts
    WHERE institution_id IS NOT NULL AND deleted_at IS NULL
  );
