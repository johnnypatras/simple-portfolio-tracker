# Revert Plan: Soft Deletes + Undo System

> **Purpose**: This document describes exactly how to roll back the soft-delete
> and undo system to the previous hard-delete behavior, should that ever be
> needed. It covers database schema, application code, and UI changes.
>
> **Date implemented**: 2026-02-24
>
> **Commits involved** (in chronological order):
>
> | Commit    | Description |
> |-----------|-------------|
> | `265958c` | feat: add soft deletes, audit snapshots, and undo system |
> | `2b5d2f3` | fix(migration): handle stock_assets partial indexes from migration 013 |
> | `2deb0c7` | fix: audit fixes for soft-delete system completeness |
> | `c4edfb5` | feat: add dedicated 'undone' action type for undo audit entries |
> | `fc02509` | fix: resolve button-in-button hydration error on accounts page |
> | `0d192fd` | feat: replace native confirm() with inline ConfirmButton component |
>
> **Pre-soft-delete baseline commit**: `e0573bb` ("Show APY badge on crypto
> positions in accounts view")
>
> **Migrations involved**: `024`, `025`, `026`, `027`

---

## Table of Contents

1. [Quick Revert (Git)](#1-quick-revert-git)
2. [Database Rollback Migration](#2-database-rollback-migration)
3. [Application Code Changes](#3-application-code-changes)
4. [UI Changes](#4-ui-changes)
5. [Type Changes](#5-type-changes)
6. [Deleted Files](#6-deleted-files)
7. [Data Considerations](#7-data-considerations)
8. [Verification Checklist](#8-verification-checklist)

---

## 1. Quick Revert (Git)

If no other changes have been committed on top of the soft-delete work, a
clean git revert to the baseline commit can handle the application code:

```bash
git revert --no-commit 0d192fd fc02509 c4edfb5 2deb0c7 2b5d2f3 265958c
git commit -m "revert: remove soft deletes + undo system"
```

**However**, this does NOT revert the database schema. You must still apply
the rollback migration in Section 2 to the remote Supabase database.

If other work has been committed after `0d192fd`, you'll need to do manual
reverts as described in Sections 3-6.

---

## 2. Database Rollback Migration

Create a new migration file (e.g. `028_revert_soft_deletes.sql`) with the
following SQL. This reverses migrations 024, 025, 026, and 027.

**⚠️ CRITICAL**: Before running this, you must decide what to do with
soft-deleted rows (rows where `deleted_at IS NOT NULL`). See Section 7.

```sql
-- ================================================================
-- REVERT: Undo soft deletes + audit system (reverses 024-027)
-- ================================================================

-- ── 0. Hard-delete all soft-deleted rows first ───────────────
-- If you want to KEEP soft-deleted data, skip this section and
-- instead run: UPDATE <table> SET deleted_at = NULL;
-- to restore all rows before dropping the column.

DELETE FROM crypto_positions   WHERE deleted_at IS NOT NULL;
DELETE FROM goal_prices        WHERE deleted_at IS NOT NULL;
DELETE FROM stock_positions    WHERE deleted_at IS NOT NULL;
DELETE FROM exchange_deposits  WHERE deleted_at IS NOT NULL;
DELETE FROM broker_deposits    WHERE deleted_at IS NOT NULL;
DELETE FROM bank_accounts      WHERE deleted_at IS NOT NULL;
DELETE FROM wallets            WHERE deleted_at IS NOT NULL;
DELETE FROM brokers            WHERE deleted_at IS NOT NULL;
DELETE FROM crypto_assets      WHERE deleted_at IS NOT NULL;
DELETE FROM stock_assets       WHERE deleted_at IS NOT NULL;
DELETE FROM institutions       WHERE deleted_at IS NOT NULL;
DELETE FROM trade_entries      WHERE deleted_at IS NOT NULL;
DELETE FROM diary_entries      WHERE deleted_at IS NOT NULL;

-- ── 1. Drop cascade soft-delete triggers ─────────────────────

DROP TRIGGER IF EXISTS soft_delete_cascade_crypto_assets ON crypto_assets;
DROP TRIGGER IF EXISTS soft_delete_cascade_stock_assets ON stock_assets;
DROP TRIGGER IF EXISTS soft_delete_cascade_wallets ON wallets;
DROP TRIGGER IF EXISTS soft_delete_cascade_brokers ON brokers;
DROP TRIGGER IF EXISTS soft_delete_cascade_institutions ON institutions;

DROP FUNCTION IF EXISTS cascade_soft_delete();

-- ── 2. Drop performance indexes ──────────────────────────────

DROP INDEX IF EXISTS idx_crypto_assets_active;
DROP INDEX IF EXISTS idx_stock_assets_active;
DROP INDEX IF EXISTS idx_wallets_active;
DROP INDEX IF EXISTS idx_brokers_active;

-- ── 3. Restore original unique constraints ───────────────────
-- Drop partial unique indexes and recreate the original constraints.

-- crypto_assets
DROP INDEX IF EXISTS uq_crypto_assets_active;
ALTER TABLE crypto_assets
  ADD CONSTRAINT crypto_assets_user_id_coingecko_id_key
  UNIQUE (user_id, coingecko_id);

-- crypto_positions
DROP INDEX IF EXISTS uq_crypto_positions_active;
ALTER TABLE crypto_positions
  ADD CONSTRAINT crypto_positions_crypto_asset_id_wallet_id_key
  UNIQUE (crypto_asset_id, wallet_id);

-- goal_prices
DROP INDEX IF EXISTS uq_goal_prices_active;
ALTER TABLE goal_prices
  ADD CONSTRAINT goal_prices_crypto_asset_id_label_key
  UNIQUE (crypto_asset_id, label);

-- stock_assets: restore the TWO partial indexes from migration 013
-- (NOT a regular UNIQUE constraint — these predate the soft-delete work)
DROP INDEX IF EXISTS uq_stock_assets_yahoo_active;
DROP INDEX IF EXISTS uq_stock_assets_ticker_active;
CREATE UNIQUE INDEX stock_assets_user_yahoo_ticker_unique
  ON stock_assets (user_id, yahoo_ticker)
  WHERE yahoo_ticker IS NOT NULL;
CREATE UNIQUE INDEX stock_assets_user_ticker_no_yahoo_unique
  ON stock_assets (user_id, ticker)
  WHERE yahoo_ticker IS NULL;

-- stock_positions
DROP INDEX IF EXISTS uq_stock_positions_active;
ALTER TABLE stock_positions
  ADD CONSTRAINT stock_positions_stock_asset_id_broker_id_key
  UNIQUE (stock_asset_id, broker_id);

-- exchange_deposits
DROP INDEX IF EXISTS uq_exchange_deposits_active;
ALTER TABLE exchange_deposits
  ADD CONSTRAINT exchange_deposits_user_id_wallet_id_currency_key
  UNIQUE (user_id, wallet_id, currency);

-- broker_deposits
DROP INDEX IF EXISTS uq_broker_deposits_active;
ALTER TABLE broker_deposits
  ADD CONSTRAINT broker_deposits_user_id_broker_id_currency_key
  UNIQUE (user_id, broker_id, currency);

-- institutions
DROP INDEX IF EXISTS uq_institutions_active;
ALTER TABLE institutions
  ADD CONSTRAINT institutions_user_id_name_key
  UNIQUE (user_id, name);

-- ── 4. Remove deleted_at from all 13 tables ──────────────────

ALTER TABLE crypto_assets      DROP COLUMN deleted_at;
ALTER TABLE crypto_positions   DROP COLUMN deleted_at;
ALTER TABLE goal_prices        DROP COLUMN deleted_at;
ALTER TABLE stock_assets       DROP COLUMN deleted_at;
ALTER TABLE stock_positions    DROP COLUMN deleted_at;
ALTER TABLE wallets            DROP COLUMN deleted_at;
ALTER TABLE brokers            DROP COLUMN deleted_at;
ALTER TABLE bank_accounts      DROP COLUMN deleted_at;
ALTER TABLE exchange_deposits  DROP COLUMN deleted_at;
ALTER TABLE broker_deposits    DROP COLUMN deleted_at;
ALTER TABLE institutions       DROP COLUMN deleted_at;
ALTER TABLE trade_entries      DROP COLUMN deleted_at;
ALTER TABLE diary_entries      DROP COLUMN deleted_at;

-- ── 5. Remove audit/undo columns from activity_log ───────────

DROP INDEX IF EXISTS idx_activity_log_entity;

ALTER TABLE activity_log DROP COLUMN IF EXISTS entity_id;
ALTER TABLE activity_log DROP COLUMN IF EXISTS entity_table;
ALTER TABLE activity_log DROP COLUMN IF EXISTS before_snapshot;
ALTER TABLE activity_log DROP COLUMN IF EXISTS after_snapshot;
ALTER TABLE activity_log DROP COLUMN IF EXISTS undone_at;

-- ── 6. Handle the 'undone' enum value ────────────────────────
-- PostgreSQL does NOT support removing a value from an enum.
-- Two options:
--
-- OPTION A (safe, leaves a harmless unused value):
--   Do nothing. The 'undone' value stays in the enum but is never
--   used by the application. Existing 'undone' rows stay in the log.
--
-- OPTION B (clean, recreates the enum — more complex):
--   1. Rename old enum
--   2. Create new enum without 'undone'
--   3. Alter column to use new enum
--   4. Drop old enum
--
-- Uncomment OPTION B below if you want a clean enum:

-- -- First, update any 'undone' rows back to 'updated'
-- UPDATE activity_log SET action = 'updated' WHERE action = 'undone';
--
-- -- Recreate the enum without 'undone'
-- ALTER TYPE action_type RENAME TO action_type_old;
-- CREATE TYPE action_type AS ENUM ('created', 'updated', 'removed');
-- ALTER TABLE activity_log
--   ALTER COLUMN action TYPE action_type
--   USING action::text::action_type;
-- DROP TYPE action_type_old;
```

### Applying the migration

```bash
# Local (if using local Supabase)
supabase db push

# Remote (direct SQL via Supabase dashboard or psql)
# Copy the SQL above into the Supabase SQL Editor and run it
```

---

## 3. Application Code Changes

### 3a. Revert all DELETE calls (soft-delete → hard-delete)

**Pattern to find**: Every `.update({ deleted_at: ... }).eq("id", ...)` that
represents a delete operation must be changed back to `.delete().eq("id", ...)`.

**Files affected** (11 server action files):

| File | What to change |
|------|----------------|
| `src/lib/actions/crypto.ts` | `deleteCryptoAsset`, `deleteCryptoPosition` |
| `src/lib/actions/stocks.ts` | `deleteStockAsset`, `deleteStockPosition` |
| `src/lib/actions/wallets.ts` | `deleteWallet` |
| `src/lib/actions/brokers.ts` | `deleteBroker` |
| `src/lib/actions/bank-accounts.ts` | `deleteBankAccount` |
| `src/lib/actions/exchange-deposits.ts` | `deleteExchangeDeposit` |
| `src/lib/actions/broker-deposits.ts` | `deleteBrokerDeposit` |
| `src/lib/actions/institutions.ts` | `deleteInstitution` |
| `src/lib/actions/trades.ts` | `deleteTradeEntry` |
| `src/lib/actions/diary.ts` | `deleteDiaryEntry` (if applicable) |
| `src/lib/actions/goal-prices.ts` | `deleteGoalPrice` |

**Before (soft-delete)**:
```ts
// Fetch snapshot before soft-delete
const { data: snapshot } = await supabase
  .from("crypto_assets")
  .select("*")
  .eq("id", id)
  .single();

const { error } = await supabase
  .from("crypto_assets")
  .update({ deleted_at: new Date().toISOString() })
  .eq("id", id);
```

**After (hard-delete, original behavior)**:
```ts
const { error } = await supabase
  .from("crypto_assets")
  .delete()
  .eq("id", id);
```

### 3b. Remove `.is("deleted_at", null)` from all SELECT queries

**Pattern to find**: Every `.is("deleted_at", null)` filter on Supabase
queries must be removed.

**Grep command**: `grep -rn 'is("deleted_at"' src/lib/actions/`

This appears in every `select()` call across all 11 server action files.
Simply delete those lines.

**Before**:
```ts
const { data } = await supabase
  .from("crypto_assets")
  .select("*")
  .eq("user_id", user.id)
  .is("deleted_at", null);
```

**After**:
```ts
const { data } = await supabase
  .from("crypto_assets")
  .select("*")
  .eq("user_id", user.id);
```

### 3c. Simplify logActivity calls (remove snapshot fields)

Every `logActivity()` call across all 11 server action files was extended
with `entity_id`, `entity_table`, `before_snapshot`, and `after_snapshot`.
These must be removed.

Also remove the "capture before snapshot" and "capture after snapshot"
queries that were added before/after each mutation.

**Before (with snapshots)**:
```ts
// Capture before snapshot
const { data: before } = await supabase
  .from("crypto_assets")
  .select("*")
  .eq("id", id)
  .single();

// ... mutation ...

// Capture after snapshot
const { data: after } = await supabase
  .from("crypto_assets")
  .select("*")
  .eq("id", id)
  .single();

await logActivity({
  action: "updated",
  entity_type: "crypto_asset",
  entity_name: label,
  description: `Updated ${ticker} metadata`,
  entity_id: id,
  entity_table: "crypto_assets",
  before_snapshot: before,
  after_snapshot: after,
});
```

**After (original format)**:
```ts
// ... mutation ...

await logActivity({
  action: "updated",
  entity_type: "crypto_asset",
  entity_name: label,
  description: `Updated ${ticker} metadata`,
  details: { ...fields },
});
```

### 3d. Revert logActivity signature

**File**: `src/lib/actions/activity-log.ts`

Remove the 4 new parameters from the `logActivity` function and its insert
call:

```ts
// REMOVE these parameters:
entity_id?: string;
entity_table?: string;
before_snapshot?: unknown;
after_snapshot?: unknown;

// REMOVE from the .insert() call:
entity_id: params.entity_id ?? null,
entity_table: params.entity_table ?? null,
before_snapshot: params.before_snapshot ?? null,
after_snapshot: params.after_snapshot ?? null,
```

The original signature was:
```ts
export async function logActivity(params: {
  action: ActionType;
  entity_type: EntityType;
  entity_name: string;
  description: string;
  details?: Record<string, unknown>;
}): Promise<void>
```

### 3e. Revert `upsertPosition` zero-quantity handling

In `crypto.ts` and `stocks.ts`, the `upsertPosition` functions were changed
to soft-delete positions when quantity reaches 0. Revert to hard-delete:

```ts
// Before (soft-delete):
await supabase
  .from("crypto_positions")
  .update({ deleted_at: new Date().toISOString() })
  .eq("id", existingId);

// After (hard-delete, original):
await supabase
  .from("crypto_positions")
  .delete()
  .eq("id", existingId);
```

---

## 4. UI Changes

### 4a. Remove undo button from activity-timeline.tsx

**File**: `src/components/history/activity-timeline.tsx`

Remove:
- `import { Undo2 } from "lucide-react"` (the icon)
- `import { ConfirmButton } from "@/components/ui/confirm-button"`
- `import { undoActivity } from "@/lib/actions/undo"`
- The `handleUndo` function
- The entire `<ConfirmButton>` JSX block that renders the undo button per log entry
- The "undone" badge rendering (`log.undone_at` check)
- The `"undone"` entries in `ACTION_FILTER_OPTIONS`, `getActionIcon`, `getActionColor`
- The `"broker_deposit"` and `"institution"` entries in `ENTITY_LABELS`, `getEntityIcon`, `getEntityBadgeColor` (these were added as part of the audit completeness fix)

### 4b. Revert ConfirmButton → native confirm()

**Files**: `crypto-table.tsx`, `stock-table.tsx`, `cash-table.tsx`, `trade-table.tsx`

In each file:
1. Remove `import { ConfirmButton } from "@/components/ui/confirm-button"`
2. Add `if (!confirm("...")) return;` back to the delete handler functions
3. Replace `<ConfirmButton onConfirm={...}>` with plain `<button onClick={...}>`

**Example — crypto-table.tsx delete handler**:

```ts
// Restored original:
async function handleDelete(id: string, ticker: string) {
  if (!confirm(`Remove ${ticker} and all its positions?`)) return;
  try {
    await deleteCryptoAsset(id);
    toast.success(`${ticker} removed`);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Delete failed");
  }
}
```

**Example — crypto-table.tsx button JSX**:

```tsx
// Restored original:
<button
  onClick={() => handleDelete(asset.id, asset.ticker)}
  className="p-1 rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
  title="Remove asset"
>
  <Trash2 className="w-3.5 h-3.5" />
</button>
```

### 4c. Revert accounts-view.tsx button-in-button fix

**File**: `src/components/accounts/accounts-view.tsx`

Commit `fc02509` changed an outer `<button>` to `<div role="button">` to
avoid a hydration error caused by nesting `<ConfirmButton>` inside a
`<button>`. Since `ConfirmButton` is being removed and the plain
`<button onClick={...}>` replacement doesn't nest buttons, this change
can optionally be reverted (change `<div role="button">` back to `<button>`).

---

## 5. Type Changes

**File**: `src/lib/types.ts`

### 5a. Remove `deleted_at` from all interfaces

Remove `deleted_at?: string | null;` from these 11 interfaces:

- `Wallet`
- `Broker`
- `BankAccount`
- `Institution`
- `ExchangeDeposit`
- `BrokerDeposit`
- `CryptoAsset`
- `CryptoPosition`
- `StockAsset`
- `StockPosition`
- `TradeEntry`

### 5b. Revert ActionType

```ts
// Before:
export type ActionType = "created" | "updated" | "removed" | "undone";

// After:
export type ActionType = "created" | "updated" | "removed";
```

### 5c. Remove audit fields from ActivityLog

```ts
// REMOVE these 5 fields from the ActivityLog interface:
entity_id: string | null;
entity_table: string | null;
before_snapshot: Record<string, unknown> | null;
after_snapshot: Record<string, unknown> | null;
undone_at: string | null;
```

---

## 6. Deleted Files

These files were created as part of the soft-delete system and should be
deleted:

| File | Purpose |
|------|---------|
| `src/lib/actions/undo.ts` | The `undoActivity` server action |
| `src/components/ui/confirm-button.tsx` | Reusable two-click confirmation component |
| `supabase/migrations/024_soft_deletes_and_audit.sql` | Schema migration |
| `supabase/migrations/025_institutions_cascade_trigger.sql` | Schema migration |
| `supabase/migrations/026_add_undone_action_type.sql` | Enum migration |
| `supabase/migrations/027_backfill_undone_action.sql` | Data migration |

**Note**: The migration files should NOT be deleted from git history — they
document what was applied to the database. Instead, the revert migration
(Section 2) undoes their effects. You can delete them from the working tree
only after the revert migration has been applied.

---

## 7. Data Considerations

### Soft-deleted rows

Before dropping the `deleted_at` columns, decide on rows where
`deleted_at IS NOT NULL`:

- **Option A: Permanently delete them** (default in the rollback SQL)
  ```sql
  DELETE FROM <table> WHERE deleted_at IS NOT NULL;
  ```

- **Option B: Restore them first**
  ```sql
  UPDATE <table> SET deleted_at = NULL; -- restore all, then drop column
  ```

### Activity log data

The `before_snapshot`, `after_snapshot`, `entity_id`, `entity_table`, and
`undone_at` columns will be dropped. Any undo-related log entries will lose
their snapshot data. The rows themselves remain in the log table (with the
`action`, `entity_type`, `entity_name`, `description` columns intact).

Entries with `action = 'undone'` will either:
- Stay as-is if you leave the enum value (Option A in Section 2, Step 6)
- Be converted to `action = 'updated'` if you clean the enum (Option B)

### Cascade behavior

After reverting, PostgreSQL's built-in `ON DELETE CASCADE` (defined in the
original table schemas) will handle child-row deletion automatically. No
custom trigger is needed.

---

## 8. Verification Checklist

After applying the revert:

- [ ] `npx tsc --noEmit` — clean compile, no type errors
- [ ] `grep -rn 'deleted_at' src/` — returns zero results
- [ ] `grep -rn 'is("deleted_at"' src/` — returns zero results
- [ ] `grep -rn 'undoActivity' src/` — returns zero results
- [ ] `grep -rn 'ConfirmButton' src/` — returns zero results
- [ ] `grep -rn 'before_snapshot\|after_snapshot\|entity_table\|undone_at' src/lib/` — returns zero results
- [ ] Deleting a crypto asset → row is permanently gone from database
- [ ] Deleting a crypto asset with positions → positions cascade-deleted by FK
- [ ] Activity log entries still recorded (without snapshot data)
- [ ] History page shows logs but no undo buttons
- [ ] Delete buttons show native `confirm()` dialogs
- [ ] `clearAllData` / `deleteAccount` still work as before (unchanged)
- [ ] No orphaned rows in child tables after parent deletes
