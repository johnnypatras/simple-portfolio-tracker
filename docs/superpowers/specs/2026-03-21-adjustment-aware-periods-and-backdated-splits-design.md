# Adjustment-Aware Period Changes & Backdated Entry Splits

**Date**: 2026-03-21
**Status**: Approved
**Scope**: Two related features sharing the adjustment/cashflow timeline infrastructure

---

## Problem Statement

### Problem 1: Period change percentages inflated by imports

The chart applies adjustment compensation to flatten artificial ramps from portfolio imports:
`adjustedValue = value + (finalCumDelta - cumDeltaAtSnapshotDate)`. But the summary period
percentages (7d/30d/1y) in `getChangeForPeriod` use raw snapshot values. When a large import
happened within the period window, the "before" snapshot shows pre-import value, inflating the %.

**Example**: Feb 18 snapshot = EUR 23K (pre-import), Feb 20 import = EUR 67K delta, today = EUR 111K.
30d shows +383% instead of the real ~23% market gain.

### Problem 2: No way to specify when money actually entered

When importing an existing portfolio, all activity is recorded at the import timestamp. The system
can't distinguish "I imported 0.5 BTC today" from "I bought 0.25 BTC on Jan 5 and 0.20 BTC on
Jan 10." This affects:
- **S&P benchmark**: buys hypothetical S&P units at import date price, not actual purchase dates
- **Chart adjustment**: the delta timeline uses `created_at`, not the real entry date
- **Period changes**: adjustment compensation uses `created_at` dates

---

## Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Period change compensation | Same formula as chart (Approach A) | Consistency — chart and percentages show same numbers |
| Backdating model | `effective_date` column on `activity_log` | Trade date vs entry date — standard financial pattern |
| Splitting model | Parent-child in same table (Approach D) | Homogeneous data, follows existing transfer pattern, single source of truth |
| Split children as first-class rows | Yes — no special pipeline logic | All pipelines treat children identically to regular entries |
| Override table (Approach B) | Rejected | Splits truth across two tables, requires JOIN + conditional logic in every consumer |
| JSONB splits (Approach C) | Rejected | Fights relational model, harder to query/validate |
| Splitting transfer legs | Blocked | Would require splitting both legs in sync — too complex |
| Splitting compensation entries | Blocked | System-generated, not user data |
| Recursive splitting (split a child) | Blocked | Children have `split_from_id` set — prevents multi-level nesting |
| Import-backup bulk flow | In scope | `import.ts` threads `effective_date` through to `logActivity` for each imported entry; export includes the column so round-trip preserves effective dates |

---

## Feature 1: Adjustment-Aware Period Percentages

### Data flow

```
dashboard/page.tsx  ──adjustmentDeltas──>  DashboardGrid (new prop)
share/[token]/page.tsx                          |
                                          ChangeContext (new field)
                                                |
                                      get*ChangeForPeriod() functions
```

Both page components already fetch `adjustmentDeltas` — they pass it to `PortfolioChart` but
not to `DashboardGrid`. The fix threads it through.

### ChangeContext addition

```typescript
// src/lib/portfolio/dashboard-changes.ts
export interface ChangeContext {
  // ... existing fields ...
  adjustmentDeltas?: AdjustmentDelta[];  // NEW — optional, defaults to [] internally
}
```

Making it optional avoids breaking all existing callers and test fixtures that construct
`ChangeContext`. The `get*ChangeForPeriod` functions default to `[]` internally:
`const deltas = ctx.adjustmentDeltas ?? [];`

### Period change formula

For periods other than 24h, after looking up the past snapshot:

```typescript
const cumDeltaAtSnapshot = getCumDeltaAtDate(snapshotDate, deltas, primaryCurrency);
const finalCumDelta = getCumDeltaFinal(deltas, primaryCurrency);

// Add back not-yet-imported value to the past snapshot
const adjustedPastValue = pastValue + (finalCumDelta - cumDeltaAtSnapshot);

// Guard: if adjustment makes past value non-positive, return unavailable
if (adjustedPastValue <= 0) return { percent: 0, valueChange: 0, available: false, ... };

const percent = ((currentValue - adjustedPastValue) / adjustedPastValue) * 100;
const valueChange = currentValue - adjustedPastValue;
```

`getCumDeltaAtDate` walks the sorted `AdjustmentDelta[]` array using forward-fill (last entry
where `date <= snapshotDate`), identical to chart-enrichment's `deltaMap` logic.

### Per-class variants

`getCryptoChangeForPeriod`, `getStockChangeForPeriod`, `getCashChangeForPeriod` apply the same
formula using class-specific cumulative fields (`crypto_cumulative_usd/eur`, etc.).

### FX decomposition

Both primary-currency and other-currency past values receive the same adjustment so the FX
percentage isn't distorted by the import ramp. This requires modifying the `deriveClassFx`
call sites in the per-class functions:

The per-class functions currently pass `pastUsd` (from the raw snapshot) to `deriveClassFx`,
which derives `pastClassEur` from it. With adjustment compensation, the adjusted `pastUsd`
must be passed instead:

```typescript
// Before:
const pastUsd = snapshot.crypto_value_usd ?? 0;
const { fxPct, fxAbs, pastClassEur } = deriveClassFx(..., pastUsd, snapshot, ...);

// After:
const rawPastUsd = snapshot.crypto_value_usd ?? 0;
const classDeltaUsd = getCumDeltaAtDate(snapshotDate, deltas, "crypto", "USD");
const finalClassDeltaUsd = getFinalCumDelta(deltas, "crypto", "USD");
const adjustedPastUsd = rawPastUsd + (finalClassDeltaUsd - classDeltaUsd);
const { fxPct, fxAbs, pastClassEur } = deriveClassFx(..., adjustedPastUsd, snapshot, ...);
```

`deriveClassFx` signature is unchanged — it already receives `pastClassUsd` as a parameter.
The adjustment happens at the call site, keeping `deriveClassFx` pure and unaware of the
adjustment mechanism.

The `pastClassEur` returned by `deriveClassFx` will also be adjusted (since it's derived
from `adjustedPastUsd × impliedRate`), so the primary-currency return and FX decomposition
are both computed against the adjusted base.

### 24h period

Unaffected — uses live price changes from `DashboardInsights`, not snapshots.

### Deposit tooltip

No change needed. Adjustments (`is_adjustment=true`) and cash flows (`cashflow_status='complete'`)
are separate populations. Tooltip decomposition (Market = Total - Deposits) continues to work
correctly with the adjusted total.

---

## Feature 2: Backdated Entry Splits

### Schema changes (Migration 011)

```sql
-- Migration 011: Support for backdated entries and entry splitting

-- 1. Effective date — "when it really happened" (vs created_at = "when it was recorded")
ALTER TABLE activity_log ADD COLUMN effective_date DATE;

-- 2. Split parent reference — links split children to their original entry
ALTER TABLE activity_log ADD COLUMN split_from_id UUID
  REFERENCES activity_log(id) ON DELETE CASCADE;

-- 3. Self-reference guard
ALTER TABLE activity_log ADD CONSTRAINT chk_no_self_split
  CHECK (split_from_id IS DISTINCT FROM id);

-- 4. Index for efficient child lookups (undo, timeline grouping)
CREATE INDEX idx_activity_log_split_from ON activity_log(split_from_id)
  WHERE split_from_id IS NOT NULL;
```

No RLS changes — children inherit `user_id` from parent at write time.
No backfill — existing entries have both columns as NULL (correct default behavior).

### Type changes

```typescript
// src/lib/types.ts — ActivityLog interface
effective_date?: string | null;   // "YYYY-MM-DD" or null
split_from_id?: string | null;    // UUID of parent entry or null
```

### Universal date source change

Every pipeline that reads dates from `activity_log` switches from `created_at` to
`COALESCE(effective_date, created_at)`. **Critically, this includes query ordering** —
queries must sort by the effective date to maintain correct cumulative sum computation.

| Pipeline | File | Current | After |
|----------|------|---------|-------|
| `getAdjustmentDeltas` | `activity-log.ts:414,418,469` | SELECT omits `effective_date`; `ORDER BY created_at ASC`; `row.created_at.split("T")[0]` | Add `effective_date` to SELECT; post-sort by `effective_date ?? created_at`; use same for date key |
| `deriveCashFlows` | `benchmark.ts:29,35,66` | SELECT omits `effective_date`; `ORDER BY created_at ASC`; `row.created_at.split("T")[0]` | Add `effective_date` to SELECT; post-sort by `effective_date ?? created_at`; use same for date key |
| `toggleActivityAdjustment` | `activity-log.ts:309` | `row.created_at` passed to `computeDeltaFromSnapshots` | `row.effective_date ?? row.created_at` for price lookup date |
| `backfillCashflowsAndDeltas` | `backfill.ts:36,120,192` | Batch SELECT omits `effective_date`; `row.created_at.split("T")[0]` for price lookups | Add `effective_date` to batch SELECT; use `row.effective_date ?? row.created_at.split("T")[0]` |
| `backfillSingleRow` | `backfill.ts:308,340` | Single-row SELECT omits `effective_date`; `row.created_at` for price lookup | Add `effective_date` to single-row SELECT; use `row.effective_date ?? row.created_at` |
| `exportActivityLogsCsv` | `activity-log.ts:508` | Hardcoded column headers | Add `effective_date`, `split_from_id` to CSV headers |
| Timeline `groupByDate` | `activity-timeline.tsx:208` | `log.created_at` | `log.created_at` (unchanged — display by recording date) |

**Why ordering matters**: `getAdjustmentDeltas` and `deriveCashFlows` compute running
cumulative sums. If rows are fetched in `created_at` order but keyed by `effective_date`
(which may be earlier), the cumulative sums accumulate in the wrong chronological order.
Both queries must post-sort rows by `effective_date ?? created_at` before computing
cumulative totals. DB-level `ORDER BY COALESCE(effective_date, created_at::date)` is
possible but `effective_date` is a DATE vs `created_at` is TIMESTAMPTZ — post-sort in
application code is simpler and safer.

The timeline continues to display entries under their `created_at` date (when you recorded it),
but shows the `effective_date` as an annotation when it differs.

### Operation 1: Simple backdate

```typescript
// src/lib/actions/splits.ts
async function backdateActivityEntry(entryId: string, effectiveDate: string): Promise<void>
```

1. Fetch entry, validate ownership and not-undone
2. Validate `effectiveDate` is a valid past or today date
3. `UPDATE activity_log SET effective_date = $date WHERE id = $id`
4. For transfer legs: set `effective_date` on all legs in the `transfer_group_id`
5. Revalidate dashboard

Reversible: set `effective_date = null` to revert.

### Operation 2: Split + backdate

```typescript
interface SplitLeg {
  effective_date: string;   // YYYY-MM-DD
  quantity: number;         // user-specified amount for this date
}

async function splitActivityEntry(parentId: string, legs: SplitLeg[]): Promise<void>
```

**Validations:**
- Parent exists, owned by user, not undone
- Parent has no `split_from_id` (not a child — no recursive splits)
- Parent has no `compensates_for` (not a compensation entry)
- Parent has no `transfer_group_id` (not a transfer leg)
- `delta_status` or `cashflow_status` is `'complete'` (nothing to distribute if pending)
- Sum of leg quantities equals original quantity (extracted from snapshots)
- All legs have distinct `effective_date` values (duplicates rejected)
- All `effective_date` values are past or today
- At least 2 legs (otherwise use simple backdate)

**Steps:**
1. Extract original quantity from snapshots, using entity-type-aware field mapping:
   - Crypto positions: `after_snapshot.quantity` (action=created) or `after.quantity - before.quantity` (action=updated)
   - Stock positions: `after_snapshot.quantity` or `after.quantity - before.quantity`
   - Cash accounts: `after_snapshot.balance` (action=created) or `after.balance - before.balance` (action=updated)
2. Compute fractions: `fraction_i = leg_i.quantity / totalQuantity`
3. Rounding safety: compute N-1 children by fraction, last child = `parent.value - sum(others)`
4. Create N children in single transaction, each inheriting from parent:
   - `user_id`, `action`, `entity_type`, `entity_id`, `entity_table`, `entity_name`
   - `is_adjustment` from parent
   - `effective_date` from the leg
   - `split_from_id = parent.id`
   - **If parent `is_adjustment = true`** (adjustment entry — has delta, no cashflow):
     - `delta_usd = parent.delta_usd * fraction`
     - `delta_eur = parent.delta_eur * fraction`
     - `delta_status = 'complete'`
     - `cashflow_amount_usd = null`, `cashflow_amount_eur = null`, `cashflow_status = null`
   - **If parent `is_adjustment = false`** (normal entry — has cashflow, no delta):
     - `cashflow_amount_usd = parent.cashflow_amount_usd * fraction`
     - `cashflow_amount_eur = parent.cashflow_amount_eur * fraction`
     - `cashflow_asset_class` from parent
     - `cashflow_status = 'complete'`
     - `delta_usd = null`, `delta_eur = null`, `delta_status = null`
   - `before_snapshot = null`, `after_snapshot = null` (no entity mutation)
   - `details = { split_quantity: leg.quantity }`
5. Mark parent as undone (`undone_at = now()`) — **only `undone_at` is set on the parent**.
   The parent's `delta_usd`, `delta_eur`, `cashflow_amount_usd`, `cashflow_amount_eur`,
   and all status fields are preserved unchanged. This is essential for unsplit: clearing
   `undone_at` restores the parent to its original state without needing to recompute anything.
6. Revalidate dashboard

**Why children are homogeneous** — no pipeline checks `split_from_id`:

| Pipeline | Parent excluded by | Children included by |
|----------|-------------------|---------------------|
| `getAdjustmentDeltas` | `undone_at IS NOT NULL` | Regular rows with same `is_adjustment` flag |
| `deriveCashFlows` | `undone_at IS NOT NULL` | Regular rows with `cashflow_status = 'complete'` |
| S&P benchmark | Consumes `CashFlowEvent[]` | Doesn't know `activity_log` exists |
| Chart enrichment | Consumes `AdjustmentDelta[]` | Doesn't know `activity_log` exists |

### Operation 3: Unsplit

```typescript
async function unsplitActivityEntry(parentId: string): Promise<void>
```

1. Find all children: `WHERE split_from_id = parentId`
2. Hard-delete all children (no entity mutations to preserve)
3. Clear parent's `undone_at` (SET `undone_at = NULL`)
4. Parent's delta/cashflow re-enters all pipelines
5. Revalidate dashboard

### Undo integration

In `undoActivity()` (`undo.ts`), add split checks **before the `undone_at` guard** (not after).
This is critical: split parents have `undone_at` set by `splitActivityEntry`, so the existing
`undone_at` guard would reject them before the split check runs.

```typescript
// ── NEW: Split checks (before undone_at guard) ──────────

// 1. Check if this entry has split children (user wants to unsplit)
const { data: splitChildren } = await supabase
  .from("activity_log")
  .select("id")
  .eq("split_from_id", log.id)
  .is("undone_at", null)
  .limit(1);

if (splitChildren?.length) {
  return unsplitEntry(log, supabase, userId);
}

// 2. Check if this IS a split child (redirect to parent unsplit)
if (log.split_from_id) {
  const parent = await fetchEntry(log.split_from_id);
  return unsplitEntry(parent, supabase, userId);
}

// ── Existing guards (undone_at, compensates_for) ────────
// 3. Existing: undone_at check (now only reached for non-split entries)
// 4. Existing: transfer group check
// 5. Existing: single entry undo
```

Full reversal (unsplit + undo parent): sequential — unsplit first restores the parent,
then the parent can be undone normally to reverse the entity mutation.

---

## UI Design

### Timeline entry actions

| Action | Icon | Visibility | Behavior |
|--------|------|------------|----------|
| Edit date | `Calendar` | Non-undone, non-child entries | Popover with date picker, sets `effective_date` |
| Split | `GitBranch` | Non-undone, non-child, non-transfer, complete status | Opens split modal |
| Unsplit | `Merge` | Split parents only (has children) | Confirm dialog, then unsplits |

Hidden on read-only/share pages (same as undo and adjustment toggle).

**Note on backdated transfers**: A backdated transfer appears under its original recording
date in the timeline (grouped by `created_at`), not its effective date. The effective date
annotation shows the real date. This is consistent with the design choice that the timeline
answers "when did I record this?" while the effective date answers "when did it happen?"

### Effective date annotation

When `effective_date` differs from `created_at` date, show annotation on the entry:

```
  Effective: Jan 5, 2025
```

Styling: `text-[10px] text-sky-400` with inline `Calendar` icon.
Sky-blue is distinct from amber (adjustment) and teal (transfer).

### Split parent/child display

Extends the `TimelineItem` type with a third variant:

```typescript
type TimelineItem =
  | { type: "single"; entry: ActivityLog }
  | { type: "transfer"; groupId: string; entries: ActivityLog[] }
  | { type: "split"; parent: ActivityLog; children: ActivityLog[] }
```

Split parents show:
- "Split" badge (`bg-violet-500/15 text-violet-400` — violet, distinct from amber/teal/sky)
- Original entry details
- Expand/collapse chevron showing child allocations (date + quantity per child)
- "Unsplit" button

Children are NOT shown as standalone timeline entries — only nested under their parent.
To achieve this, `getActivityLogs` adds `.is("split_from_id", null)` to exclude children
from paginated results. Children are fetched separately: after fetching the page, a second
query retrieves all children whose `split_from_id` matches any parent in the current page.
This keeps pagination correct (children don't consume page slots).

### Split modal

Opens when clicking "Split" on an entry. Shows:
- Original entry details (entity name, quantity, recorded date)
- Dynamic leg list: date picker + quantity input per leg, with remove button
- Live "Remaining" counter (original quantity - sum of legs)
- "Add date" button to add legs
- Validation: sum cannot exceed original, all dates must be past, 2+ distinct dates required
- Auto-creates remainder child at parent's `effective_date` (if set) or `created_at` date if remaining > 0
- Quantity precision matches entity type (6 decimals crypto, 2 for stocks/cash)

### Effective date in add/import modals

Optional "Effective date" field in 4 modals:
- Add Crypto Modal
- Add Stock Modal
- Cash Account Modal
- Position Editors (crypto + stock Record Buy)

Empty by default (null = use `created_at`). Date picker restricted to past/today.
Passes `effective_date` to `logActivity` when set.

---

## Testing Strategy

### Unit tests — `dashboard-changes.test.ts` (extend existing)

| Test | What it verifies |
|------|-----------------|
| Period change with no deltas | Backward compatible — unchanged behavior |
| Period change with delta before snapshot date | `adjustedPastValue` increases, percentage decreases |
| Period change with delta after snapshot date | No effect on that period |
| Period change with multiple deltas, forward-fill | Uses last delta where date <= snapshot date |
| Snapshot date exactly on a delta date | Boundary — delta included |
| Per-class period change (crypto/stocks/cash) | Class-specific cumulative deltas |
| FX decomposition with adjustment | Both currency past values adjusted |
| `adjustedPastValue` becomes <= 0 | Returns `available: false` |
| 24h period with deltas present | Unaffected — uses live prices |
| All deltas after snapshot date | `cumDeltaAtSnapshot = 0`, maximum adjustment applied |
| Delta with `effective_date` before snapshot but `created_at` after | Uses `effective_date` — verifies forward-fill uses correct date source |

### Unit tests — `split-logic.test.ts` (new)

| Test | What it verifies |
|------|-----------------|
| Fraction computation from quantities | 0.25/0.5 = 0.5, etc. |
| Rounding safety — last child gets remainder | Sum exactly equals parent |
| Fractions summing to > 1.0 | Rejected |
| Zero quantity leg | Rejected |
| Single-date split (< 2 dates) | Rejected |
| Two legs with same effective_date | Rejected |
| Splitting entry with `compensates_for` set | Rejected |
| Splitting entry with `split_from_id` set (child) | Rejected (no recursive splits) |
| Splitting entry with `transfer_group_id` set | Rejected |
| Entry with only delta fields (adjustment) | Only delta distributed, cashflow null |
| Entry with only cashflow fields (non-adjustment) | Only cashflow distributed, delta null |
| High-precision crypto quantity (18 decimals) | Precision preserved |
| Effective date in the future | Rejected |
| Entry with quantity = 0 | Rejected |
| Entry with pending delta/cashflow status | Rejected |
| Entry already has effective_date set | Allowed — children use own dates |

### Integration tests — `effective-date.test.ts` (new)

| Test | What it verifies |
|------|-----------------|
| `effective_date` column accepts valid DATE | Schema |
| `split_from_id` FK constraint | Must reference existing row |
| `split_from_id != id` CHECK | Self-reference blocked |
| ON DELETE CASCADE | Deleting parent deletes children |
| `split_from_id` to non-existent row | FK violation |
| Children visible through RLS | Same `user_id` scoping |
| Cross-user child creation blocked | RLS prevents wrong `user_id` |
| Cascade: delete parent with 3 children | All 4 rows removed |

### Component tests — `split-modal.test.ts` (new)

| Test | What it verifies |
|------|-----------------|
| Modal renders with parent entry details | Name, quantity, date shown |
| Adding a leg updates remaining quantity | Live calculation |
| Quantity exceeding original shows error | Validation state |
| Submit disabled with < 2 dates | Button state |
| Date picker excludes future dates | Validation |
| Removing a leg recalculates remaining | Update |
| Removing all legs shows empty state | Submit disabled |

### Component tests — `activity-timeline-split.test.ts` (new)

| Test | What it verifies |
|------|-----------------|
| Split parent renders with "Split" badge | Visual indicator |
| Expand/collapse shows children with dates and quantities | Interaction |
| Unsplit button visible on split parents only | Conditional render |
| Edit date / Split buttons hidden on split children | Children aren't individually editable |
| Effective date annotation shown when differs from created_at | Conditional display |

### Existing tests to update

| File | Change |
|------|--------|
| `dashboard-changes.test.ts` | Add `adjustmentDeltas: []` to existing `ChangeContext` fixtures |

---

## Files Modified

| Area | File | Change |
|------|------|--------|
| Migration | `supabase/migrations/011_effective_date_and_splits.sql` | New |
| Types | `src/lib/types.ts` | Add `effective_date`, `split_from_id` to `ActivityLog` |
| Server actions | `src/lib/actions/activity-log.ts` | Add `effective_date` to SELECT in `getAdjustmentDeltas`; COALESCE date + post-sort in `getAdjustmentDeltas`; COALESCE in `toggleActivityAdjustment`; add columns to `exportActivityLogsCsv`; accept `effective_date` in `logActivity`; exclude split children in `getActivityLogs` |
| Server actions | `src/lib/actions/import.ts` | Thread `effective_date` through to `logActivity` for each imported entry |
| Server actions | `src/lib/actions/benchmark.ts` | COALESCE date + post-sort in `deriveCashFlows` |
| Server actions | `src/lib/actions/backfill.ts` | Add `effective_date` to SELECT in both batch and single-row queries; COALESCE date in all price lookup paths |
| Server actions | `src/lib/actions/splits.ts` | New — `backdateActivityEntry`, `splitActivityEntry`, `unsplitActivityEntry` |
| Server actions | `src/lib/actions/undo.ts` | Add split-aware undo routing (before `undone_at` guard) |
| Dashboard logic | `src/lib/portfolio/dashboard-changes.ts` | Add `adjustmentDeltas` to `ChangeContext`, adjust all `get*ChangeForPeriod` |
| Dashboard page | `src/app/dashboard/page.tsx` | Pass `adjustmentDeltas` to `DashboardGrid` |
| Share page | `src/app/share/[token]/page.tsx` | Pass `adjustmentDeltas` to `DashboardGrid` |
| Dashboard grid | `src/components/dashboard/dashboard-grid.tsx` | Accept and thread `adjustmentDeltas` prop |
| Timeline | `src/components/history/activity-timeline.tsx` | Split grouping, effective date annotation, new action buttons |
| Split modal | `src/components/history/split-modal.tsx` | New |
| Add modals | `src/components/crypto/add-crypto-modal.tsx` | Optional effective date field |
| Add modals | `src/components/stocks/add-stock-modal.tsx` | Optional effective date field |
| Add modals | `src/components/cash/cash-account-modal.tsx` | Optional effective date field |
| Position editors | `src/components/crypto/position-editor.tsx` | Optional effective date field |
| Position editors | `src/components/stocks/stock-position-editor.tsx` | Optional effective date field |
| Tests | `__tests__/unit/dashboard-changes.test.ts` | Extend with adjustment-aware tests |
| Tests | `__tests__/unit/split-logic.test.ts` | New |
| Tests | `__tests__/integration/effective-date.test.ts` | New |
| Tests | `__tests__/component/split-modal.test.ts` | New |
| Tests | `__tests__/component/activity-timeline-split.test.ts` | New |
