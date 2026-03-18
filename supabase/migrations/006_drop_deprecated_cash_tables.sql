-- Drop deprecated cash tables (consolidation verified, single-user app)
DROP TABLE IF EXISTS bank_accounts_deprecated CASCADE;
DROP TABLE IF EXISTS exchange_deposits_deprecated CASCADE;
DROP TABLE IF EXISTS broker_deposits_deprecated CASCADE;
