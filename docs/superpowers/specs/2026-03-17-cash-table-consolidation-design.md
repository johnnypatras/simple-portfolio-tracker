# Cash Table Consolidation Design

**Date**: 2026-03-17
**Status**: Draft
**Problem**: Three separate tables store cash (`bank_accounts`, `exchange_deposits`, `broker_deposits`) with no cross-table uniqueness constraint. Transfers create duplicates when the destination type doesn't match the table where cash already lives.

## 1. Business Rules

1. **One cash entry per institution per currency** — cross-table uniqueness, enforced at DB level
2. **Exception**: Multiple named bank accounts allowed at the same institution+currency (e.g., "Checking EUR" + "Savings EUR")
3. **Bank accounts must have names**; deposits (exchange/broker origin) may optionally have names for labeling
4. A cash account cannot be linked to both a wallet and a broker simultaneously
5. The user never selects which table cash lives in — the system resolves this automatically

## 2. Schema

### New Table: `cash_accounts`

```sql
CREATE TABLE cash_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  institution_id  uuid REFERENCES institutions(id) ON DELETE SET NULL,
  name            text,
  currency        text NOT NULL DEFAULT 'EUR',   -- TEXT not enum (project convention: "TEXT over Postgres enum")
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

  CONSTRAINT chk_cash_origin
    CHECK (NOT (wallet_id IS NOT NULL AND broker_id IS NOT NULL)),
  CONSTRAINT chk_name_not_empty
    CHECK (name IS NULL OR name <> ''),
  CONSTRAINT chk_bank_requires_name
    CHECK (wallet_id IS NOT NULL OR broker_id IS NOT NULL OR name IS NOT NULL)
);
```

### Origin Derivation (no stored column)

Origin is derived in application code from FK presence:

| wallet_id | broker_id | Origin |
|-----------|-----------|--------|
| non-null  | null      | exchange |
| null      | non-null  | broker |
| null      | null      | bank |

### Indexes

```sql
-- Core uniqueness
CREATE UNIQUE INDEX uq_cash_accounts_active
  ON cash_accounts (user_id, institution_id, currency, COALESCE(name, ''))
  WHERE deleted_at IS NULL;

-- Transfer lookups
CREATE INDEX idx_cash_accounts_institution_currency
  ON cash_accounts (institution_id, currency)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_cash_accounts_wallet
  ON cash_accounts (wallet_id, currency)
  WHERE wallet_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX idx_cash_accounts_broker
  ON cash_accounts (broker_id, currency)
  WHERE broker_id IS NOT NULL AND deleted_at IS NULL;

-- General user filter
CREATE INDEX idx_cash_accounts_active
  ON cash_accounts (user_id) WHERE deleted_at IS NULL;
```

### Triggers, RLS, Grants

```sql
CREATE TRIGGER trg_cash_accounts_updated_at
  BEFORE UPDATE ON cash_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE cash_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_manage_own_cash" ON cash_accounts
  USING (auth.uid() = user_id AND public.is_active_user());

-- Note: anon grant included for PostgREST parity with baseline.
-- RLS + is_active_user() is the real guard. Review if 002 revoke pattern should apply.
GRANT ALL ON TABLE cash_accounts TO anon;
GRANT ALL ON TABLE cash_accounts TO authenticated;
GRANT ALL ON TABLE cash_accounts TO service_role;
```

### Unique Index Behavior

| Scenario | COALESCE result | Outcome |
|----------|----------------|---------|
| Two unnamed deposits (NULL), same inst+currency | '' vs '' | Blocked |
| Unnamed deposit + named "Checking", same inst+currency | '' vs 'Checking' | Allowed |
| Two named "Checking", same inst+currency | 'Checking' vs 'Checking' | Blocked |
| "Checking" + "Savings", same inst+currency | 'Checking' vs 'Savings' | Allowed |
| Empty string name + NULL name | '' vs '' | Blocked by `chk_name_not_empty` (empty strings rejected) |

## 3. Database Migration

Single migration file. Steps execute in order within one transaction.

### Step 1: Backfill NULL institution_ids

```sql
-- Backfill legacy NULLs by matching institution name
UPDATE bank_accounts ba SET institution_id = (
  SELECT id FROM institutions
  WHERE name = ba.bank_name AND user_id = ba.user_id
  ORDER BY created_at ASC LIMIT 1
)
WHERE institution_id IS NULL AND deleted_at IS NULL;

-- Verify: zero active rows remain with NULL institution_id
-- If any remain, create missing institutions before proceeding
DO $$
DECLARE orphan_count int;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM bank_accounts WHERE institution_id IS NULL AND deleted_at IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'Migration blocked: % bank_accounts have NULL institution_id', orphan_count;
  END IF;
END $$;
```

### Step 1b: Pre-flight safety checks

```sql
DO $$
DECLARE cnt int;
BEGIN
  -- 1. No exchange_deposits with hard-deleted wallets
  SELECT count(*) INTO cnt FROM exchange_deposits ed
    LEFT JOIN wallets w ON w.id = ed.wallet_id WHERE w.id IS NULL;
  IF cnt > 0 THEN RAISE EXCEPTION 'Blocked: % exchange_deposits have orphaned wallet_id', cnt; END IF;

  -- 2. No broker_deposits with hard-deleted brokers
  SELECT count(*) INTO cnt FROM broker_deposits bd
    LEFT JOIN brokers b ON b.id = bd.broker_id WHERE b.id IS NULL;
  IF cnt > 0 THEN RAISE EXCEPTION 'Blocked: % broker_deposits have orphaned broker_id', cnt; END IF;

  -- 3. No wallets with NULL institution_id (would produce NULL-institution cash_accounts)
  SELECT count(*) INTO cnt FROM wallets w
    JOIN exchange_deposits ed ON ed.wallet_id = w.id AND ed.deleted_at IS NULL
    WHERE w.institution_id IS NULL AND w.deleted_at IS NULL;
  IF cnt > 0 THEN RAISE EXCEPTION 'Blocked: % active exchange_deposits have wallet with NULL institution_id', cnt; END IF;

  -- 4. No brokers with NULL institution_id
  SELECT count(*) INTO cnt FROM brokers b
    JOIN broker_deposits bd ON bd.broker_id = b.id AND bd.deleted_at IS NULL
    WHERE b.institution_id IS NULL AND b.deleted_at IS NULL;
  IF cnt > 0 THEN RAISE EXCEPTION 'Blocked: % active broker_deposits have broker with NULL institution_id', cnt; END IF;
END $$;
```

### Step 1c: Merge cross-table duplicates before migration

If a user has both an exchange_deposit EUR and broker_deposit EUR at the same institution, both would get `name=NULL` and collide on the unique index. Detect and merge these BEFORE creating the new table.

```sql
-- Detect cross-table duplicates: deposits at same institution+currency that would collide
-- (both get name=NULL → COALESCE to '' → identical unique index tuple)
-- Strategy: keep the one with the higher balance, absorb the other's amount, soft-delete it
DO $$
DECLARE
  dup RECORD;
BEGIN
  FOR dup IN
    WITH deposit_institutions AS (
      -- Exchange deposits with their institution
      SELECT ed.id, ed.user_id, w.institution_id, ed.currency, ed.amount, 'exchange' AS origin, ed.deleted_at
      FROM exchange_deposits ed JOIN wallets w ON w.id = ed.wallet_id
      WHERE ed.deleted_at IS NULL
      UNION ALL
      -- Broker deposits with their institution
      SELECT bd.id, bd.user_id, b.institution_id, bd.currency, bd.amount, 'broker' AS origin, bd.deleted_at
      FROM broker_deposits bd JOIN brokers b ON b.id = bd.broker_id
      WHERE bd.deleted_at IS NULL
    ),
    duplicates AS (
      SELECT user_id, institution_id, currency, count(*) AS cnt
      FROM deposit_institutions
      GROUP BY user_id, institution_id, currency
      HAVING count(*) > 1
    )
    SELECT d.user_id, d.institution_id, d.currency
    FROM duplicates d
  LOOP
    -- Log for manual review (these will be auto-merged)
    RAISE NOTICE 'Merging duplicate deposits: user=%, institution=%, currency=%',
      dup.user_id, dup.institution_id, dup.currency;

    -- Merge: add broker_deposit amount to exchange_deposit, soft-delete broker_deposit
    -- (prefer exchange_deposit as survivor — it has wallet_id which is more useful)
    UPDATE exchange_deposits ed SET amount = ed.amount + (
      SELECT COALESCE(SUM(bd.amount), 0) FROM broker_deposits bd
      JOIN brokers b ON b.id = bd.broker_id
      WHERE b.institution_id = dup.institution_id AND bd.currency = dup.currency
        AND bd.user_id = dup.user_id AND bd.deleted_at IS NULL
    )
    FROM wallets w
    WHERE ed.wallet_id = w.id AND w.institution_id = dup.institution_id
      AND ed.currency = dup.currency AND ed.user_id = dup.user_id AND ed.deleted_at IS NULL;

    UPDATE broker_deposits bd SET deleted_at = now()
    FROM brokers b
    WHERE bd.broker_id = b.id AND b.institution_id = dup.institution_id
      AND bd.currency = dup.currency AND bd.user_id = dup.user_id AND bd.deleted_at IS NULL;
  END LOOP;

  -- Also check: bank_account (unnamed) + deposit at same institution+currency
  -- Bank accounts always have names (NOT NULL), so their COALESCE differs from deposits (NULL→'').
  -- These will NOT collide on the unique index. No merge needed for bank+deposit pairs.
END $$;
```

### Step 2: Create cash_accounts table

Full CREATE TABLE + constraints + indexes + triggers + RLS + grants as specified above.

### Step 3: Migrate data (preserve UUIDs)

```sql
-- Bank accounts (origin: bank)
INSERT INTO cash_accounts (id, user_id, institution_id, name, currency, balance,
  apy, region, wallet_id, broker_id, last_was_adjustment, last_was_transfer,
  created_at, updated_at, deleted_at)
SELECT id, user_id, institution_id, name, currency, balance,
  apy, region, NULL, NULL, last_was_adjustment, last_was_transfer,
  created_at, updated_at, deleted_at
FROM bank_accounts;

-- Exchange deposits (origin: exchange)
INSERT INTO cash_accounts (id, user_id, institution_id, name, currency, balance,
  apy, region, wallet_id, broker_id, last_was_adjustment, last_was_transfer,
  created_at, updated_at, deleted_at)
SELECT ed.id, ed.user_id, w.institution_id, NULL, ed.currency, ed.amount,
  ed.apy, NULL, ed.wallet_id, NULL, ed.last_was_adjustment, ed.last_was_transfer,
  ed.created_at, ed.updated_at, ed.deleted_at
FROM exchange_deposits ed
JOIN wallets w ON w.id = ed.wallet_id AND w.user_id = ed.user_id;

-- Broker deposits (origin: broker)
INSERT INTO cash_accounts (id, user_id, institution_id, name, currency, balance,
  apy, region, wallet_id, broker_id, last_was_adjustment, last_was_transfer,
  created_at, updated_at, deleted_at)
SELECT bd.id, bd.user_id, b.institution_id, NULL, bd.currency, bd.amount,
  bd.apy, NULL, NULL, bd.broker_id, bd.last_was_adjustment, bd.last_was_transfer,
  bd.created_at, bd.updated_at, bd.deleted_at
FROM broker_deposits bd
JOIN brokers b ON b.id = bd.broker_id AND b.user_id = bd.user_id;
```

### Step 4: Add entity_type enum value

```sql
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'cash_account';
```

**Important**: The old enum values (`bank_account`, `exchange_deposit`, `broker_deposit`) must NEVER be removed. Historical activity log rows permanently reference them. This is an append-only enum.

### Step 5: Update cascade_soft_delete() trigger

Replace old table references in both delete and restore branches:

- `WHEN 'wallets'` → `UPDATE cash_accounts SET deleted_at = ... WHERE wallet_id = NEW.id`
- `WHEN 'brokers'` → `UPDATE cash_accounts SET deleted_at = ... WHERE broker_id = NEW.id`
- `WHEN 'institutions'` → `UPDATE cash_accounts SET deleted_at = ... WHERE institution_id = NEW.id`

Same pattern for restore branch (clearing `deleted_at`).

### Step 6: Update sync_institution_name() trigger

Remove the `UPDATE bank_accounts SET bank_name = NEW.name` line. The new schema joins to `institutions.name` directly; `cash_accounts` has no `bank_name` column.

### Step 7: Deprecate old tables

```sql
ALTER TABLE bank_accounts RENAME TO bank_accounts_deprecated;
ALTER TABLE exchange_deposits RENAME TO exchange_deposits_deprecated;
ALTER TABLE broker_deposits RENAME TO broker_deposits_deprecated;

REVOKE ALL ON TABLE bank_accounts_deprecated FROM anon, authenticated;
REVOKE ALL ON TABLE exchange_deposits_deprecated FROM anon, authenticated;
REVOKE ALL ON TABLE broker_deposits_deprecated FROM anon, authenticated;

DROP TRIGGER IF EXISTS update_bank_accounts_updated_at ON bank_accounts_deprecated;
DROP TRIGGER IF EXISTS update_exchange_deposits_updated_at ON exchange_deposits_deprecated;
DROP TRIGGER IF EXISTS update_broker_deposits_updated_at ON broker_deposits_deprecated;
```

### Deprecated Table Lifecycle

| Day | Action |
|-----|--------|
| 0 | Deploy. Old tables renamed, grants revoked, triggers dropped. |
| 30 | Monitor `pg_stat_user_tables` — verify zero scans on deprecated tables. |
| 60 | DROP deprecated tables. |

## 4. Backward Compatibility

### 4.1 Undo System (`undo.ts`)

Three remapping layers applied at the start of `undoSingleEntry`:

```typescript
// Table resolution — apply before all 6 dynamic .from() call sites
// (5 × log.entity_table + 1 × comp.entity_table in rollbackCompensation)
const TABLE_REMAP: Record<string, string> = {
  bank_accounts: "cash_accounts",
  exchange_deposits: "cash_accounts",
  broker_deposits: "cash_accounts",
};

// Snapshot field renaming — transform before_snapshot/after_snapshot keys
const SNAPSHOT_FIELD_REMAP: Record<string, Record<string, string>> = {
  exchange_deposits: { amount: "balance" },
  broker_deposits: { amount: "balance" },
};

// Update existing maps
VALUE_FIELDS["cash_accounts"] = ["balance"];
ALLOWED_UNDO_TABLES.add("cash_accounts");
// Keep old names in ALLOWED_UNDO_TABLES for historical entries
```

Compensation entries write `entity_table: "cash_accounts"` (resolved name).

Identity fields (`wallet_id` → `institution_id`): UUID mismatch means undo safely skips identity restoration for old entries. Balance delta reversal (the critical part) works correctly via UUID lookup.

### 4.2 Activity Log

- Historical entries: untouched (old `entity_table` and `entity_type` values preserved as audit trail)
- New entries: `entity_table: "cash_accounts"`, `entity_type: "cash_account"`
- All functions that classify entity types add `"cash_account"` alongside old values
- **Currency type change**: Old tables used `currency_type` Postgres enum; new table uses `text`. The enum remains in the database for `profiles.primary_currency` but is no longer used by cash tables. Migration INSERT...SELECT implicitly casts enum → text.

### 4.3 TypeScript Types

```typescript
// Keep old values in union for backward compat
export type EntityType =
  | "bank_account" | "exchange_deposit" | "broker_deposit"  // legacy
  | "cash_account"                                            // new
  | "crypto_asset" | "stock_asset" | ...;

// New unified type
export interface CashAccount {
  id: string;
  user_id: string;
  institution_id: string | null;
  name: string | null;
  currency: string;
  balance: number;
  apy: number;
  region: string | null;
  wallet_id: string | null;
  broker_id: string | null;
  last_was_adjustment: boolean;
  last_was_transfer: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
```

### 4.4 Transfer System

Break client immediately (atomic Vercel deploy — no rolling deployment window):

```typescript
// Old: 3 separate cash variants in TransferSide
// New: 1 unified variant
type TransferSide =
  | { type: "cash_account"; accountId: string; amount: number }
  | { type: "crypto_position"; assetId: string; walletId: string; quantity: number }
  | { type: "stock_position"; assetId: string; brokerId: string; quantity: number };

// SourceOriginalState: collapse 3 cash variants into 1
// Old bank_account variant had: id, balance, name, bank_name, currency
// New cash_account variant: id, balance only.
// Dropped fields:
//   - bank_name: institution name via JOIN, not stored on cash_accounts
//   - name: not needed for rollback (rollback only reverses balance delta)
//   - currency: not needed for rollback (FX conversion uses prices fetched separately)
type SourceOriginalState =
  | { type: "crypto_position"; quantity: number }
  | { type: "stock_position"; quantity: number }
  | { type: "cash_account"; id: string; balance: number };
```

### 4.5 Import/Export

| Direction | Strategy |
|-----------|---------|
| Export v3 | Bump `PortfolioBackup.version` to `3`. Single `cashAccounts` array + legacy arrays (split by origin) for one version cycle |
| Import v1/v2 | Normalize three arrays into unified `cashAccounts` at parse time, then process as v3 |
| Import v3 | Single `cashAccounts` array directly |
| Cross-table dedup | `findExistingCash(institutionId, currency)` during import |
| Validation | `validateBackup` needs version-conditional: v1/v2 require `bankAccounts`/`exchangeDeposits`/`brokerDeposits`, v3 requires `cashAccounts` |
| Settings labels | `import-export-settings.tsx`: replace "Fiat Deposits (Exchanges)" + "Fiat Deposits (Brokers)" with single "Cash Accounts" row |

### 4.6 Helper Functions

| Function | File | Change |
|----------|------|--------|
| `classifyAssetClass()` | `cashflow.ts` | Add `"cash_account"` to cash branch |
| `cashAmountField()` | `deltas.ts` | Add `"cash_account" → "balance"`. Also update exported `CashEntityType` union to include `"cash_account"` (keep old 3 for compat). |
| `getAssetClass()` | `activity-log.ts` | Add `"cash_account"` mapping |
| Backfill constants | `backfill.ts` | Add `"cash_account"` to `CASH_ENTITY_TYPES` |
| Timeline labels | `activity-timeline.tsx` | Add `cash_account: "Cash"` to `ENTITY_LABELS`. Update `ENTITY_FILTER_OPTIONS`: add `cash_account`, remove old 3 entries (note: `broker_deposit` was already missing — existing bug). Update `CASH_FLOW_ENTITIES` array. |
| `HoldingItem.type` | `types.ts` | Replace `"bank"` + `"exchange_deposit"` + `"broker_deposit"` → `"cash"` (note: bank uses `"bank"` not `"bank_account"`) |

## 5. UX Changes

### 5.1 Transfer Dialog Destination

**Remove**: 3-tab type picker (Broker Cash / Exchange Cash / Bank)

**Replace with**: Flat institution-grouped cash account picker:

```
── Alpha Bank ──────────────────────
   Checking EUR                €5,000
   Savings EUR                €10,000
── Trade Republic ──────────────────
   EUR                         €6,500
── Revolut ─────────────────────────
   EUR (new)
```

Each line is directly selectable. `(new)` entries appear for institutions with roles but no cash in the transfer's currency. Self-custody wallets excluded.

Pre-select same institution for sell proceeds. Block same-account transfers inline (before submission).

### 5.2 Accounts View

**Single "Add Cash" button** replaces "Add Exchange Deposit" / "Add Broker Deposit" / "Add Bank Account".

Form: currency + amount + APY. If institution has bank role (and no unnamed deposit exists): also show name field. If unnamed cash already exists at institution+currency: block with "EUR cash already exists — edit the existing account."

### 5.3 Invalid State Detection (Legacy Data)

**State definitions** (for institution + currency):
- S0: no cash — S1: 1 bank account — S2: N bank accounts — S3: 1 exchange deposit — S4: 1 broker deposit
- S5: bank + exchange (invalid) — S6: bank + broker (invalid) — S7: exchange + broker (invalid) — S8: all three (invalid)

On accounts page load, detect S5/S6/S7/S8 states (multiple cash types at same institution+currency). Show banner:

```
Trade Republic has duplicate EUR cash entries. [Merge]
```

Merge: sum balances into survivor (prefer bank_account > exchange_deposit > broker_deposit), soft-delete duplicate, log both legs as adjustment.

### 5.4 Role Changes

**Adding role**: Cross-table check on all cash creation paths. `also_bank` auto-create skips if cash already exists at institution+currency.

**Removing role with cash > 0**: Migrate cash to remaining role's table type. Priority: bank > exchange > broker. Confirm with user: "Removing wallet role will move your EUR deposit to your bank account. Continue?" If no remaining role: block removal.

**Removing role with cash = 0**: Auto-delete zero-balance record, proceed with role removal.

## 6. findExistingCash() Helper

Core helper used by transfers, creation, and merge detection:

```typescript
async function findExistingCash(
  supabase: SupabaseClient,
  userId: string,
  institutionId: string,
  currency: string
): Promise<CashAccount[]> {
  const { data } = await supabase
    .from("cash_accounts")
    .select("*")
    .eq("user_id", userId)        // defense-in-depth (RLS also filters)
    .eq("institution_id", institutionId)
    .eq("currency", currency)
    .is("deleted_at", null);
  return data ?? [];
}
```

Returns all cash accounts at institution+currency. Callers decide behavior:

| Caller | 0 results | 1 result | N results (multiple named bank accounts) |
|--------|-----------|----------|------------------------------------------|
| Transfer dest | Create new (type based on inst roles) | Auto-route to it | Show picker |
| Add Cash | Allow creation | Block (or allow 2nd named bank account) | Block unnamed; allow named if different name |
| Sell proceeds | Create new | Auto-route | Show picker |
| Buy deduction | Create new | Deduct from it | Show picker |

## 7. Application Code Changes

### Files Deleted (3)

- `src/lib/actions/bank-accounts.ts` (~510 lines)
- `src/lib/actions/exchange-deposits.ts` (~390 lines)
- `src/lib/actions/broker-deposits.ts` (~380 lines)

### Files Created (2)

- `src/lib/actions/cash-accounts.ts` (~450 lines)
- `src/components/cash/cash-account-modal.tsx` (~replaces 3 modals)

### Files Modified (~33)

| File | Change |
|------|--------|
| **Server Actions** | |
| `transfers.ts` | 5 branches → 3 per function, unified cash_account handling, `findExistingCash()` |
| `undo.ts` | TABLE_REMAP, SNAPSHOT_FIELD_REMAP at all 6 dynamic `.from()` sites |
| `institutions.ts` | `also_bank` cross-check, role removal migration, ~5 `.from("bank_accounts")` sites |
| `wallets.ts` | Imports `deleteExchangeDeposit`, queries `exchange_deposits`, has `also_bank` bank_accounts insert |
| `brokers.ts` | Imports `deleteBrokerDeposit`, queries `broker_deposits`, has `also_bank` bank_accounts insert |
| `trades.ts` | Queries `.from("bank_accounts")` for currency list in trade entry form |
| `import.ts` | 3 blocks → 1, v3 format, v1/v2 normalization |
| `export.ts` | 3 sections → 1, dual-format output for backward compat |
| `comparison.ts` | 3 fetches → 1 |
| `shared-portfolio.ts` | 3 fetches → 1, `SharedPortfolioData` interface updated |
| `activity-log.ts` | Add `"cash_account"` to asset class mapping |
| `backfill.ts` | Add `"cash_account"` to `CASH_ENTITY_TYPES` |
| **Types** | |
| `types.ts` | `CashAccount` interface, updated `TransferSide`, `EntityType`, `HoldingItem` |
| **Portfolio Logic** | |
| `assemble.ts` | `PortfolioAssets` interface: 3 fields → 1 `cashAccounts`, pass-through updated |
| `aggregate.ts` | 3 cash loops → 1 |
| `institution-grouping.ts` | 3 cash loops → 1 |
| `dashboard-insights.ts` | 3 cash params → 1, cash breakdown + currency exposure loops unified |
| `holdings.ts` | 3 cash arrays → 1 |
| `cashflow.ts` | Add `"cash_account"` to `classifyAssetClass()` |
| `deltas.ts` | Update `cashAmountField()` |
| **Dashboard Pages** | |
| `dashboard/page.tsx` | `getCashAccounts()` replaces 3 parallel fetches |
| `cash/page.tsx` | `getCashAccounts()` replaces 3 calls |
| `accounts/page.tsx` | Same |
| **Share Pages** | |
| `share/[token]/page.tsx` | Destructure single `cashAccounts` from shared portfolio |
| `share/[token]/accounts/page.tsx` | Same |
| `share/[token]/cash/page.tsx` | Same |
| `share/[token]/crypto/page.tsx` | Pass single empty `cashAccounts: []` |
| `share/[token]/stocks/page.tsx` | Same |
| **API Routes** | |
| `api/holdings/route.ts` | `getCashAccounts()` replaces 3 parallel fetches |
| **Edge Function** | |
| `supabase/functions/daily-snapshot/index.ts` | Replace 3 direct table queries with single `cash_accounts` query |
| **UI Components** | |
| `transfer-dialog.tsx` | Remove type tabs, institution-grouped picker, same-account detection |
| `cash-table.tsx` | Remove exchange/broker sections, single list grouped by institution |
| `cash-columns.tsx` | Unified column definitions for single cash type |
| `accounts-view.tsx` | Unified "Add Cash" button, merge banner for invalid states |
| `add-institution-modal.tsx` | `also_bank` creation routes through `findExistingCash()` |
| `activity-timeline.tsx` | Add `cash_account: "Cash"` label |
| `import-export-settings.tsx` | Update labels/counts |

### Net Code Impact

~1,280 lines deleted (three near-identical action files + three modals), ~450 lines created (unified action + modal). **Net reduction: ~800 lines.** Total files touched: ~40 (3 deleted + 2 created + 35 modified).

## 8. Testing Strategy

### Unit Tests

- `findExistingCash()` — all return states (0, 1, N results)
- `CashAccount` CRUD — create, update, delete, soft-delete
- Origin derivation — wallet_id/broker_id presence → correct origin string
- Undo remapping — TABLE_REMAP, SNAPSHOT_FIELD_REMAP transform correctly
- Import v1/v2 normalization — three arrays merge into one
- Transfer routing — each destination state (S0-S4) routes correctly

### Integration Tests

- Migration verification — row counts match before/after
- Unique constraint — duplicate unnamed deposit blocked, multiple named accounts allowed
- `chk_bank_requires_name` — bank accounts require name, deposits allow optional name
- `chk_cash_origin` — reject rows with both wallet_id and broker_id
- Cascade soft-delete — deleting wallet/broker/institution cascades to cash_accounts
- RLS — user can only access own cash_accounts
- Transfer end-to-end — sell stock → cash routed to existing account (not duplicate)
- Undo on historical entry — old entity_table remapped, balance delta applied correctly

### Component Tests

- Transfer dialog — institution-grouped picker renders, same-account blocked
- Add Cash — form shows name field for bank role, blocks duplicate
- Merge banner — appears for invalid states, merge action works

### Existing Test Files Requiring Updates (8 files, ~25 cases)

| File | Layer | Action | Cases |
|------|-------|--------|-------|
| `institution-grouping.test.ts` | Unit | **Rewrite** factories + assertions. Replace `BankAccount`/`ExchangeDeposit`/`BrokerDeposit` with `CashAccount`. Update `.type` string assertions. | ~8 |
| `holdings.test.ts` | Unit | Update type import, inline object shapes, call-site prop names | ~4 |
| `activity-log.test.ts` | Unit | Update/collapse `cashAmountField` string literal tests. May delete 2 of 3 if function simplifies. | ~3 |
| `cashflow.test.ts` | Unit | Update/collapse `classifyAssetClass` string literal tests. May delete 2 of 3. | ~3 |
| `migration-bootstrap.test.ts` | Integration | Replace 3 old table names with `cash_accounts` in expected-tables array | 1 |
| `cascade-delete.test.ts` | Integration | **Partial rewrite** of 3 cascade test cases (institution→bank, wallet→exchange, broker→broker_deposit). Table names + trigger behavior changed. | 3 |
| `cashflow-write.test.ts` | Integration | Change `entity_type: "bank_account"` → `"cash_account"` | 1 |
| `transfer-rollback.test.ts` | Integration | Change `entity_type: "exchange_deposit"` → `"cash_account"` (2 string literals) | 1 |

## 9. Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Migration fails on unique constraint (existing duplicates) | Pre-migration query to detect and merge duplicates before applying constraint |
| NULL institution_id on legacy bank_accounts | Backfill step with verification assertion before data migration |
| Orphaned deposits (wallet/broker hard-deleted) silently dropped by INNER JOIN | Pre-flight orphan check: `LEFT JOIN ... WHERE w.id IS NULL` must return 0 for both exchange_deposits and broker_deposits |
| Undo breaks for historical entries | TABLE_REMAP + SNAPSHOT_FIELD_REMAP at all 6 dynamic `.from()` sites (5 × `log.entity_table` + 1 × `comp.entity_table`), tested with real historical data |
| Import of old backup creates duplicates | Cross-table dedup via `findExistingCash()` during import |
| Import v3 backup rejected by old validation | Version-conditional `validateBackup`: v1/v2 require old 3 arrays, v3 requires `cashAccounts` |
| cascade_soft_delete references old tables | Updated in same migration transaction |
| Concurrent operations bypass findExistingCash | Unique index is the safety net — insert fails with 23505 |
| FK behavior change: wallet_id/broker_id ON DELETE CASCADE → SET NULL | Intentional: app uses soft-deletes, hard cascade was never triggered. Documented for awareness. |
| `bank_name` column dropped from schema | Intentional: institution name accessed via JOIN to `institutions.name`. No data loss — `bank_name` was kept in sync by `sync_institution_name()` trigger. |
| NULL institution_id not protected by unique index post-migration | Application enforces via `findExistingCash()` requiring institution_id. Backfill blocks NULL at migration time. |

## 10. Review History

| Reviewer | Focus | Key Findings |
|----------|-------|-------------|
| Software Architect | Schema design, approach validation | Confirmed Approach B, dropped `origin` column, added `chk_cash_origin` |
| Database Optimizer | Indexes, constraints, query patterns | Composite institution+currency index, `chk_name_not_empty`, `chk_bank_requires_name`, updated_at trigger |
| Security Engineer | RLS, grants, triggers, FKs | Critical: cascade_soft_delete + sync_institution_name triggers, GRANTs required, FK ON DELETE SET NULL for wallet/broker |
| Backend Architect | Undo, import/export, migration | 5 `.from()` remap sites, snapshot field mismatch, break client immediately, cashAmountField update |
| Spec Reviewer (Code Reviewer) | Completeness, correctness, consistency | institution_id NOT NULL vs ON DELETE SET NULL conflict, entity_type enum permanence, currency type doc, backfill verification, migration JOIN safety, findExistingCash user_id filter |
| App Code Auditor (code-explorer) | Line-by-line audit of all 36 files | 12 gaps: SourceOriginalState bank_name, validateBackup v3, CashEntityType union, undo .from() count, HoldingItem type naming, ENTITY_FILTER_OPTIONS, import label text |
| DB Layer Auditor (code-explorer) | Full migration inventory: tables, indexes, triggers, functions, FKs, grants, RLS, edge function | Pre-flight orphan check, bank_name drop documentation, FK behavior change, deprecated table index cleanup |
| Undo Scenario Tracer | End-to-end trace of historical exchange_deposit undo | Confirmed 6 .from() sites, verified TABLE_REMAP + SNAPSHOT_FIELD_REMAP design works at each step, flagged compensation entity_table must use resolved name |
| Test Auditor | All test files under __tests__/ | 8 files / ~25 cases need updating. institution-grouping.test.ts needs full rewrite, cascade-delete.test.ts needs partial rewrite |
| SQL Verification | Migration SQL correctness against PG 15 | **Critical**: cross-table duplicate merge step missing (exchange+broker at same inst+currency collide on unique index). Also: wallets/brokers NULL institution_id pre-flight check |
| Spec Coherence Reviewer | Internal consistency after 3 rounds of edits | .from() count mismatch, stale constraint name, SourceOriginalState currency drop undocumented |
