# Cash Table Consolidation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate three cash tables (`bank_accounts`, `exchange_deposits`, `broker_deposits`) into a unified `cash_accounts` table with cross-institution uniqueness constraints.

**Architecture:** Single Supabase migration creates the new table, merges cross-table duplicates, migrates data preserving UUIDs, updates triggers, and deprecates old tables. Application code replaces 3 action files with 1 unified file, collapses 3-way branching throughout the codebase, and redesigns the transfer dialog to use an institution-grouped picker.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Supabase PostgreSQL, Vitest, React Testing Library

**Spec:** `docs/superpowers/specs/2026-03-17-cash-table-consolidation-design.md`

---

## Chunk 1: Foundation — Migration, Types, Core Action

### Task 1: Create the database migration

**Files:**
- Create: `supabase/migrations/005_cash_accounts_consolidation.sql`

- [ ] **Step 1: Write the migration file**

Copy the complete migration SQL from spec sections 3.1 through 3.7 into a single migration file. The migration contains these steps in order:

1. Backfill NULL `institution_id` on `bank_accounts` + verification assertion
2. Pre-flight safety checks (orphaned deposits, NULL wallet/broker institution_ids)
3. Merge cross-table deposit duplicates (exchange+broker at same inst+currency)
4. Create `cash_accounts` table with all constraints, indexes, triggers, RLS, grants
5. Migrate data from all 3 old tables (preserve UUIDs, explicit `::text` cast on currency enum)
6. `ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'cash_account'`
7. Replace `cascade_soft_delete()` function body — update all 6 UPDATE statements (3 delete + 3 restore) to reference `cash_accounts` with `wallet_id`, `broker_id`, `institution_id` WHERE clauses
8. Update `sync_institution_name()` — remove the `UPDATE bank_accounts SET bank_name` line
9. Rename old tables to `_deprecated`, revoke grants, drop old triggers

Key details for the `cascade_soft_delete` replacement:
- `WHEN 'wallets'` delete branch: `UPDATE cash_accounts SET deleted_at = NEW.deleted_at WHERE wallet_id = NEW.id AND deleted_at IS NULL;`
- `WHEN 'wallets'` restore branch: `UPDATE cash_accounts SET deleted_at = NULL WHERE wallet_id = NEW.id AND deleted_at = OLD.deleted_at;`
- Same pattern for `brokers` (using `broker_id`) and `institutions` (using `institution_id`)
- Keep ALL other cases unchanged (crypto_assets, stock_assets, crypto_positions, stock_positions, wallets under institutions, brokers under institutions)

Read the FULL current `cascade_soft_delete()` function body from `supabase/migrations/001_baseline.sql` lines 137-212 to ensure no cases are missed. The replacement must be a complete `CREATE OR REPLACE FUNCTION`.

Read the FULL current `sync_institution_name()` function body from `supabase/migrations/001_baseline.sql` lines 259-271. Keep the `wallets` and `brokers` UPDATE lines, remove only the `bank_accounts` line.

- [ ] **Step 2: Test migration against local Supabase**

```bash
supabase db reset
```

Expected: Migration applies cleanly. Verify with:

```bash
docker exec supabase_db_simple-portfolio-tracker psql -U postgres -d postgres -c "
  SELECT count(*) AS cash_accounts_count FROM cash_accounts;
  SELECT count(*) AS deprecated_bank FROM bank_accounts_deprecated;
"
```

Both queries should succeed. `cash_accounts_count` should match the sum of old table rows. `bank_accounts_deprecated` should be accessible only via service_role (grants revoked from anon/authenticated).

- [ ] **Step 3: Verify constraints**

Write constraint tests using real UUIDs from migrated data (FK constraints will reject fake UUIDs). If the local DB has no data, seed test data first (see the migration test approach used during the spec review — create a test user, institutions, wallets, brokers, then test INSERT/constraint behavior). The 6 constraints to verify:

1. Duplicate unnamed deposit at same institution+currency → blocked by `uq_cash_accounts_active`
2. Duplicate named account at same institution+currency+name → blocked by `uq_cash_accounts_active`
3. New differently-named account at same institution+currency → allowed
4. Both `wallet_id` AND `broker_id` set → blocked by `chk_cash_origin`
5. Empty string name → blocked by `chk_name_not_empty`
6. Bank-type (no wallet, no broker) without name → blocked by `chk_bank_requires_name`

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/005_cash_accounts_consolidation.sql
git commit -m "feat: add cash_accounts migration (consolidate 3 tables into 1)"
```

---

### Task 2: Update TypeScript types

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Add new types ALONGSIDE old ones (non-breaking)**

In `src/lib/types.ts`:

1. Add `CashAccount` interface and `CashAccountInput` (from spec section 4.3). Do NOT remove old interfaces yet.

2. Add `"cash_account"` to `EntityType` union (keep old 3 values)

3. **Do NOT modify `TransferSide` yet** — it will be changed atomically with `transfers.ts` in Task 10.

4. **Do NOT modify `HoldingItem.type` yet** — it will be changed atomically with `holdings.ts` in Task 6.

5. Mark old interfaces with `/** @deprecated Use CashAccount */` comments.

This commit is fully non-breaking. Every existing import and usage still compiles.

- [ ] **Step 2: Verify build passes**

```bash
npm run build
```

Expected: Build succeeds (no breaking changes).

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add CashAccount type and cash_account EntityType (non-breaking)"
```

---

### Task 3: Create unified cash-accounts server action

**Files:**
- Create: `src/lib/actions/cash-accounts.ts`

This is the core new file. It replaces `bank-accounts.ts`, `exchange-deposits.ts`, and `broker-deposits.ts`. Read all three existing files first to understand the full CRUD pattern, FX conversion, delta/cashflow computation, and activity logging.

- [ ] **Step 1: Read existing action files**

Read these files in full to understand the patterns:
- `src/lib/actions/bank-accounts.ts` — the most complete (has `name`, `bank_name`, `region`)
- `src/lib/actions/exchange-deposits.ts` — has custodial wallet validation
- `src/lib/actions/broker-deposits.ts` — simplest

Key patterns to preserve:
- All three call `toUsdAndEur()` for FX conversion
- All three compute `delta_usd`/`delta_eur` for adjustments, `cashflow_amount_usd`/`cashflow_amount_eur` for non-adjustments
- All three call `logActivity()` with `entity_type`, `entity_table`, `before_snapshot`, `after_snapshot`
- All three use `classifyAssetClass()` and `computeCashflowFromPrices()`

- [ ] **Step 2: Write `cash-accounts.ts`**

Create `src/lib/actions/cash-accounts.ts` with these exports:

```typescript
// Reads
export async function getCashAccounts(): Promise<CashAccount[]>
export async function findExistingCash(supabase, userId, institutionId, currency): Promise<CashAccount[]>

// Mutations
export async function createCashAccount(input: CashAccountInput, opts?): Promise<string>
export async function updateCashAccount(id: string, input: CashAccountInput, opts?): Promise<void>
export async function deleteCashAccount(id: string): Promise<void>
```

Key implementation notes:
- `getCashAccounts()`: Single query on `cash_accounts` with `deleted_at IS NULL`. Join to `institutions(name)`, `wallets(name)`, `brokers(name)` for display names. Flatten into `CashAccount` with `institution_name`, `wallet_name`, `broker_name` fields (add these to the interface if needed, or return them separately).
- `createCashAccount()`: Validate input, normalize empty `name` to `null`, insert, compute FX + delta/cashflow, log activity with `entity_type: "cash_account"`, `entity_table: "cash_accounts"`.
- `updateCashAccount()`: Fetch current state, compute delta, update, log activity.
- `deleteCashAccount()`: Soft-delete, compute delta, log activity.
- `findExistingCash()`: As specified in spec section 6.
- `opts` parameter carries: `isAdjustment`, `transferGroupId`, `effectiveDate` (same pattern as existing actions).

Derive origin from the CashAccount's FKs: `wallet_id ? "exchange" : broker_id ? "broker" : "bank"`.

For the activity log label:
- Bank origin: `"{balance} {currency} ({name}) at {institution_name}"`
- Exchange origin: `"{balance} {currency} on {wallet_name}"`
- Broker origin: `"{balance} {currency} on {broker_name}"`

- [ ] **Step 3: Verify the new file compiles**

```bash
npx tsc --noEmit src/lib/actions/cash-accounts.ts 2>&1 | head -20
```

Note: Full build won't pass yet (old action files still exist and are imported elsewhere). Just verify the new file has no internal errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/actions/cash-accounts.ts
git commit -m "feat: add unified cash-accounts server action with findExistingCash"
```

---

### Task 4: Update backward-compat helper functions

**Files:**
- Modify: `src/lib/deltas.ts`
- Modify: `src/lib/cashflow.ts`
- Modify: `src/lib/actions/activity-log.ts`
- Modify: `src/lib/actions/backfill.ts`

These are small, surgical changes — add `"cash_account"` to existing switch/if statements.

- [ ] **Step 1: Update `deltas.ts`**

1. Add `"cash_account"` to the `CashEntityType` union:
```typescript
export type CashEntityType = "bank_account" | "exchange_deposit" | "broker_deposit" | "cash_account";
```

2. Update `cashAmountField()`:
```typescript
export function cashAmountField(entityType: CashEntityType): "balance" | "amount" {
  if (entityType === "exchange_deposit" || entityType === "broker_deposit") return "amount";
  return "balance"; // bank_account and cash_account both use "balance"
}
```

- [ ] **Step 2: Update `cashflow.ts`**

In `classifyAssetClass()`, add `"cash_account"` to the cash branch:
```typescript
if (entityType === "bank_account" || entityType === "exchange_deposit"
    || entityType === "broker_deposit" || entityType === "cash_account") {
  return "cash";
}
```

- [ ] **Step 3: Update `activity-log.ts`**

In the `getAssetClass()` function (or equivalent entity-type-to-class mapping), add `"cash_account"` → `"cash"`.

- [ ] **Step 4: Update `backfill.ts`**

Add `"cash_account"` to `CASH_ENTITY_TYPES` array and any `.in("entity_type", [...])` queries.

- [ ] **Step 5: Verify changes compile**

```bash
npx tsc --noEmit src/lib/deltas.ts src/lib/cashflow.ts 2>&1 | head -10
```

Expected: No errors in these files.

- [ ] **Step 6: Commit**

```bash
git add src/lib/deltas.ts src/lib/cashflow.ts src/lib/actions/activity-log.ts src/lib/actions/backfill.ts
git commit -m "feat: add cash_account entity type to helper functions"
```

---

### Task 5: Update undo system backward compatibility

**Files:**
- Modify: `src/lib/actions/undo.ts`

This is the most critical backward-compat change. Read the full file first.

- [ ] **Step 1: Read `undo.ts` completely**

Understand:
- `ALLOWED_UNDO_TABLES` set (line ~35)
- `VALUE_FIELDS` map (line ~27)
- All 6 dynamic `.from()` call sites (5 × `log.entity_table` + 1 × `comp.entity_table` in `rollbackCompensation`)
- `computeCompensatingUpdate()` logic

- [ ] **Step 2: Add remapping constants**

At the top of the file, add:

```typescript
const TABLE_REMAP: Record<string, string> = {
  bank_accounts: "cash_accounts",
  exchange_deposits: "cash_accounts",
  broker_deposits: "cash_accounts",
};

const SNAPSHOT_FIELD_REMAP: Record<string, Record<string, string>> = {
  exchange_deposits: { amount: "balance" },
  broker_deposits: { amount: "balance" },
};
```

- [ ] **Step 3: Add remap helper functions**

```typescript
function resolveTable(entityTable: string): string {
  return TABLE_REMAP[entityTable] ?? entityTable;
}

function remapSnapshotFields(
  entityTable: string,
  snapshot: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!snapshot) return null;
  const remap = SNAPSHOT_FIELD_REMAP[entityTable];
  if (!remap) return snapshot;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    result[remap[key] ?? key] = value;
  }
  return result;
}
```

- [ ] **Step 4: Apply remapping in `undoSingleEntry`**

At the start of `undoSingleEntry`, before any logic:
1. Resolve the table: `const effectiveTable = resolveTable(log.entity_table);`
2. Remap snapshots: `const beforeSnapshot = remapSnapshotFields(log.entity_table, log.before_snapshot);`
3. Same for `after_snapshot`
4. Replace ALL `.from(log.entity_table)` with `.from(effectiveTable)`
5. Use `VALUE_FIELDS[effectiveTable]` instead of `VALUE_FIELDS[log.entity_table]`
6. When writing compensation entries, use `entity_table: effectiveTable` (not `log.entity_table`)

- [ ] **Step 5: Apply remapping in `rollbackCompensation`**

The `.from(comp.entity_table)` call must also use `resolveTable(comp.entity_table)`.

- [ ] **Step 6: Update VALUE_FIELDS and ALLOWED_UNDO_TABLES**

```typescript
// Add to VALUE_FIELDS:
cash_accounts: ["balance"],

// Add to ALLOWED_UNDO_TABLES:
"cash_accounts"
// Keep old names: "bank_accounts", "exchange_deposits", "broker_deposits"
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/actions/undo.ts
git commit -m "feat: add undo backward compat for cash table consolidation"
```

---

## Chunk 2: Portfolio Logic and Page Routes

### Task 6: Update portfolio assembly pipeline

**Files:**
- Modify: `src/lib/portfolio/assemble.ts`
- Modify: `src/lib/portfolio/aggregate.ts`
- Modify: `src/lib/portfolio/institution-grouping.ts`
- Modify: `src/lib/portfolio/dashboard-insights.ts`
- Modify: `src/lib/portfolio/holdings.ts`

All of these currently accept 3 separate cash arrays and process them in 3 separate loops. Collapse to 1 array and 1 loop each.

- [ ] **Step 1: Update `assemble.ts`**

1. Replace `PortfolioAssets` interface: remove `bankAccounts`, `exchangeDeposits`, `brokerDeposits` → add `cashAccounts: CashAccount[]`
2. Update `assemblePortfolioView()` to collect currencies from single `cashAccounts` array
3. Pass `cashAccounts` (single array) to `aggregatePortfolio()`, `computeDashboardInsights()`, `buildPaletteHoldings()`

- [ ] **Step 2: Update `aggregate.ts`**

1. Replace `AggregateParams`: remove 3 fields → add `cashAccounts: CashAccount[]`
2. Replace 3 cash loops with 1:
```typescript
for (const cash of cashAccounts) {
  const valueBase = convertToBase(cash.balance, cash.currency, primaryCurrency, fxRates);
  cashValue += valueBase;
  // ... same pattern for cashValueUsd, cashValueEur
}
```

- [ ] **Step 3: Update `institution-grouping.ts`**

1. Replace `GroupingInput`: remove 3 fields → add `cashAccounts: CashAccount[]`
2. Replace 3 cash loops with 1. Determine institution from `cash.institution_id` directly (no more wallet→institution or broker→institution indirection).
3. Update `CashRow.type` to use a single discriminant or derive origin from `wallet_id`/`broker_id` presence.

- [ ] **Step 4: Update `dashboard-insights.ts`**

1. Replace `InsightsParams`: remove 3 fields → add `cashAccounts: CashAccount[]`
2. Replace 3 cash loops (APY weighting, currency breakdown, exposure) with 1 each.

- [ ] **Step 5: Update `holdings.ts`**

1. Replace `BuildPaletteHoldingsInput`: remove 3 fields → add `cashAccounts: CashAccount[]`
2. Replace 3 map/spread blocks with 1:
```typescript
...cashAccounts.map((ca) => ({
  type: "cash" as const,
  id: ca.id,
  ticker: ca.currency,
  name: ca.name ?? `${ca.currency} Cash`,
  // ...
}))
```

- [ ] **Step 6: Update `HoldingItem.type` in `types.ts` (atomic with holdings.ts)**

Now that the sole consumer of `HoldingItem.type` for cash is updated, change the type union in `types.ts`:
Replace `"bank" | "exchange_deposit" | "broker_deposit"` with `"cash"` in `HoldingItem.type`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/portfolio/assemble.ts src/lib/portfolio/aggregate.ts \
  src/lib/portfolio/institution-grouping.ts src/lib/portfolio/dashboard-insights.ts \
  src/lib/portfolio/holdings.ts src/lib/types.ts
git commit -m "refactor: unify cash arrays in portfolio assembly pipeline"
```

---

### Task 7: Update dashboard and detail page routes

**Files:**
- Modify: `src/app/dashboard/page.tsx`
- Modify: `src/app/dashboard/cash/page.tsx`
- Modify: `src/app/dashboard/accounts/page.tsx`
- Modify: `src/app/api/holdings/route.ts`

All of these currently import and call `getBankAccounts`, `getExchangeDeposits`, `getBrokerDeposits` in parallel. Replace with single `getCashAccounts`.

- [ ] **Step 1: Update `dashboard/page.tsx`**

1. Replace imports: remove 3 old getters → import `getCashAccounts` from `@/lib/actions/cash-accounts`
2. Replace 3 parallel fetches with 1: `const cashAccounts = await getCashAccounts();`
3. Pass `cashAccounts` (single array) to `assemblePortfolioView()`

- [ ] **Step 2: Update `cash/page.tsx`**

Same pattern: replace 3 imports + fetches with 1.

- [ ] **Step 3: Update `accounts/page.tsx`**

Same pattern. Pass `cashAccounts` to `AccountsView` component.

- [ ] **Step 4: Update `api/holdings/route.ts`**

Same pattern. Pass `cashAccounts` to `buildPaletteHoldings()`.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/page.tsx src/app/dashboard/cash/page.tsx \
  src/app/dashboard/accounts/page.tsx src/app/api/holdings/route.ts
git commit -m "refactor: use getCashAccounts in dashboard pages and API route"
```

---

### Task 8: Update share page routes

**Files:**
- Modify: `src/lib/actions/shared-portfolio.ts`
- Modify: `src/app/share/[token]/page.tsx`
- Modify: `src/app/share/[token]/accounts/page.tsx`
- Modify: `src/app/share/[token]/cash/page.tsx`
- Modify: `src/app/share/[token]/crypto/page.tsx`
- Modify: `src/app/share/[token]/stocks/page.tsx`

- [ ] **Step 1: Update `shared-portfolio.ts`**

1. Update `SharedPortfolioData` interface: remove 3 fields → add `cashAccounts: CashAccount[]`
2. Replace 3 admin client queries with 1:
```typescript
const { data: cashAccounts } = await admin
  .from("cash_accounts")
  .select("*, institutions(name), wallets(name), brokers(name)")
  .eq("user_id", userId)
  .is("deleted_at", null);
```
3. Flatten the join results (institution_name, wallet_name, broker_name) into CashAccount shape.

- [ ] **Step 2: Update all 5 share page files**

Each file destructures from `SharedPortfolioData`. Replace `bankAccounts, exchangeDeposits, brokerDeposits` with `cashAccounts`.

For crypto and stocks pages that pass empty arrays: replace with `cashAccounts: []`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/actions/shared-portfolio.ts src/app/share/
git commit -m "refactor: use cashAccounts in shared portfolio pages"
```

---

### Task 9: Update comparison feature

**Files:**
- Modify: `src/lib/actions/comparison.ts`

- [ ] **Step 1: Update comparison.ts**

1. Replace 3 getter imports with `getCashAccounts`
2. Replace 3 parallel fetches with 1
3. Replace 3 currency collection loops with 1
4. Replace 3 cash holdings map loops with 1
5. Pass single `cashAccounts` to `aggregatePortfolio()`

- [ ] **Step 2: Commit**

```bash
git add src/lib/actions/comparison.ts
git commit -m "refactor: use getCashAccounts in comparison feature"
```

---

## Chunk 3: Transfer System

### Task 10: Refactor transfers.ts

**Files:**
- Modify: `src/lib/actions/transfers.ts`

This is the largest single-file refactor. Read the full file first (750+ lines).

- [ ] **Step 1: Read `transfers.ts` completely**

Understand all 7 functions that branch on cash type:
- `validateTransferSide()` — 5 cases, 3 are cash
- `fetchSourceState()` — 5 cases, 3 are cash
- `executeSourceLeg()` — 5 cases, 3 are cash
- `executeDestLeg()` — 5 cases, 3 are cash
- `rollbackSource()` — 5 cases, 3 are cash
- `validateSufficientBalance()` — 5 cases, 3 are cash
- `executeTransfer()` — `newCashDeposit` handling

- [ ] **Step 2: Update `TransferSide` in `types.ts` (atomic with transfers.ts)**

Now that we're refactoring the sole consumer, update `TransferSide` in `src/lib/types.ts`:
Replace 3 cash variants (`exchange_deposit`, `broker_deposit`, `bank_account`) with single `{ type: "cash_account"; accountId: string; amount: number }`.

- [ ] **Step 3: Update imports**

Replace imports of `createExchangeDeposit`, `updateExchangeDeposit`, `createBrokerDeposit`, `updateBrokerDeposit`, `updateBankAccount` with `createCashAccount`, `updateCashAccount`, `findExistingCash` from `@/lib/actions/cash-accounts`.

- [ ] **Step 4: Update `SourceOriginalState`**

This type is defined locally in `transfers.ts` (NOT in `types.ts`). Replace 3 cash variants with 1:
```typescript
| { type: "cash_account"; id: string; balance: number }
```

- [ ] **Step 5: Collapse all 7 functions**

For each function, replace 3 cash cases with 1 `"cash_account"` case. Key changes:

**`validateTransferSide`**: single `case "cash_account"` validates `accountId` and `amount`.

**`fetchSourceState`**: single query on `cash_accounts` by `id`:
```typescript
case "cash_account": {
  const { data, error } = await supabase
    .from("cash_accounts")
    .select("id, balance")
    .eq("id", source.accountId)
    .is("deleted_at", null)
    .single();
  if (error || !data) throw new Error("Source cash account not found");
  return { type: "cash_account", id: data.id, balance: Number(data.balance) };
}
```

**`executeSourceLeg`**: single `updateCashAccount` call with reduced balance.

**`executeDestLeg`**: single lookup by `id`, then `updateCashAccount` with increased balance. The `findExistingCash` routing happens in the transfer dialog (client-side) — the server just receives `accountId` and updates it.

**`rollbackSource`**: single `updateCashAccount` call restoring original balance.

**`validateSufficientBalance`**: single check `source.amount <= originalState.balance`.

- [ ] **Step 6: Update `newCashDeposit` handling**

Replace the broker_deposit/exchange_deposit branching with:
```typescript
if (input.newCashDeposit && currentSource) {
  if (currentSource.type === "cash_account") {
    const depositId = await createCashAccount({
      institution_id: /* resolved from destination */,
      currency: input.newCashDeposit.currency,
      balance: input.newCashDeposit.amount,
      // wallet_id/broker_id based on destination institution roles
    }, { isAdjustment: input.newCashDeposit.isAdjustment, effectiveDate: input.effectiveDate });
    createdEntities.push({ table: "cash_accounts", id: depositId });
  }
}
```

- [ ] **Step 7: Update `cleanupTransferEntities`**

Ensure it handles `table: "cash_accounts"` in addition to old table names (for safety during transition).

- [ ] **Step 8: Verify build**

```bash
npm run build 2>&1 | tail -20
```

At this point, most consumer files should be updated. Build errors will indicate remaining files that still reference old TransferSide variants.

- [ ] **Step 9: Commit**

```bash
git add src/lib/actions/transfers.ts src/lib/types.ts
git commit -m "refactor: collapse transfer system to unified cash_account type"
```

---

## Chunk 4: UI Components

### Task 11: Create unified cash-account-modal

**Files:**
- Create: `src/components/cash/cash-account-modal.tsx`
- Delete: `src/components/cash/bank-account-modal.tsx`
- Delete: `src/components/cash/exchange-deposit-modal.tsx`
- Delete: `src/components/cash/broker-deposit-modal.tsx`

- [ ] **Step 1: Read existing 3 modals**

Read all three to understand the shared patterns and differences:
- `bank-account-modal.tsx` — has `name`, `bank_name`, `region` fields
- `exchange-deposit-modal.tsx` — has wallet selector, custodial-only validation
- `broker-deposit-modal.tsx` — has broker selector

- [ ] **Step 2: Create `cash-account-modal.tsx`**

Unified modal that adapts based on context:
- Always shows: currency, amount/balance, APY
- If institution has bank role AND (no wallet_id, no broker_id on existing record): show `name` field
- If editing existing: pre-fill from `CashAccount`
- If creating new: determine `wallet_id`/`broker_id` based on institution roles

Props:
```typescript
interface CashAccountModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  institutionId: string;
  institutionName: string;
  editing?: CashAccount;
  walletId?: string;   // pre-set for exchange-origin
  brokerId?: string;   // pre-set for broker-origin
}
```

**Do NOT delete old modals yet** — they are still imported by `cash-table.tsx` (Task 12) and `accounts-view.tsx` (Task 13). Old modals will be deleted in Task 20 alongside the old action files.

- [ ] **Step 3: Commit**

```bash
git add src/components/cash/cash-account-modal.tsx
git commit -m "feat: add unified cash-account-modal"
```

---

### Task 12: Update cash-table and cash-columns

**Files:**
- Modify: `src/components/cash/cash-table.tsx`
- Modify: `src/components/cash/cash-columns.tsx`

- [ ] **Step 1: Rewrite `cash-columns.tsx`**

Replace 3 group types (`BankGroup`, `ExchangeGroup`, `BrokerGroup`) with 1 `CashAccountGroup`. Replace 3 builder functions with 1 `buildCashGroupRows()`. The `CashRow` discriminated union collapses to a single variant.

- [ ] **Step 2: Update `cash-table.tsx`**

1. Replace 3 cash array props with single `cashAccounts: CashAccount[]`
2. Replace 3 delete function imports with `deleteCashAccount`
3. Replace 3 modal components with `CashAccountModal`
4. Remove exchange/broker sections — render single list grouped by institution
5. Update the "empty state" message

- [ ] **Step 3: Commit**

```bash
git add src/components/cash/cash-table.tsx src/components/cash/cash-columns.tsx
git commit -m "refactor: unified cash-table with single CashAccount type"
```

---

### Task 13: Update accounts-view and add-institution-modal

**Files:**
- Modify: `src/components/accounts/accounts-view.tsx`
- Modify: `src/components/accounts/add-institution-modal.tsx`

- [ ] **Step 1: Update `accounts-view.tsx`**

1. Replace 3 modal imports with `CashAccountModal`
2. Replace "Add Exchange Deposit" / "Add Broker Deposit" / "Add Bank Account" buttons with single "Add Cash" button
3. The `AddAssetDropdown` logic simplifies: one "Add Cash" option instead of conditional exchange/broker/bank buttons
4. Accept `cashAccounts: CashAccount[]` instead of 3 separate arrays

- [ ] **Step 2: Add invalid state detection + merge banner**

Add logic to detect legacy duplicate cash at same institution+currency (bank_account + deposit with different origin). On accounts page load, scan `cashAccounts` for entries that share `institution_id + currency` but have `name=NULL` (deposit) alongside named accounts. Show a banner:

```
"Trade Republic has duplicate EUR cash entries." [Merge]
```

Merge action: call a new server action `mergeCashAccounts(survivorId, duplicateId)` that sums balances into the survivor, soft-deletes the duplicate, and logs both changes as adjustments. Add this server action to `cash-accounts.ts`.

Survivor priority: prefer the bank-origin account (has name) > exchange > broker.

- [ ] **Step 3: Update `add-institution-modal.tsx`**

Replace `createBankAccount` import with `createCashAccount`. The `also_bank` auto-create should call `findExistingCash()` first — if cash already exists at institution+currency, skip creation.

- [ ] **Step 4: Commit**

```bash
git add src/components/accounts/accounts-view.tsx src/components/accounts/add-institution-modal.tsx \
  src/lib/actions/cash-accounts.ts
git commit -m "feat: unified Add Cash button + merge banner for legacy duplicates"
```

---

### Task 14: Update transfer-dialog

**Files:**
- Modify: `src/components/ui/transfer-dialog.tsx`

This is a significant UI redesign. Read the full file first (~750 lines).

- [ ] **Step 1: Read `transfer-dialog.tsx` completely**

Understand:
- `DEST_TABS` — 3 cash type tabs to remove
- `destType` state — to remove
- `destLocationOptions` — separate broker/wallet/bank lists to unify
- `buildSource()` / `buildDest()` — type-prefixed ID parsing
- `autoCalcValue` — cash→cash mirroring
- Buy mode cash auto-detection

- [ ] **Step 2: Replace data fetching imports**

The transfer dialog is a client component that fetches cash data on mount. Replace:
```typescript
// Remove these 3 imports and their parallel fetches on dialog open:
import { getBankAccounts } from "@/lib/actions/bank-accounts";
import { getExchangeDeposits } from "@/lib/actions/exchange-deposits";
import { getBrokerDeposits } from "@/lib/actions/broker-deposits";
// Replace with:
import { getCashAccounts } from "@/lib/actions/cash-accounts";
```

Update the `useEffect` that fetches on `open` to call `getCashAccounts()` once instead of 3 parallel calls.

- [ ] **Step 3: Replace destination type tabs with institution-grouped picker**

1. Remove `DestType`, `DEST_TABS`, `destType` state
2. Replace `destLocationOptions` with a unified list built from `cashAccounts` + institutions:
```typescript
const cashDestOptions = useMemo(() => {
  // Group existing cash by institution
  // Add "(new)" entries for institutions with roles but no cash in destCurrency
  // Exclude self-custody wallets
}, [cashAccounts, institutions, destCurrency]);
```
3. The picker renders institution headers with selectable cash account rows beneath

- [ ] **Step 4: Update `buildDest()`**

Replace 3 cash cases with single `{ type: "cash_account", accountId, amount }`.

- [ ] **Step 5: Update `srcGroupedOptions` memo (source picker)**

Replace the 3 cash loops (lines ~408-441) that iterate `bankAccounts`/`exchangeDeposits`/`brokerDeposits` with a single loop over `cashAccounts`. Replace `bank|{id}`, `exchange|{walletId}|{currency}`, `broker|{brokerId}|{currency}` ID prefixes with `cash|{id}`. The `name` field and `available` amount come from the unified `CashAccount`.

- [ ] **Step 6: Update `srcIsCash` and `buildSource()` for generic picker**

Replace `srcIsCash` (line ~455):
```typescript
// Old: srcLocationId.startsWith("bank|") || srcLocationId.startsWith("exchange|") || srcLocationId.startsWith("broker|")
// New:
const srcIsCash = srcLocationId.startsWith("cash|");
```

In `buildSource()`: replace `bank`, `exchange`, `broker` prefix cases with single `cash` case that returns `{ type: "cash_account", accountId, amount }`.

- [ ] **Step 7: Update `autoCalcValue` memo**

Replace the `destType`-based cash checks (lines ~460, ~473) with whatever replaces `destType` for cash destination detection. E.g., if destination is selected from the cash picker, use a `destIsCash` boolean derived from the selection.

- [ ] **Step 8: Add same-account detection**

Before submit, check if source and destination resolve to the same `cash_accounts` ID. If so, show inline error and disable submit.

- [ ] **Step 9: Update buy mode cash auto-detection**

Replace separate broker_deposit/exchange_deposit lookup with `findExistingCash()` — or query `cashAccounts` locally. Update `handleExecute()` buy mode source construction: replace 2 `TransferSide` variants (broker_deposit/exchange_deposit) with single `{ type: "cash_account", accountId, amount }`.

Also collapse 3 state variables (`bankAccounts`, `exchangeDeposits`, `brokerDeposits`) into single `cashAccounts` state. Remove old type imports (`BankAccount`, `ExchangeDeposit`, `BrokerDeposit`).

- [ ] **Step 10: Commit**

```bash
git add src/components/ui/transfer-dialog.tsx
git commit -m "feat: institution-grouped cash picker in transfer dialog"
```

---

### Task 15: Update activity-timeline and import-export-settings

**Files:**
- Modify: `src/components/history/activity-timeline.tsx`
- Modify: `src/components/settings/import-export-settings.tsx`

- [ ] **Step 1: Update `activity-timeline.tsx`**

1. Add `cash_account: "Cash"` to `ENTITY_LABELS`
2. Update `ENTITY_FILTER_OPTIONS`: add `{ value: "cash_account", label: "Cash" }`, remove old 3 entries
3. Add `"cash_account"` to `CASH_FLOW_ENTITIES` array
4. Add icon/color case for `"cash_account"` in the switch statement

- [ ] **Step 2: Update `import-export-settings.tsx`**

Replace "Fiat Deposits (Exchanges)" + "Fiat Deposits (Brokers)" count rows with single "Cash Accounts" row.

- [ ] **Step 3: Commit**

```bash
git add src/components/history/activity-timeline.tsx src/components/settings/import-export-settings.tsx
git commit -m "refactor: update timeline labels and settings for cash_account type"
```

---

## Chunk 5: Import/Export, Edge Function, Tests, Cleanup

### Task 16: Update import system

**Files:**
- Modify: `src/lib/actions/import.ts`

- [ ] **Step 1: Add version-conditional validation**

In `validateBackup()`:
- If `version <= 2`: require `bankAccounts`, `exchangeDeposits`, `brokerDeposits` arrays
- If `version >= 3`: require `cashAccounts` array

- [ ] **Step 2: Add v1/v2 normalization**

After validation, if `version <= 2`, normalize:
```typescript
data.cashAccounts = [
  ...(data.bankAccounts ?? []).map(ba => ({ ...ba, wallet_id: null, broker_id: null })),
  ...(data.exchangeDeposits ?? []).map(ed => ({ ...ed, balance: ed.amount, broker_id: null })),
  ...(data.brokerDeposits ?? []).map(bd => ({ ...bd, balance: bd.amount, wallet_id: null })),
];
```

- [ ] **Step 3: Replace 3 import blocks with 1**

Collapse the 3 separate cash import sections (bank, exchange, broker) into a single `cashAccounts` import loop using `createCashAccount` or direct insert.

- [ ] **Step 4: Replace-mode clearing**

Update the hard-delete section: replace `exchange_deposits`, `broker_deposits`, `bank_accounts` with `cash_accounts`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/import.ts
git commit -m "feat: v3 import format with backward-compat v1/v2 normalization"
```

---

### Task 17: Update export system

**Files:**
- Modify: `src/lib/actions/export.ts`

- [ ] **Step 1: Update `PortfolioBackup` interface**

Add `cashAccounts: CashAccount[]`. Bump version to `3`. Keep legacy fields for one version cycle.

- [ ] **Step 2: Update `exportFullJson()`**

1. Replace 3 getter calls with `getCashAccounts()`
2. Populate `cashAccounts` in the return object
3. Also populate legacy `bankAccounts`, `exchangeDeposits`, `brokerDeposits` by filtering by origin

- [ ] **Step 3: Update `exportCashCsv()`**

Replace 3 getter calls + 3 loops with 1 getter + 1 loop. Use origin derivation for the "Type" column.

- [ ] **Step 4: Commit**

```bash
git add src/lib/actions/export.ts
git commit -m "feat: v3 export format with legacy backward compat arrays"
```

---

### Task 18: Update edge function

**Files:**
- Modify: `supabase/functions/daily-snapshot/index.ts`

- [ ] **Step 1: Replace 3 queries with 1**

Replace:
```typescript
supabase.from("bank_accounts").select("user_id, currency, balance")
supabase.from("exchange_deposits").select("user_id, currency, amount")
supabase.from("broker_deposits").select("user_id, currency, amount")
```

With:
```typescript
supabase.from("cash_accounts").select("user_id, currency, balance").is("deleted_at", null)
```

- [ ] **Step 2: Replace 3 aggregation loops with 1**

Replace separate `bank.balance` / `dep.amount` field access with unified `item.balance`.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/daily-snapshot/index.ts
git commit -m "refactor: edge function uses cash_accounts table"
```

---

### Task 19: Update institutions.ts, wallets.ts, brokers.ts, trades.ts

**Files:**
- Modify: `src/lib/actions/institutions.ts`
- Modify: `src/lib/actions/wallets.ts`
- Modify: `src/lib/actions/brokers.ts`
- Modify: `src/lib/actions/trades.ts`

Read ALL four files first. They all have references to old cash tables.

- [ ] **Step 1: Update `institutions.ts`**

This file has ~5 `.from("bank_accounts")` call sites. Update ALL of them:

1. Role detection query (line ~21): `.from("bank_accounts")` → `.from("cash_accounts")`
2. `also_bank` auto-create: add `findExistingCash()` check — skip if cash already exists at institution+currency
3. `removeRole()` bank case: **migrate cash, not delete.** If remaining roles exist, update the cash_account to reassign `wallet_id`/`broker_id` based on surviving role. If no remaining roles, block with error. Show confirmation: "Removing wallet role will move your EUR deposit to your bank account. Continue?"
4. `removeRole()` when cash = 0: auto-delete zero-balance record, then proceed with role removal
5. `deleteInstitution()`: replace `bank_accounts` queries → `cash_accounts`
6. Region propagation: replace `.from("bank_accounts")` → `.from("cash_accounts")`
7. Update all `entity_table: "bank_accounts"` / `entity_type: "bank_account"` in activity logging → `"cash_accounts"` / `"cash_account"`

- [ ] **Step 2: Update `wallets.ts`**

Read the full file. It has 6 references across 4 functions:

**`deleteWallet()` (lines ~325-335):**
1. Dynamic import `await import("@/lib/actions/exchange-deposits")` → `await import("@/lib/actions/cash-accounts")` (keep as dynamic import to avoid circular deps)
2. `.from("exchange_deposits").select("id").eq("wallet_id", id)` → `.from("cash_accounts").select("id").eq("wallet_id", id)` (use `.eq("wallet_id", id)` for precision — NOT `.not("wallet_id", "is", null)` which would match ALL exchange-origin cash)
3. `deleteExchangeDeposit(dep.id)` → `deleteCashAccount(dep.id)`

**`createWallet()` also_bank (lines ~96-113):**
4. Duplicate check: `.from("bank_accounts").select("id").eq("institution_id", institutionId)` → replace with `findExistingCash(supabase, user.id, institutionId, "EUR")` — if non-empty, skip creation
5. INSERT: `.from("bank_accounts").insert({ name, bank_name, region, currency, balance, apy, institution_id })` → `createCashAccount({ institution_id, name, currency: "EUR", balance: 0 })` — drop `bank_name` and `region` fields (not in new schema)
6. Activity logging: update `entity_table`/`entity_type` from `"bank_accounts"`/`"bank_account"` → `"cash_accounts"`/`"cash_account"`

**`updateWallet()` also_bank (lines ~248-265):**
Same as createWallet — duplicate check + INSERT + activity logging. Same changes.

- [ ] **Step 3: Update `brokers.ts`**

Same pattern as wallets.ts, with 6 references:

**`deleteBroker()` (lines ~297-307):**
1. Dynamic import `await import("@/lib/actions/broker-deposits")` → `await import("@/lib/actions/cash-accounts")`
2. `.from("broker_deposits").select("id").eq("broker_id", id)` → `.from("cash_accounts").select("id").eq("broker_id", id)`
3. `deleteBrokerDeposit(dep.id)` → `deleteCashAccount(dep.id)`

**`createBroker()` also_bank (lines ~98-115):**
4. Duplicate check → `findExistingCash()`
5. INSERT → `createCashAccount()` (drop `bank_name`, `region`)
6. Activity logging → `"cash_accounts"`/`"cash_account"`

**`updateBroker()` also_bank (lines ~222-239):**
Same as createBroker.

- [ ] **Step 4: Update `trades.ts`**

Line ~29: `.from("bank_accounts").select("currency")` → `.from("cash_accounts").select("currency")`. This query builds the currency list for trade entry forms. Column name `currency` exists on both tables, so no field rename needed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/institutions.ts src/lib/actions/wallets.ts \
  src/lib/actions/brokers.ts src/lib/actions/trades.ts
git commit -m "refactor: institutions/wallets/brokers/trades use cash_accounts"
```

---

### Task 20: Delete old action files and modals

**Files:**
- Delete: `src/lib/actions/bank-accounts.ts`
- Delete: `src/lib/actions/exchange-deposits.ts`
- Delete: `src/lib/actions/broker-deposits.ts`
- Delete: `src/components/cash/bank-account-modal.tsx`
- Delete: `src/components/cash/exchange-deposit-modal.tsx`
- Delete: `src/components/cash/broker-deposit-modal.tsx`

- [ ] **Step 1: Verify no remaining imports**

```bash
grep -r "bank-accounts\|exchange-deposits\|broker-deposits\|bank-account-modal\|exchange-deposit-modal\|broker-deposit-modal" src/ --include="*.ts" --include="*.tsx" | grep -v "__tests__" | grep -v "node_modules"
```

Expected: Zero results (all imports have been updated in previous tasks).

- [ ] **Step 2: Delete old files**

```bash
git rm src/lib/actions/bank-accounts.ts
git rm src/lib/actions/exchange-deposits.ts
git rm src/lib/actions/broker-deposits.ts
git rm src/components/cash/bank-account-modal.tsx
git rm src/components/cash/exchange-deposit-modal.tsx
git rm src/components/cash/broker-deposit-modal.tsx
```

- [ ] **Step 3: Full build verification**

```bash
npm run build
```

Expected: Build succeeds with zero errors.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: delete old cash action files and modals (6 files)"
```

---

### Task 21: Update existing tests

**Files:**
- Modify: `__tests__/unit/institution-grouping.test.ts`
- Modify: `__tests__/unit/holdings.test.ts`
- Modify: `__tests__/unit/activity-log.test.ts`
- Modify: `__tests__/unit/cashflow.test.ts`
- Modify: `__tests__/integration/migration-bootstrap.test.ts`
- Modify: `__tests__/integration/cascade-delete.test.ts`
- Modify: `__tests__/integration/cashflow-write.test.ts`
- Modify: `__tests__/integration/transfer-rollback.test.ts`

- [ ] **Step 1: Rewrite `institution-grouping.test.ts`**

Replace `makeBankAccount()`, `makeExchangeDeposit()`, `makeBrokerDeposit()` factories with `makeCashAccount()`. Update all `type` string assertions. Update `makeInput()` to use single `cashAccounts` field.

- [ ] **Step 2: Update `holdings.test.ts`**

Replace `BankAccount` imports and inline objects with `CashAccount`. Update `buildPaletteHoldings()` call sites to pass `cashAccounts`.

- [ ] **Step 3: Update `activity-log.test.ts`**

Update or collapse `cashAmountField` tests. Add `"cash_account" → "balance"` test case.

- [ ] **Step 4: Update `cashflow.test.ts`**

Update or collapse `classifyAssetClass` tests. Add `"cash_account" → "cash"` test case.

- [ ] **Step 5: Update integration tests**

- `migration-bootstrap.test.ts`: Replace 3 old table names with `cash_accounts` in expected-tables
- `cascade-delete.test.ts`: Rewrite 3 cascade test cases to use `cash_accounts` table
- `cashflow-write.test.ts`: Change `entity_type` string
- `transfer-rollback.test.ts`: Change `entity_type` strings

- [ ] **Step 6: Add new unit tests for undo remap functions**

Create or add to a test file for the `resolveTable()` and `remapSnapshotFields()` helper functions added in Task 5:

```typescript
// Test resolveTable
expect(resolveTable("exchange_deposits")).toBe("cash_accounts");
expect(resolveTable("broker_deposits")).toBe("cash_accounts");
expect(resolveTable("bank_accounts")).toBe("cash_accounts");
expect(resolveTable("cash_accounts")).toBe("cash_accounts");
expect(resolveTable("crypto_positions")).toBe("crypto_positions"); // passthrough

// Test remapSnapshotFields
expect(remapSnapshotFields("exchange_deposits", { amount: 500, currency: "EUR" }))
  .toEqual({ balance: 500, currency: "EUR" });
expect(remapSnapshotFields("bank_accounts", { balance: 500 }))
  .toEqual({ balance: 500 }); // no remap needed
expect(remapSnapshotFields("crypto_positions", { quantity: 1.5 }))
  .toEqual({ quantity: 1.5 }); // no remap
```

Note: These functions must be exported from `undo.ts` (or extracted into a testable utility) for unit testing.

- [ ] **Step 7: Add new unit tests for findExistingCash**

Test `findExistingCash()` with mocked Supabase client returning 0, 1, and N results. This is a server action test using the `vi.hoisted` + `vi.mock` pattern described in the project's testing memory.

- [ ] **Step 8: Run full test suite**

```bash
supabase db reset && npm run test:all
```

Expected: All tests pass. Note: `supabase db reset` needed to ensure integration tests run against the new schema with migration 005 applied.

- [ ] **Step 9: Commit**

```bash
git add __tests__/
git commit -m "test: update 8 existing + add new undo remap and findExistingCash tests"
```

---

### Task 22: Run lint, build, and full verification

- [ ] **Step 1: Lint**

```bash
npm run lint
```

Expected: 0 errors, 0 warnings.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Full test suite**

```bash
npm run test:all
```

Expected: All tests pass (unit + component + integration).

- [ ] **Step 4: Local Supabase reset + migration**

```bash
supabase db reset
```

Expected: All migrations apply cleanly including the new 005.

- [ ] **Step 5: Manual smoke test**

Start dev server, verify dashboard loads, cash page renders, create/edit/delete a cash account, perform a transfer.

```bash
npm run dev
```

- [ ] **Step 6: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address issues found during verification"
```
