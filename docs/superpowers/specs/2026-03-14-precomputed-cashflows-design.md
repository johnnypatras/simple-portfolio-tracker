# Pre-Computed Cashflows & Delta Status Tracking

## Problem

`deriveCashFlows()` in `benchmark.ts` makes ~13 HTTP calls per page load (CoinGecko, Yahoo Finance, Frankfurter) to compute S&P 500 benchmark cash flow values from activity log snapshots. With warm cache this is fast, but cold cache takes 3-6s and risks Vercel's 10s function timeout. The function is called on 8 pages (4 dashboard + 4 share pages).

Separately, delta computation (`delta_usd`/`delta_eur`) silently writes NULL on FX API failure across 12 catch blocks in 4 files, with no user visibility and no retry mechanism.

## Solution

Pre-compute cashflow values at write time and store them on `activity_log`. Replace the 388-line `deriveCashFlows()` with a single DB query (~15 lines, ~2ms). Add status tracking to both cashflows and deltas so failures are visible and retryable.

## Architectural Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Migration strategy | Full cutover with backfill | Backfill all existing rows, then switch to DB-only mode. No dual-path logic. |
| Write-time price source | Client passes prices | Components already fetch prices for display. Thread them to server actions. Zero API calls at write time. |
| Delta status | Add now, same migration | Unified pattern for both cashflow and delta tracking. |
| Stablecoin classification | Stored as `'cash'` at write time | Matches snapshot aggregation logic (stablecoins count as cash). |

---

## 1. Database Schema

### New columns on `activity_log`

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `cashflow_amount_usd` | `NUMERIC(18,2)` | `NULL` | Pre-computed S&P benchmark cashflow in USD |
| `cashflow_amount_eur` | `NUMERIC(18,2)` | `NULL` | Pre-computed S&P benchmark cashflow in EUR |
| `cashflow_asset_class` | `TEXT` | `NULL` | `'crypto'` / `'stocks'` / `'cash'` (needed by per-class chart view) |
| `cashflow_status` | `TEXT` | `NULL` | `NULL` (n/a) / `'complete'` / `'pending'` / `'failed'` |
| `delta_status` | `TEXT` | `NULL` | `NULL` (n/a) / `'complete'` / `'pending'` / `'failed'` |
| `cashflow_attempted_at` | `TIMESTAMPTZ` | `NULL` | Last backfill attempt timestamp (for retry throttling) |
| `delta_attempted_at` | `TIMESTAMPTZ` | `NULL` | Last backfill attempt timestamp for deltas |

### Status semantics

- **`NULL`** — Row does not need this value. Examples: transfers and adjustments have no cashflow (they are internal movements/corrections, not real money flows). Metadata-only changes (crypto_asset, stock_asset, wallet, broker) have no cashflow or delta.
- **`'complete'`** — Value computed and stored successfully.
- **`'pending'`** — Computation attempted but failed (e.g., FX API down). Eligible for backfill retry.
- **`'failed'`** — Exhausted retries + snapshot estimation fallback. Stores best-effort value ($0 if no snapshot data available).

### New indexes

```sql
CREATE INDEX idx_activity_log_pending_cashflows
  ON activity_log (user_id) WHERE cashflow_status = 'pending';
CREATE INDEX idx_activity_log_pending_deltas
  ON activity_log (user_id) WHERE delta_status = 'pending';
```

### Migration

Single new migration file (`002_cashflow_columns.sql`). Additive columns + indexes + one data fixup:

```sql
-- Set delta_status = 'pending' for legacy adjustment rows that have NULL deltas
-- (FX failures before status tracking existed). Without this, backfill won't find them.
UPDATE activity_log
SET delta_status = 'pending'
WHERE is_adjustment = true
  AND delta_usd IS NULL
  AND delta_status IS NULL
  AND undone_at IS NULL
  AND entity_type IN ('crypto_position','stock_position','exchange_deposit','broker_deposit','bank_account');
```

Note: `cashflow_status` NULL is intentionally overloaded for legacy rows. The backfill query disambiguates by also filtering on `is_adjustment = false` and `entity_type IN [...]`. If a new entity type is added that produces cashflows, its legacy rows must be added to the backfill query's entity_type list.

---

## 2. Write-Time Computation

### What is a cashflow?

The USD/EUR value of real money entering or leaving the portfolio on a given date. Used to simulate "what if you had put that same money into S&P 500 instead?"

| Action | Cashflow | Delta | Rationale |
|--------|----------|-------|-----------|
| Add crypto position (0.5 BTC) | +$50,000 (money entered portfolio) | NULL (not adjustment) | Real purchase — S&P benchmark replays this |
| Remove crypto position | -$50,000 (money left portfolio) | NULL (not adjustment) | Real sale |
| Adjust crypto qty (correction) | NULL (not real money flow) | +$50,000 (portfolio value changed) | Correction — S&P unaffected |
| Add bank account (€1,000) | +€1,000 → USD | NULL (not adjustment) | Real deposit |
| Transfer (sell BTC → buy ETH) | NULL (internal movement) | NULL (adjustment pair) | Both legs are adjustments |

### Key insight: delta vs cashflow are complementary

Delta is computed only when `isAdjustment = true` — it tracks the value impact of portfolio corrections.
Cashflow is computed only when `isAdjustment = false` AND the entity type produces cash flows — it tracks real money movements.

They are never both non-NULL on the same row. When `toggleActivityAdjustment()` flips a row's `is_adjustment` flag, the row's cashflow/delta values must be swapped (see Section 2a).

### Computation flow — zero API calls at write time

**Crypto mutations** (`src/lib/actions/crypto.ts`):
- `position-editor.tsx` already passes `currentPriceUsd` and `currentPriceEur` to `upsertPosition()` and `deletePosition()`.
- Currently these are only used when `isAdjustment = true` (for delta). Extend to also compute cashflow when `isAdjustment = false`:
  - Compute `qtyDelta` using `positionQtyDelta(action, beforeQty, afterQty)` from `src/lib/deltas.ts` (handles sign by action type: created → +afterQty, removed → -beforeQty, updated → afterQty - beforeQty)
  - `cashflow_amount_usd = qtyDelta * currentPriceUsd`
  - `cashflow_amount_eur = qtyDelta * currentPriceEur`
  - `cashflow_asset_class = 'crypto'` (or `'cash'` if stablecoin — check `subcategory` on the crypto_asset)
  - `cashflow_status = 'complete'`

**Stock mutations** (`src/lib/actions/stocks.ts`):
- `stock-position-editor.tsx` already passes `currentPriceNative` and `assetCurrency` to `upsertStockPosition()` and `deleteStockPosition()`.
- Currently used only when `isAdjustment = true`. Extend:
  - Compute `deltaNative = qtyDelta * currentPriceNative`
  - Convert to USD/EUR using FX rate (the same `toUsdAndEur()` call already used for delta)
  - `cashflow_asset_class = 'stocks'`
  - `cashflow_status = 'complete'`, or `'pending'` if FX conversion fails
- Stocks have try/catch around `toUsdAndEur()` (3 catch blocks). These will now also set `delta_status` or `cashflow_status` to `'pending'` instead of silently writing NULL.

**Cash mutations** (`broker-deposits.ts`, `exchange-deposits.ts`, `bank-accounts.ts`):
- Cash modals need a small extension: pass the current EUR/USD FX rate from the page (it's already displayed to the user).
- New `fxRate` prop threaded: modal component → server action opts.
- **FX rate convention**: `fxRate` is EUR/USD (e.g., 1.08 means 1 EUR = 1.08 USD). This matches the page display.
- Server action computes:
  - EUR entity: `cashflow_amount_eur = delta_amount`, `cashflow_amount_usd = delta_amount * fxRate`
  - USD entity: `cashflow_amount_usd = delta_amount`, `cashflow_amount_eur = delta_amount / fxRate`
  - `cashflow_asset_class = 'cash'`
  - `cashflow_status = 'complete'`
- Same FX rate used for delta computation (when `isAdjustment = true`), eliminating the FX API call in the non-adjustment path.
- Fallback: if `fxRate` not provided (shouldn't happen, but defense-in-depth), fall back to `toUsdAndEur()` API call and mark as `'pending'` on failure.

**Transfers, adjustments, metadata changes** — `cashflow_status = NULL` (not applicable).

### 2a. `toggleActivityAdjustment()` — cashflow/delta swap

`toggleActivityAdjustment()` in `activity-log.ts` flips a row's `is_adjustment` flag after the fact. When this happens, the row's cashflow and delta values must be swapped:

**Toggling ON (becomes adjustment):**
- Compute delta via `computeDeltaFromSnapshots()` (existing logic, unchanged)
- Clear cashflow: `cashflow_amount_usd = NULL`, `cashflow_amount_eur = NULL`, `cashflow_asset_class = NULL`
- Set `cashflow_status = NULL` (no longer applicable)
- Set `delta_status = 'complete'` (or `'pending'` if computation fails)

**Toggling OFF (becomes non-adjustment):**
- Clear delta: `delta_usd = NULL`, `delta_eur = NULL`
- Set `delta_status = NULL` (no longer applicable)
- Compute cashflow via `computeDeltaFromSnapshots()` (same math — the cashflow value IS the value delta for the position/cash change)
- Determine asset class from `entity_type` (with stablecoin check for crypto_positions)
- Set `cashflow_status = 'complete'` (or `'pending'` if computation fails)

**Implementation:** Extend the existing `toggleActivityAdjustment()` function to update all 7 new columns alongside the existing `is_adjustment`, `delta_usd`, `delta_eur` update.

### Entity types that produce cashflows

Only entity types representing actual holdings produce cashflows (matching current `deriveCashFlows()` filters):
- `crypto_position` (→ `'crypto'` or `'cash'` if stablecoin)
- `stock_position` (→ `'stocks'`)
- `exchange_deposit` (→ `'cash'`)
- `broker_deposit` (→ `'cash'`)
- `bank_account` (→ `'cash'`)

Entity types that do NOT produce cashflows: `crypto_asset`, `stock_asset`, `wallet`, `broker`.

### `logActivity()` signature extension

```typescript
export async function logActivity(params: {
  // ... existing fields unchanged ...
  delta_usd?: number | null;
  delta_eur?: number | null;
  // New fields:
  cashflow_amount_usd?: number | null;
  cashflow_amount_eur?: number | null;
  cashflow_asset_class?: AssetClass | null;  // 'crypto' | 'stocks' | 'cash' (imported from benchmark.ts)
  cashflow_status?: 'complete' | 'pending' | null;
  delta_status?: 'complete' | 'pending' | null;
}): Promise<void>
```

All new fields are optional — existing callers continue to work unchanged. `logActivity()` remains fire-and-forget (never throws).

---

## 3. Delta Status Retrofit

12 catch blocks across 4 files currently swallow FX failures and write `NULL` delta with no tracking:

| File | Functions | Catch blocks |
|------|-----------|-------------|
| `stocks.ts` | `upsertStockPosition` (2 branches), `deleteStockPosition` | 3 |
| `broker-deposits.ts` | `createBrokerDeposit`, `updateBrokerDeposit`, `deleteBrokerDeposit` | 3 |
| `exchange-deposits.ts` | `createExchangeDeposit`, `updateExchangeDeposit`, `deleteExchangeDeposit` | 3 |
| `bank-accounts.ts` | `createBankAccount`, `updateBankAccount`, `deleteBankAccount` | 3 |

Change: Each catch block additionally passes `delta_status: 'pending'` to `logActivity()`. Crypto mutations don't have catch blocks (direct multiplication, no FX needed) — they pass `delta_status: 'complete'` when computing deltas.

**Before:**
```typescript
} catch (err) {
  console.error("[stocks] FX delta failed, will be null (backfillable):", err);
}
// deltaUsd/deltaEur remain null — silently invisible
```

**After:**
```typescript
} catch (err) {
  console.error("[stocks] FX delta failed, marked pending:", err);
  deltaStatus = "pending";
}
// logActivity called with delta_status: deltaStatus
```

---

## 4. Cash Modal FX Rate Plumbing

Three cash modal components need to pass the current EUR/USD FX rate to their server actions:

| Component | Parent page | FX rate source |
|-----------|-------------|----------------|
| `broker-deposit-modal.tsx` | `dashboard/cash/page.tsx` | Already fetched by page for currency display |
| `exchange-deposit-modal.tsx` | `dashboard/cash/page.tsx` | Same |
| `bank-account-modal.tsx` | `dashboard/cash/page.tsx` + `dashboard/accounts/page.tsx` | Same |

**Prop threading:**
1. Parent page passes `fxRate: number` prop to modal component
2. Modal passes it through to server action in `opts`
3. Server action uses it for cashflow computation (and optionally for delta computation, avoiding FX API call)

**Transfer dialog** (`transfer-dialog.tsx`): Transfers produce adjustment pairs — `cashflow_status = NULL`. No FX rate needed for cashflows. The existing FX conversion for delta computation remains unchanged.

---

## 5. Backfill & Self-Healing

### Backfill function

New server action: `src/lib/actions/backfill.ts`

```typescript
export async function backfillCashflowsAndDeltas(): Promise<{
  processed: number;
  succeeded: number;
  pending: number;
  failed: number;
}>
```

**Logic:**

1. Query rows needing cashflow backfill:
   - `cashflow_status IS NULL` AND entity_type in `[crypto_position, stock_position, exchange_deposit, broker_deposit, bank_account]` AND `is_adjustment = false` AND `undone_at IS NULL` (legacy rows pre-migration)
   - Also: `cashflow_status = 'pending'` AND (`cashflow_attempted_at` is NULL or older than 24 hours)
2. Query rows needing delta backfill:
   - `delta_status = 'pending'` AND (`delta_attempted_at` is NULL or older than 24 hours)
   - Note: The migration seeds `delta_status = 'pending'` for legacy adjustment rows with NULL deltas, so these will be picked up automatically
3. Process in batches of ~50 rows
4. For each row:
   - Extract entity info from `before_snapshot`/`after_snapshot` (same logic as current `deriveCashFlows()`)
   - For position entities: fetch historical price at `created_at` date (CoinGecko/Yahoo)
   - For cash entities: convert via historical FX rate (Frankfurter)
   - Compute cashflow/delta values
   - Write values + set status to `'complete'`

### Failure escalation (per row, per attempt)

```
API call succeeds → status = 'complete', values stored
API call fails, attempt 1-2 → status stays 'pending', attempted_at updated
API call fails, attempt 3 → try snapshot estimation fallback:
  ├─ Compare portfolio_snapshots class-level values around event date
  ├─ Infer approximate cashflow from value delta between snapshots
  ├─ If snapshot available → store estimate, status = 'complete'
  └─ If no snapshot → status = 'failed', store $0
```

Attempt count is inferred from `attempted_at` + 24h throttle (3 attempts = 3 days minimum). This is an approximation — if the user doesn't visit for multiple days, the next visit counts as attempt 1 again. Acceptable for an invite-only app with few users. If precision matters later, add an `attempt_count` column.

### Snapshot estimation fallback

When historical price APIs permanently fail (delisted assets, removed CoinGecko IDs):

1. Find `portfolio_snapshots` bracketing the event date
2. Compare class-level values (e.g., `crypto_value_usd` before vs after)
3. The difference approximates the cashflow for that class on that date
4. Store as best-effort estimate with `cashflow_status = 'complete'`

This is approximate but far better than $0 — the S&P benchmark line will be close to correct.

### When does backfill run?

| Trigger | Purpose |
|---------|---------|
| **Initial migration** | One-time manual invocation via server action to backfill all existing rows |
| **Dashboard load** | Fire-and-forget on dashboard page load (same pattern as existing snapshot save). Picks up `'pending'` rows. Never blocks page render. |

### What the backfill function reuses

`computeDeltaFromSnapshots()` in `activity-log.ts` already implements the core logic for computing values from snapshots + historical prices. The backfill function will use the same approach for cashflows, with the following differences:

- Cashflows use the same qty-delta × price math, but for non-adjustment rows
- Asset class classification is needed (crypto vs stocks vs cash, with stablecoin reclassification)
- The function wraps results with status tracking

---

## 6. New `deriveCashFlows()`

### Current function (388 lines, ~13 API calls)

```
Step 1: Query activity_log (non-adjustment, non-undone)
Step 2: Collect unique asset IDs and currencies from snapshots
Step 3: Look up parent assets (crypto_assets, stock_assets) for price identifiers
Step 4: Fetch ALL historical prices (CoinGecko, Yahoo, Frankfurter) ← THE BOTTLENECK
Step 5: Process events → CashFlowEvent[]
Step 6: Resolve current entity names
```

### New function (~15 lines, 1 DB query)

```typescript
export const deriveCashFlows = cache(async function deriveCashFlows(
  userId?: string
): Promise<{
  events: CashFlowEvent[];
  pendingCount: number;
  failedCount: number;
}> {
  const supabase = userId ? createAdminClient() : await createServerSupabaseClient();

  // Single DB query — all cashflows pre-computed at write time
  let query = supabase
    .from("activity_log")
    .select("cashflow_amount_usd, cashflow_amount_eur, cashflow_asset_class, entity_name, created_at")
    .eq("cashflow_status", "complete")
    .is("undone_at", null)  // undone rows excluded (belt-and-suspenders — undo should clear status)
    .order("created_at", { ascending: true })
    .limit(10000);
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query;

  // Pending/failed counts for UI warning — two separate count queries
  const baseFilter = userId ? { user_id: userId } : {};
  let pendingQuery = supabase
    .from("activity_log")
    .select("*", { count: "exact", head: true })
    .or("cashflow_status.eq.pending,delta_status.eq.pending");
  let failedQuery = supabase
    .from("activity_log")
    .select("*", { count: "exact", head: true })
    .or("cashflow_status.eq.failed,delta_status.eq.failed");
  if (userId) {
    pendingQuery = pendingQuery.eq("user_id", userId);
    failedQuery = failedQuery.eq("user_id", userId);
  }
  const [pendingResult, failedResult] = await Promise.all([pendingQuery, failedQuery]);
  const pendingCount = pendingResult.count ?? 0;
  const failedCount = failedResult.count ?? 0;

  return {
    events: (data ?? []).map(row => ({
      date: row.created_at.split("T")[0],
      amount_usd: row.cashflow_amount_usd ?? 0,   // defensive: status=complete guarantees non-null
      amount_eur: row.cashflow_amount_eur ?? undefined,
      asset_class: row.cashflow_asset_class ?? undefined,
      entity_name: row.entity_name ?? undefined,
    })),
    pendingCount,
    failedCount,
  };
});
```

### Return type change

Current: `Promise<CashFlowEvent[]>`
New: `Promise<{ events: CashFlowEvent[]; pendingCount: number; failedCount: number }>`

All 8 callers update to destructure `{ events: cashFlows, pendingCount, failedCount }` and pass counts to chart component.

### `CashFlowEvent` shape — unchanged

```typescript
export interface CashFlowEvent {
  date: string;
  amount_usd: number;
  amount_eur?: number;
  asset_class?: AssetClass;
  entity_name?: string;
}
```

`chart-enrichment.ts` (`enrichChartData()`) consumes `CashFlowEvent[]` — no changes needed there.

### What gets deleted

- Historical price fetching logic (Steps 2-4): asset ID collection, parent asset lookups, `fetchCoinHistory`/`fetchIndexHistory`/`fetchIndexHistory("EURUSD=X")` calls
- `PriceMap` type, `buildPriceMap()`, `getPrice()` helpers
- `toUsd()` and `toEur()` local helper functions
- `CashFlowEventInternal` type and entity name resolution (Step 6)
- Entity name batch-fetch queries (bank_accounts, exchange_deposits, broker_deposits, crypto_positions, stock_positions)

### What stays

- `CashFlowEvent` and `AssetClass` type exports (used by chart-enrichment)
- `React.cache()` wrapper (single-render dedup)
- Admin client path for share pages (`userId` parameter)

### Undo mechanism

When a row is undone (sets `undone_at`), the existing undo logic must also clear cashflow/delta status:
- Set `cashflow_status = NULL`, `delta_status = NULL`
- The `undone_at IS NULL` filter in the new `deriveCashFlows()` provides belt-and-suspenders protection

---

## 7. UI Warnings

### Per-row indicators in activity timeline

Each `activity_log` row with non-complete status gets a small icon in the activity timeline (`activity-log.tsx`):

| Status | Icon | Color | Tooltip |
|--------|------|-------|---------|
| `pending` | `Clock` (Lucide) | amber-400 | `"Price data pending -- will retry automatically"` |
| `failed` | `AlertTriangle` (Lucide) | red-400 | `"Price data unavailable -- chart uses estimate"` |

Shown for either `cashflow_status` or `delta_status` being non-complete. If both are pending/failed, one icon with a tooltip listing which values are affected.

### Chart banner

Persistent inline banner near the portfolio chart (not a toast):

- **Pending:** `"Some transactions are awaiting price data. View activity log."` — amber styling
- **Failed:** `"Some transactions have estimated values. View activity log."` — red styling

Counts come from `deriveCashFlows()` return value (`pendingCount`, `failedCount`).

### `getAdjustmentDeltas()` — unchanged

The adjustment deltas function already filters `.not("delta_usd", "is", null)` — rows with `delta_status = 'pending'` (which have `delta_usd = NULL`) are naturally excluded. The same per-row icons in the timeline give visibility into these.

---

## 8. Testing Strategy

### Unit tests (`__tests__/unit/`)

| Test file | Cases | What it covers |
|-----------|-------|----------------|
| `cashflow-computation.test.ts` | ~8 | Crypto buy → negative cashflow, sell → positive, EUR cash → USD conversion, stablecoin → `'cash'` class, adjustment → NULL, transfer → NULL, zero qty → skip |
| `backfill-logic.test.ts` | ~5 | Retry counting via 24h throttle, escalation to snapshot estimation, escalation to `'failed'` after 3 attempts, idempotency (already-complete rows skipped) |
| `derive-cashflows-db.test.ts` | ~4 | New DB-only function maps rows to `CashFlowEvent[]`, filters by `cashflow_status = 'complete'`, returns pending/failed counts, handles empty results |

### Component tests (`__tests__/component/`)

| Test file | Cases | What it covers |
|-----------|-------|----------------|
| `chart-warning-banner.test.ts` | ~4 | Renders amber for pending, red for failed, combined for both, hidden when counts are 0 |
| `activity-row-status.test.ts` | ~4 | Clock icon for pending, AlertTriangle for failed, correct tooltip text, hidden when complete/null |

### Integration tests (`__tests__/integration/`)

| Test file | Cases | What it covers |
|-----------|-------|----------------|
| `cashflow-write.test.ts` | ~6 | Create crypto position → verify `cashflow_amount_usd` and `cashflow_status = 'complete'` on activity_log. Create cash deposit → verify EUR→USD conversion. Create transfer → verify `cashflow_status IS NULL`. Mock FX failure → verify `delta_status = 'pending'`. Toggle adjustment ON → verify cashflow cleared, delta computed. Toggle adjustment OFF → verify delta cleared, cashflow computed. |

### Existing tests — impact

- `chart-enrichment` tests: unchanged — `CashFlowEvent[]` shape is identical
- `benchmark.test.ts` (if exists): simplified or removed alongside old code
- `deltas.test.ts`: unchanged — pure delta math is the same

---

## 9. Implementation Sequence

| Step | What | Files | Risk |
|------|------|-------|------|
| 1 | **Migration** — add 7 columns + 2 indexes | `supabase/migrations/002_cashflow_columns.sql` | Low |
| 2 | **`logActivity()` extension** — accept & store new fields | `src/lib/actions/activity-log.ts`, `src/lib/types.ts` | Low |
| 2a | **`toggleActivityAdjustment()` extension** — cashflow/delta swap on toggle | `src/lib/actions/activity-log.ts` | Medium |
| 3 | **Write-time cashflow** in server actions — compute alongside delta | `crypto.ts`, `stocks.ts`, `broker-deposits.ts`, `exchange-deposits.ts`, `bank-accounts.ts` | Medium |
| 4 | **Cash modal FX plumbing** — pass `fxRate` prop | `broker-deposit-modal.tsx`, `exchange-deposit-modal.tsx`, `bank-account-modal.tsx` + parent pages | Low |
| 5 | **`delta_status` retrofit** — 12 catch blocks get status tracking | Same 4 action files from step 3 | Low |
| 6 | **Backfill function** — idempotent, retry + snapshot fallback | New: `src/lib/actions/backfill.ts` | Medium |
| 7 | **New `deriveCashFlows()`** — DB-only, ~15 lines | `src/lib/actions/benchmark.ts` + 8 page files (callers) | High |
| 8 | **UI warnings** — chart banner + timeline row icons | Activity log component, chart parent components | Low |
| 9 | **Tests** — unit + component + integration | `__tests__/` (6 new test files) | Low |
| 10 | **Cleanup** — remove old price-fetching code | `benchmark.ts` (Steps 2-6 deleted) | Medium |

### Parallelization

Steps 3 + 4 + 5 can be done together (all mutation-side changes).
Steps 8 + 9 can be done together (UI + tests, after cutover).

### Verification gate

After step 6 (backfill), run on real data and confirm all rows reach `'complete'` before proceeding to step 7 (cutover). This ensures no data loss during the switch.

### Rollback plan

Step 10 (cleanup) is separated from step 7 (cutover) deliberately. During the verification period between steps 7 and 10, the old price-fetching code still exists in the codebase. If the DB-only path reveals issues in production, revert step 7 (restore old `deriveCashFlows()` function body) — the old code still works since it reads from snapshots, not from the new columns. Only proceed to step 10 (delete old code) after the new path is verified in production for a few days.

---

## 10. What Changes vs What Stays the Same

### Unchanged

- Delta computation math (qty * price, `toUsdAndEur()` for FX, `cashDelta()`, `positionQtyDelta()`)
- `logActivity()` fire-and-forget behavior (never throws)
- `chart-enrichment.ts` (`enrichChartData()`) — consumes same `CashFlowEvent[]` shape
- `getAdjustmentDeltas()` — unchanged logic and filters
- All 12 catch blocks catch FX failures the same way
- Share page support via `userId` parameter and admin client

### Changed

| Aspect | Before | After |
|--------|--------|-------|
| Cashflow computation | Read-time, ~13 API calls | Write-time, 0 API calls + DB query |
| FX failure visibility | Silent NULL, invisible to user | `delta_status = 'pending'`, amber icon in timeline |
| Cashflow data storage | Not stored | Stored on `activity_log` (7 new columns) |
| Cash modal interface | No FX rate prop | Passes `fxRate` prop from parent |
| `deriveCashFlows()` return | `CashFlowEvent[]` | `{ events, pendingCount, failedCount }` |
| `deriveCashFlows()` size | 388 lines, 6 steps | ~15 lines, 1 DB query |
| Page load time (cold) | 3-6s (API calls) | ~2ms (DB query) |

### Not in scope

- `deriveCashFlows` N-API-call code remains during backfill period (only deleted after backfill completes)
- FX rate API consolidation (3 calls → 1-2 via cross-rate math) — separate optimization
- In-memory rate limiter replacement — accepted tradeoff for invite-only app
- Transfer DB transactions — accepted tradeoff
