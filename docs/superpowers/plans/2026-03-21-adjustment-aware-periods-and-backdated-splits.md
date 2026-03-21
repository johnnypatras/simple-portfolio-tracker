# Adjustment-Aware Period Changes & Backdated Entry Splits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix inflated period percentages (7d/30d/1y) by applying the same adjustment delta compensation the chart uses, and add the ability to backdate/split activity log entries.

**Architecture:** Two features sharing the adjustment/cashflow timeline. Feature 1 (period changes) is pure logic — threads existing `adjustmentDeltas` into `ChangeContext` and applies the chart's delta compensation formula. Feature 2 (backdated splits) adds `effective_date` + `split_from_id` columns, a new server action module, undo integration, and timeline UI. Feature 1 ships first for immediate value.

**Tech Stack:** TypeScript, Supabase PostgreSQL, Next.js App Router, Vitest, React Testing Library

**Spec:** `docs/superpowers/specs/2026-03-21-adjustment-aware-periods-and-backdated-splits-design.md`

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `supabase/migrations/011_effective_date_and_splits.sql` | Schema: `effective_date`, `split_from_id`, CHECK, index |
| `src/lib/actions/splits.ts` | Server actions: `backdateActivityEntry`, `splitActivityEntry`, `unsplitActivityEntry` |
| `src/components/history/split-modal.tsx` | Split modal component |
| `__tests__/unit/split-logic.test.ts` | Unit tests for split fraction/validation logic |
| `__tests__/integration/effective-date.test.ts` | Integration tests for schema constraints |
| `__tests__/component/split-modal.test.ts` | Component tests for split modal |
| `__tests__/component/activity-timeline-split.test.ts` | Component tests for timeline split display |

### Modified files
| File | Change summary |
|------|---------------|
| `src/lib/types.ts` | Add `effective_date`, `split_from_id` to `ActivityLog` |
| `src/lib/portfolio/dashboard-changes.ts` | Add `adjustmentDeltas?` to `ChangeContext`, delta helpers, adjust all 4 `get*ChangeForPeriod` functions |
| `src/components/dashboard/dashboard-grid.tsx` | Accept `adjustmentDeltas` prop, thread to `ChangeContext` |
| `src/app/dashboard/page.tsx` | Pass `adjustmentDeltas` to `DashboardGrid` |
| `src/app/share/[token]/page.tsx` | Pass `adjustmentDeltas` to `DashboardGrid` |
| `src/lib/actions/activity-log.ts` | `logActivity` accepts `effective_date`; `getAdjustmentDeltas` adds `effective_date` to SELECT + post-sort; `toggleActivityAdjustment` uses effective date for price; `getActivityLogs` excludes split children; `exportActivityLogsCsv` adds columns |
| `src/lib/actions/benchmark.ts` | `deriveCashFlows` adds `effective_date` to SELECT + post-sort |
| `src/lib/actions/backfill.ts` | Both queries add `effective_date` to SELECT; all price lookups use COALESCE |
| `src/lib/actions/undo.ts` | Split-aware undo routing before `undone_at` guard |
| `src/lib/actions/import.ts` | Thread `effective_date` through to `logActivity` |
| `src/components/history/activity-timeline.tsx` | Split grouping, effective date annotation, Calendar/GitBranch/Merge/Unsplit buttons |
| `src/components/crypto/add-crypto-modal.tsx` | Optional effective date field |
| `src/components/stocks/add-stock-modal.tsx` | Optional effective date field |
| `src/components/cash/cash-account-modal.tsx` | Optional effective date field |
| `src/components/crypto/position-editor.tsx` | Optional effective date field |
| `src/components/stocks/stock-position-editor.tsx` | Optional effective date field |
| `__tests__/unit/dashboard-changes.test.ts` | Extend with ~11 adjustment-aware tests |

---

## Phase 1: Adjustment-Aware Period Percentages (Feature 1)

### Task 1: Add delta helper functions and `adjustmentDeltas` to `ChangeContext`

**Files:**
- Modify: `src/lib/portfolio/dashboard-changes.ts`
- Test: `__tests__/unit/dashboard-changes.test.ts`

- [ ] **Step 1: Write failing tests for `getCumDeltaAtDate` helper**

Add to `__tests__/unit/dashboard-changes.test.ts`:
```typescript
import type { AdjustmentDelta } from "@/lib/types";

function makeDelta(date: string, cumUsd: number, cumEur: number): AdjustmentDelta {
  return {
    date, cumulative_usd: cumUsd, cumulative_eur: cumEur,
    crypto_cumulative_usd: 0, crypto_cumulative_eur: 0,
    stocks_cumulative_usd: 0, stocks_cumulative_eur: 0,
    cash_cumulative_usd: 0, cash_cumulative_eur: 0,
  };
}

describe("getCumDeltaAtDate", () => {
  it("returns 0 for empty deltas", () => {
    // Signature: getCumDeltaAtDate(date, deltas, primaryCurrency, assetClass?)
    expect(getCumDeltaAtDate("2026-01-15", [], "EUR")).toBe(0);
  });

  it("returns cumulative delta at exact date", () => {
    const deltas = [makeDelta("2026-01-10", 1000, 850)];
    expect(getCumDeltaAtDate("2026-01-10", deltas, "EUR")).toBe(850);
  });

  it("forward-fills to last delta before date", () => {
    const deltas = [
      makeDelta("2026-01-05", 500, 425),
      makeDelta("2026-01-15", 1500, 1275),
    ];
    expect(getCumDeltaAtDate("2026-01-10", deltas, "EUR")).toBe(425);
  });

  it("returns 0 when date is before all deltas", () => {
    const deltas = [makeDelta("2026-02-01", 1000, 850)];
    expect(getCumDeltaAtDate("2026-01-01", deltas, "EUR")).toBe(0);
  });

  it("returns final delta when date is after all deltas", () => {
    const deltas = [makeDelta("2026-01-01", 1000, 850)];
    expect(getCumDeltaAtDate("2026-12-31", deltas, "EUR")).toBe(850);
  });

  it("returns class-specific delta when assetClass provided", () => {
    const deltas: AdjustmentDelta[] = [{
      date: "2026-01-10",
      cumulative_usd: 3000, cumulative_eur: 2550,
      crypto_cumulative_usd: 1000, crypto_cumulative_eur: 850,
      stocks_cumulative_usd: 2000, stocks_cumulative_eur: 1700,
      cash_cumulative_usd: 0, cash_cumulative_eur: 0,
    }];
    // 4th param = assetClass
    expect(getCumDeltaAtDate("2026-01-10", deltas, "EUR", "crypto")).toBe(850);
    expect(getCumDeltaAtDate("2026-01-10", deltas, "USD", "stocks")).toBe(2000);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npm test -- --reporter=verbose dashboard-changes`
Expected: FAIL — `getCumDeltaAtDate` is not exported.

- [ ] **Step 3: Implement `getCumDeltaAtDate` and `getCumDeltaFinal`**

Add to `src/lib/portfolio/dashboard-changes.ts` (before the main functions section):
```typescript
import type { PortfolioSnapshot, AssetClass, CashFlowEvent, BaseCurrency, AdjustmentDelta } from "@/lib/types";

// Add to ChangeContext interface:
//   adjustmentDeltas?: AdjustmentDelta[];

/** Cumulative delta at a given date (forward-fill). */
export function getCumDeltaAtDate(
  date: string,
  deltas: AdjustmentDelta[],
  primaryCurrency: BaseCurrency,
  assetClass?: "crypto" | "stocks" | "cash",
): number {
  let result = 0;
  for (const d of deltas) {
    if (d.date > date) break;
    result = assetClass
      ? (primaryCurrency === "EUR"
          ? d[`${assetClass}_cumulative_eur`]
          : d[`${assetClass}_cumulative_usd`])
      : (primaryCurrency === "EUR" ? d.cumulative_eur : d.cumulative_usd);
  }
  return result;
}

/** Final cumulative delta (last entry). */
export function getCumDeltaFinal(
  deltas: AdjustmentDelta[],
  primaryCurrency: BaseCurrency,
  assetClass?: "crypto" | "stocks" | "cash",
): number {
  if (deltas.length === 0) return 0;
  const d = deltas[deltas.length - 1];
  return assetClass
    ? (primaryCurrency === "EUR"
        ? d[`${assetClass}_cumulative_eur`]
        : d[`${assetClass}_cumulative_usd`])
    : (primaryCurrency === "EUR" ? d.cumulative_eur : d.cumulative_usd);
}
```

Also add `adjustmentDeltas?: AdjustmentDelta[];` to the `ChangeContext` interface.

- [ ] **Step 4: Run tests — verify they pass**

Run: `npm test -- --reporter=verbose dashboard-changes`
Expected: All new tests PASS, all existing tests still PASS.

- [ ] **Step 5: Commit**

```
feat: add adjustment delta helpers and optional adjustmentDeltas to ChangeContext
```

---

### Task 2: Apply adjustment compensation to `getChangeForPeriod`

**Files:**
- Modify: `src/lib/portfolio/dashboard-changes.ts:115-156`
- Test: `__tests__/unit/dashboard-changes.test.ts`

- [ ] **Step 1: Write failing tests for adjusted period changes**

Add to `__tests__/unit/dashboard-changes.test.ts`:
```typescript
describe("getChangeForPeriod with adjustment deltas", () => {
  it("adjusts past value when delta exists before snapshot date", () => {
    // Delta of €67K on 2026-01-10, snapshot on 2026-01-01 (before delta)
    // Past EUR = 23000, finalCumDelta = 67000, cumAtSnapshot = 0
    // adjustedPast = 23000 + (67000 - 0) = 90000
    // percent = (90000 - 90000) / 90000 = 0%
    const deltas = [makeDelta("2026-01-10", 78824, 67000)];
    const snap = makeSnapshot({ total_value_eur: 23000, total_value_usd: 27060 });
    const ctx = makeCtx({
      totalValue: 90000,
      pastSnapshots: { "30d": snap },
      adjustmentDeltas: deltas,
    });
    const result = getChangeForPeriod("30d", ctx);
    expect(result.available).toBe(true);
    // (90000 - 90000) / 90000 = 0%
    expect(result.percent).toBeCloseTo(0, 0);
  });

  it("no adjustment when deltas are empty", () => {
    const snap = makeSnapshot({ total_value_eur: 80000, total_value_usd: 95000 });
    const ctx = makeCtx({ pastSnapshots: { "30d": snap }, adjustmentDeltas: [] });
    const result = getChangeForPeriod("30d", ctx);
    // Raw: (90000 - 80000) / 80000 = 12.5%
    expect(result.percent).toBeCloseTo(12.5, 1);
  });

  it("no adjustment when all deltas are after snapshot date", () => {
    const deltas = [makeDelta("2026-06-01", 10000, 8500)];
    const snap = makeSnapshot({ total_value_eur: 80000, total_value_usd: 95000 });
    snap.snapshot_date = "2026-01-01";
    const ctx = makeCtx({ pastSnapshots: { "30d": snap }, adjustmentDeltas: deltas });
    const result = getChangeForPeriod("30d", ctx);
    // cumAtSnapshot = 0, final = 8500, adjusted = 80000 + (8500 - 0) = 88500
    // (90000 - 88500) / 88500 ≈ 1.69%
    expect(result.percent).toBeCloseTo(1.69, 0);
  });

  it("returns unavailable when adjusted past value <= 0", () => {
    // Past = 5000, delta = 100000 → adjusted = 5000 + 100000 = 105000 > current 90000
    // But let's make it negative: past = -100, delta = 0
    const snap = makeSnapshot({ total_value_eur: 0 });
    const ctx = makeCtx({ pastSnapshots: { "7d": snap }, adjustmentDeltas: [] });
    const result = getChangeForPeriod("7d", ctx);
    expect(result.available).toBe(false);
  });

  it("24h period unaffected by deltas", () => {
    const deltas = [makeDelta("2026-01-01", 50000, 42500)];
    const ctx = makeCtx({ adjustmentDeltas: deltas });
    const result = getChangeForPeriod("24h", ctx);
    expect(result.percent).toBe(0.56); // unchanged from context
  });

  it("uses effective_date when delta has it before snapshot but created_at after", () => {
    // Delta's date is effective_date-based (already resolved by getAdjustmentDeltas)
    // Just verify forward-fill uses the date field correctly
    const deltas = [makeDelta("2025-12-15", 5000, 4250)]; // before snapshot
    const snap = makeSnapshot({ total_value_eur: 80000, total_value_usd: 95000 });
    snap.snapshot_date = "2026-01-01";
    const ctx = makeCtx({ pastSnapshots: { "30d": snap }, adjustmentDeltas: deltas });
    const result = getChangeForPeriod("30d", ctx);
    // cumAtSnapshot = 4250 (delta is before Jan 1), final = 4250
    // adjusted = 80000 + (4250 - 4250) = 80000 (no net adjustment)
    expect(result.percent).toBeCloseTo(12.5, 1);
  });
});
```

- [ ] **Step 2: Run tests — verify new tests fail**

Run: `npm test -- --reporter=verbose dashboard-changes`
Expected: New tests FAIL (no adjustment logic yet).

- [ ] **Step 3: Implement adjustment in `getChangeForPeriod`**

Modify `getChangeForPeriod` in `src/lib/portfolio/dashboard-changes.ts`:

```typescript
export function getChangeForPeriod(
  period: ChangePeriod,
  ctx: ChangeContext,
): ClassChange {
  if (period === "24h") {
    return {
      percent: ctx.change24hPercent,
      valueChange: ctx.totalValueChange24h,
      available: true,
      fxPercent: ctx.fxChange24hPercent,
      fxValueChange: ctx.fxValueChange24h,
    };
  }
  const snapshot = ctx.pastSnapshots[period];
  if (!snapshot) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };

  const deltas = ctx.adjustmentDeltas ?? [];
  const snapshotDate = snapshot.snapshot_date;
  const valueKey = ctx.primaryCurrency === "EUR" ? "total_value_eur" : "total_value_usd";
  const otherKey = ctx.primaryCurrency === "EUR" ? "total_value_usd" : "total_value_eur";
  const otherCurrency: BaseCurrency = ctx.primaryCurrency === "EUR" ? "USD" : "EUR";
  const currentValueOther = ctx.primaryCurrency === "EUR" ? ctx.totalValueUsd : ctx.totalValueEur;

  const rawPastValue = snapshot[valueKey] ?? 0;
  if (rawPastValue === 0) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };

  // Adjustment compensation: add back not-yet-imported value
  const cumAtSnapshot = getCumDeltaAtDate(snapshotDate, deltas, ctx.primaryCurrency);
  const finalCum = getCumDeltaFinal(deltas, ctx.primaryCurrency);
  const pastValue = rawPastValue + (finalCum - cumAtSnapshot);

  if (pastValue <= 0) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };

  const primaryReturn = ((ctx.totalValue - pastValue) / pastValue) * 100;

  // FX decomposition — also adjust the other currency past value
  const rawPastOther = snapshot[otherKey] ?? 0;
  const cumAtSnapshotOther = getCumDeltaAtDate(snapshotDate, deltas, otherCurrency);
  const finalCumOther = getCumDeltaFinal(deltas, otherCurrency);
  const pastOther = rawPastOther + (finalCumOther - cumAtSnapshotOther);

  let fxPct = 0;
  if (pastOther > 0 && currentValueOther > 0) {
    const otherReturn = ((currentValueOther - pastOther) / pastOther) * 100;
    fxPct = primaryReturn - otherReturn;
  }
  const fxAbs = fxPct !== 0 && fxPct > -100
    ? ctx.totalValue - ctx.totalValue / (1 + fxPct / 100)
    : 0;

  return {
    percent: primaryReturn,
    valueChange: ctx.totalValue - pastValue,
    available: true,
    fxPercent: fxPct,
    fxValueChange: fxAbs,
  };
}
```

- [ ] **Step 4: Run tests — verify all pass**

Run: `npm test -- --reporter=verbose dashboard-changes`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```
feat: apply adjustment compensation to getChangeForPeriod
```

---

### Task 3: Apply adjustment to per-class change functions

**Files:**
- Modify: `src/lib/portfolio/dashboard-changes.ts:158-238`
- Test: `__tests__/unit/dashboard-changes.test.ts`

- [ ] **Step 1: Write failing tests for adjusted per-class changes**

Add tests for `getCryptoChangeForPeriod`, `getStockChangeForPeriod`, `getCashChangeForPeriod` with adjustment deltas. Use class-specific cumulative fields in `makeDelta`:

```typescript
function makeClassDelta(date: string, opts: {
  cryptoUsd?: number; cryptoEur?: number;
  stocksUsd?: number; stocksEur?: number;
  cashUsd?: number; cashEur?: number;
}): AdjustmentDelta {
  return {
    date,
    cumulative_usd: (opts.cryptoUsd ?? 0) + (opts.stocksUsd ?? 0) + (opts.cashUsd ?? 0),
    cumulative_eur: (opts.cryptoEur ?? 0) + (opts.stocksEur ?? 0) + (opts.cashEur ?? 0),
    crypto_cumulative_usd: opts.cryptoUsd ?? 0,
    crypto_cumulative_eur: opts.cryptoEur ?? 0,
    stocks_cumulative_usd: opts.stocksUsd ?? 0,
    stocks_cumulative_eur: opts.stocksEur ?? 0,
    cash_cumulative_usd: opts.cashUsd ?? 0,
    cash_cumulative_eur: opts.cashEur ?? 0,
  };
}

describe("getCryptoChangeForPeriod with adjustment deltas", () => {
  it("adjusts past USD before passing to deriveClassFx", () => {
    const deltas = [makeClassDelta("2026-01-10", { cryptoUsd: 20000, cryptoEur: 17000 })];
    const snap = makeSnapshot({ crypto_value_usd: 10000 });
    const ctx = makeCtx({
      pastSnapshots: { "30d": snap },
      adjustmentDeltas: deltas,
    });
    const result = getCryptoChangeForPeriod("30d", ctx);
    expect(result.available).toBe(true);
    // adjustedPastUsd = 10000 + (20000 - 0) = 30000 (close to current ~31800)
    // Much smaller % than raw (10000 → 27000 = 170%)
    expect(Math.abs(result.percent)).toBeLessThan(20);
  });
});
```

- [ ] **Step 2: Run tests — verify fail**

- [ ] **Step 3: Implement adjustment in all 3 per-class functions**

For each of `getCryptoChangeForPeriod`, `getStockChangeForPeriod`, `getCashChangeForPeriod`:
- Extract `deltas = ctx.adjustmentDeltas ?? []` and `snapshotDate = snapshot.snapshot_date`
- Compute `adjustedPastUsd` using class-specific delta:
  ```typescript
  const rawPastUsd = snapshot.crypto_value_usd ?? 0; // (or stocks/cash)
  const cumAtSnapshot = getCumDeltaAtDate(snapshotDate, deltas, "USD", "crypto"); // 4th param = class
  const finalCum = getCumDeltaFinal(deltas, "USD", "crypto");
  const adjustedPastUsd = rawPastUsd + (finalCum - cumAtSnapshot);
  ```
- Pass `adjustedPastUsd` (not raw `pastUsd`) to `deriveClassFx`
- **No separate EUR-side adjustment needed** for per-class: `deriveClassFx` derives `pastClassEur` from `adjustedPastUsd × impliedRate`, so EUR is automatically adjusted. This differs from the total portfolio path (Task 2) where both currencies are adjusted independently — the per-class functions delegate EUR derivation to `deriveClassFx`.

- [ ] **Step 4: Run tests — verify all pass**

Run: `npm test -- --reporter=verbose dashboard-changes`

- [ ] **Step 5: Commit**

```
feat: apply adjustment compensation to per-class period change functions
```

---

### Task 4: Wire `adjustmentDeltas` through dashboard and share pages

**Files:**
- Modify: `src/app/dashboard/page.tsx`
- Modify: `src/app/share/[token]/page.tsx`
- Modify: `src/components/dashboard/dashboard-grid.tsx`

- [ ] **Step 1: Add `adjustmentDeltas` prop to `DashboardGrid`**

In `src/components/dashboard/dashboard-grid.tsx`:
- Add `adjustmentDeltas?: AdjustmentDelta[]` to `DashboardGridProps`
- Thread it into `changeCtx`: `adjustmentDeltas: adjustmentDeltas ?? []`
- Add import for `AdjustmentDelta` from `@/lib/types`

- [ ] **Step 2: Pass `adjustmentDeltas` from dashboard page**

In `src/app/dashboard/page.tsx`, find where `DashboardGrid` is rendered and add:
`adjustmentDeltas={adjustmentDeltas}`

(The `adjustmentDeltas` variable already exists in this file — it's destructured from `Promise.all`.)

- [ ] **Step 3: Pass `adjustmentDeltas` from share page**

In `src/app/share/[token]/page.tsx`, same pattern.

- [ ] **Step 4: Verify locally**

Run: `npm run build` — should compile without errors.
Run: `npm test` — all existing tests should still pass.

- [ ] **Step 5: Commit**

```
feat: wire adjustmentDeltas through dashboard and share pages to DashboardGrid
```

---

## Phase 2: Schema & Type Foundation (Feature 2)

### Task 5: Migration and types

**Files:**
- Create: `supabase/migrations/011_effective_date_and_splits.sql`
- Modify: `src/lib/types.ts:581-607`
- Test: `__tests__/integration/effective-date.test.ts`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/011_effective_date_and_splits.sql`:
```sql
-- Migration 011: Support for backdated entries and entry splitting
-- Adds trade-date vs entry-date distinction and parent-child split relationships

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

- [ ] **Step 2: Add fields to `ActivityLog` type**

In `src/lib/types.ts`, add to the `ActivityLog` interface (after `created_at`):
```typescript
effective_date?: string | null;
split_from_id?: string | null;
```

- [ ] **Step 3: Write integration tests**

Create `__tests__/integration/effective-date.test.ts` with all 8 spec test cases:
1. `effective_date` column accepts valid DATE
2. `split_from_id` FK constraint — must reference existing activity_log row
3. `split_from_id` to non-existent row — FK violation
4. `split_from_id != id` CHECK — self-reference blocked
5. ON DELETE CASCADE — deleting parent deletes children
6. Cascade with 3 children — all 4 rows removed
7. Children visible through RLS — same `user_id` scoping
8. Cross-user child creation blocked — RLS prevents inserting with wrong `user_id`

- [ ] **Step 4: Run integration tests**

Run: `npm run test:integration -- effective-date`
Expected: All PASS (requires local Supabase with `supabase db reset` to apply migration 011).

- [ ] **Step 5: Commit**

```
feat: add effective_date and split_from_id columns to activity_log (migration 011)
```

---

### Task 6: Universal date COALESCE in pipelines

**Files:**
- Modify: `src/lib/actions/activity-log.ts:386-489` (`getAdjustmentDeltas`)
- Modify: `src/lib/actions/benchmark.ts:19-75` (`deriveCashFlows`)
- Modify: `src/lib/actions/activity-log.ts:49-103` (`logActivity`)
- Modify: `src/lib/actions/activity-log.ts:280-340` (`toggleActivityAdjustment`)
- Modify: `src/lib/actions/backfill.ts` (both queries)
- Modify: `src/lib/actions/activity-log.ts:493-530` (`exportActivityLogsCsv`)

- [ ] **Step 1: Update `getAdjustmentDeltas`**

In `src/lib/actions/activity-log.ts`:
1. Add `effective_date` to the `.select()` string (line ~414)
2. After fetching `data`, post-sort by effective date:
```typescript
const sorted = [...data].sort((a, b) => {
  const dateA = (a.effective_date as string) ?? (a.created_at as string).split("T")[0];
  const dateB = (b.effective_date as string) ?? (b.created_at as string).split("T")[0];
  return dateA.localeCompare(dateB);
});
```
3. Use `sorted` instead of `data` in the iteration loop
4. Change date extraction (line ~469) to: `const date = (row.effective_date as string) ?? (row.created_at as string).split("T")[0];`

- [ ] **Step 2: Update `deriveCashFlows`**

In `src/lib/actions/benchmark.ts`:
1. Add `effective_date` to the `.select()` string (line ~32)
2. After fetching `data`, post-sort:
```typescript
const sorted = [...(data ?? [])].sort((a, b) => {
  const dateA = (a.effective_date as string) ?? (a.created_at as string).split("T")[0];
  const dateB = (b.effective_date as string) ?? (b.created_at as string).split("T")[0];
  return dateA.localeCompare(dateB);
});
```
3. Use `sorted` in the `.map()` at line ~65
4. Change date extraction to: `date: (row.effective_date as string) ?? (row.created_at as string).split("T")[0]`

- [ ] **Step 3: Update `logActivity` to accept `effective_date`**

In `src/lib/actions/activity-log.ts`:
1. Add `effective_date?: string;` to params type
2. Add to insert object: `...(params.effective_date ? { effective_date: params.effective_date } : {})`

- [ ] **Step 4: Update `toggleActivityAdjustment` (BOTH call sites)**

There are two branches that pass `row.created_at` to `computeDeltaFromSnapshots`:
1. The toggle-ON branch (line ~307): `computeDeltaFromSnapshots(..., row.created_at, ...)`
2. The toggle-OFF branch (line ~334): `computeDeltaFromSnapshots(..., row.created_at, ...)`

Change BOTH to: `(row.effective_date as string) ?? (row.created_at as string)`

The query fetching the row must also include `effective_date` in its SELECT.

- [ ] **Step 5: Update `backfillCashflowsAndDeltas` and `backfillSingleRow`**

In `src/lib/actions/backfill.ts`:
1. Add `effective_date` to both SELECT strings
2. Change all `(row.created_at as string).split("T")[0]` to `(row.effective_date as string) ?? (row.created_at as string).split("T")[0]`

- [ ] **Step 6: Update `exportActivityLogsCsv`**

Add `effective_date` and `split_from_id` to the CSV headers array and row mapping.

- [ ] **Step 7: Add test for toggleActivityAdjustment with effective_date**

The `toggleActivityAdjustment` function computes historical prices at the entry's date.
With `effective_date` set, it must use that date instead of `created_at`. Add a test to
`__tests__/unit/split-logic.test.ts` (or a new toggle test file) that verifies the date
passed to `computeDeltaFromSnapshots` uses `effective_date` when present.

- [ ] **Step 8: Run full test suite**

Run: `npm run test:all`
Expected: All tests PASS (COALESCE defaults to `created_at` for existing entries with null `effective_date`).

- [ ] **Step 9: Commit**

```
feat: COALESCE effective_date in all pipeline date sources
```

---

## Phase 3: Split Server Actions

### Task 7: `backdateActivityEntry` server action

**Files:**
- Create: `src/lib/actions/splits.ts`
- Test: `__tests__/unit/split-logic.test.ts` (validation logic extracted as pure functions)

- [ ] **Step 1: Write validation tests**

Create `__tests__/unit/split-logic.test.ts` with pure function tests for `validateBackdate` and `validateSplitLegs`:
- Valid past date accepted
- Future date rejected
- Today accepted
- Invalid date string rejected

- [ ] **Step 2: Implement `backdateActivityEntry`**

Create `src/lib/actions/splits.ts`:
```typescript
"use server";
// backdateActivityEntry, splitActivityEntry, unsplitActivityEntry
```

- [ ] **Step 3: Run tests, commit**

```
feat: add backdateActivityEntry server action
```

---

### Task 8: `splitActivityEntry` server action

**Files:**
- Modify: `src/lib/actions/splits.ts`
- Test: `__tests__/unit/split-logic.test.ts`

- [ ] **Step 1: Write validation tests for split legs**

Add to `split-logic.test.ts`:
- Fraction computation (0.25/0.5 = 0.5)
- Rounding safety — last child gets remainder
- Fractions > 1.0 rejected
- Zero quantity rejected
- < 2 dates rejected
- Duplicate dates rejected
- Splitting child/compensation/transfer blocked
- Pending status blocked
- Delta-only vs cashflow-only distribution

- [ ] **Step 2: Implement `splitActivityEntry`**

Extract quantity from snapshot (entity-type-aware), compute fractions, create children, mark parent undone. Use single Supabase insert for all children.

- [ ] **Step 3: Run tests, commit**

```
feat: add splitActivityEntry server action
```

---

### Task 9: `unsplitActivityEntry` and undo integration

**Files:**
- Modify: `src/lib/actions/splits.ts`
- Modify: `src/lib/actions/undo.ts:439-522`

- [ ] **Step 1: Implement `unsplitActivityEntry`**

Hard-delete children, clear parent's `undone_at`.

- [ ] **Step 2: Add split-aware routing to `undoActivity`**

Add checks BEFORE the `undone_at` guard:
1. Check for split children → unsplit
2. Check if IS a child → redirect to parent unsplit

- [ ] **Step 3: Test manually with local Supabase**

- [ ] **Step 4: Commit**

```
feat: add unsplitActivityEntry and split-aware undo routing
```

---

## Phase 4: Timeline UI

### Task 10: Effective date annotation and split grouping

**Files:**
- Modify: `src/components/history/activity-timeline.tsx`
- Modify: `src/lib/actions/activity-log.ts` (`getActivityLogs`)
- Test: `__tests__/component/activity-timeline-split.test.ts`

- [ ] **Step 1: Exclude split children from `getActivityLogs` and fetch them separately**

In `src/lib/actions/activity-log.ts`, modify `getActivityLogs`:
1. Add `.is("split_from_id", null)` to the main query (children excluded from pagination)
2. Add a new exported function `getSplitChildren(parentIds: string[])`:
```typescript
export async function getSplitChildren(parentIds: string[]): Promise<ActivityLog[]> {
  if (parentIds.length === 0) return [];
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("activity_log")
    .select("*")
    .in("split_from_id", parentIds)
    .is("undone_at", null)
    .order("effective_date", { ascending: true });
  return (data ?? []) as ActivityLog[];
}
```
3. The history page (`src/app/dashboard/history/page.tsx`) calls `getSplitChildren` with the IDs of split parents in the current page and passes the result as a `splitChildren: ActivityLog[]` prop to the timeline.
4. The timeline's `groupSplits` function matches children to parents via `split_from_id` to build `{ type: "split"; parent; children }` items.

- [ ] **Step 2: Add `"split"` variant to `TimelineItem`**

Extend grouping logic: after `groupTransfers`, check for entries that have children (matched via `split_from_id`).

- [ ] **Step 3: Render effective date annotation**

When `log.effective_date` differs from `log.created_at` date, show sky-blue annotation.

- [ ] **Step 4: Render split parent/child display**

Violet "Split" badge, expand/collapse chevron, child allocations list.

- [ ] **Step 5: Add Calendar/GitBranch/Merge action buttons**

Calendar → date picker popover → `backdateActivityEntry`
GitBranch → opens split modal
Merge → confirm → `unsplitActivityEntry`

- [ ] **Step 6: Write component tests**

- [ ] **Step 7: Commit**

```
feat: timeline split grouping, effective date annotation, and action buttons
```

---

### Task 11: Split modal component

**Files:**
- Create: `src/components/history/split-modal.tsx`
- Test: `__tests__/component/split-modal.test.ts`

- [ ] **Step 1: Build split modal**

FocusTrap, date picker per leg, quantity input, live remaining counter, validation.

- [ ] **Step 2: Write component tests**

Modal renders, adding legs updates remaining, exceeding original shows error, submit disabled with < 2 dates, date picker excludes future.

- [ ] **Step 3: Commit**

```
feat: add split modal component for entry splitting
```

---

## Phase 5: Effective Date in Modals & Import

### Task 12: Optional effective date field in add/import modals

**Files:**
- Modify: `src/components/crypto/add-crypto-modal.tsx`
- Modify: `src/components/stocks/add-stock-modal.tsx`
- Modify: `src/components/cash/cash-account-modal.tsx`
- Modify: `src/components/crypto/position-editor.tsx`
- Modify: `src/components/stocks/stock-position-editor.tsx`
- Modify: `src/lib/actions/import.ts`

- [ ] **Step 1: Add effective date field to crypto modal**

Optional date input, empty by default. Thread through to CRUD → `logActivity({ effective_date })`.

- [ ] **Step 2: Repeat for stock, cash, position editor modals**

Same pattern × 4 remaining modals.

- [ ] **Step 3: Thread effective_date in import.ts**

`import.ts` inserts activity_log entries directly via Supabase (not through `logActivity`).
Two changes needed:
1. When restoring from backup JSON, include `effective_date` in the insert object if present in the backup data (the backup JSON may have `effective_date: "2025-01-05"` or `null`)
2. When the import creates new CRUD operations (via `upsertPosition`, `createBankAccount`, etc.), the CRUD functions already call `logActivity` — the `effective_date` param added in Task 6 Step 3 enables this path automatically

For the backup restore path, find the `activity_log` bulk insert and add:
```typescript
effective_date: entry.effective_date ?? null,
split_from_id: entry.split_from_id ?? null,
```

- [ ] **Step 4: Update export CSV**

Verify `exportActivityLogsCsv` (already done in Task 6) includes `effective_date` for round-trip.

- [ ] **Step 5: Run full test suite**

Run: `npm run test:all`

- [ ] **Step 6: Commit**

```
feat: optional effective date field in add/import modals and backup round-trip
```

---

## Phase 6: Final Verification

### Task 13: Full integration test and build

- [ ] **Step 1: Run all tests**

```bash
npm run test:all
```

- [ ] **Step 2: Run build**

```bash
npm run build
```

- [ ] **Step 3: Run lint**

```bash
npm run lint
```

- [ ] **Step 4: Manual verification with local Supabase**

1. `supabase db reset` to apply migration 011
2. `npm run dev`
3. Verify period percentages show adjusted values (not inflated by imports)
4. Test backdating an entry from the timeline
5. Test splitting an entry
6. Test unsplitting
7. Verify S&P benchmark responds to effective_date changes

- [ ] **Step 5: Commit any fixes**

```
fix: address issues found during final verification
```
