# Pre-Computed Cashflows Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 388-line `deriveCashFlows()` function (13 API calls per page load) with pre-computed values stored on `activity_log` at write time, reducing page load from 3-6s to ~2ms.

**Architecture:** Add 7 columns to `activity_log` for cashflow/delta values and status tracking. Compute values at mutation time using prices already available from client components. Backfill legacy rows via self-healing function. Replace old `deriveCashFlows()` with a single DB query.

**Tech Stack:** Next.js 16 (App Router), Supabase PostgreSQL, TypeScript, React 19, Vitest

**Spec:** `docs/superpowers/specs/2026-03-14-precomputed-cashflows-design.md`

---

## File Structure

### New files
| File | Purpose |
|------|---------|
| `supabase/migrations/002_cashflow_columns.sql` | Migration: 7 columns + 2 indexes + legacy delta fixup |
| `src/lib/actions/backfill.ts` | Server action: backfill pending cashflows/deltas |
| `src/lib/cashflow.ts` | Pure helpers: `computeCashflow()`, `classifyAssetClass()` |
| `src/components/ui/cashflow-status-icon.tsx` | Shared icon component for pending/failed status |
| `src/components/dashboard/chart-warning-banner.tsx` | Inline banner for pending/failed cashflows near chart |
| `__tests__/unit/cashflow.test.ts` | Unit tests for pure cashflow computation helpers |
| `__tests__/unit/derive-cashflows-db.test.ts` | Unit tests for new DB-only deriveCashFlows |
| `__tests__/component/chart-warning-banner.test.tsx` | Component tests for chart warning banner |
| `__tests__/component/cashflow-status-icon.test.tsx` | Component tests for status icon |

### Modified files
| File | What changes |
|------|-------------|
| `src/lib/types.ts` | Add 7 fields to `ActivityLog` interface |
| `src/lib/actions/activity-log.ts` | Extend `logActivity()` params + `toggleActivityAdjustment()` cashflow/delta swap |
| `src/lib/actions/undo.ts` | Clear cashflow/delta status on undo |
| `src/lib/actions/crypto.ts` | Add cashflow computation to `upsertPosition()` + `deletePosition()` |
| `src/lib/actions/stocks.ts` | Add cashflow computation to `upsertStockPosition()` + `deleteStockPosition()` |
| `src/lib/actions/broker-deposits.ts` | Add cashflow computation + `fxRate` opt to all 3 mutations |
| `src/lib/actions/exchange-deposits.ts` | Add cashflow computation + `fxRate` opt to all 3 mutations |
| `src/lib/actions/bank-accounts.ts` | Add cashflow computation + `fxRate` opt to all 3 mutations |
| `src/lib/actions/benchmark.ts` | Replace `deriveCashFlows()` body (~370 lines → ~40 lines) |
| `src/components/cash/broker-deposit-modal.tsx` | Accept + pass `fxRate` prop |
| `src/components/cash/exchange-deposit-modal.tsx` | Accept + pass `fxRate` prop |
| `src/components/cash/bank-account-modal.tsx` | Accept + pass `fxRate` prop |
| `src/components/cash/cash-table.tsx` | Extract EUR/USD rate, pass to modals |
| `src/components/accounts/accounts-view.tsx` | Accept EUR/USD rate, pass to all 3 cash modals |
| `src/app/dashboard/accounts/page.tsx` | Fetch EUR/USD rate, pass to accounts view |
| `src/components/history/activity-timeline.tsx` | Add status icons per row |
| `src/components/dashboard/portfolio-chart.tsx` | Accept + render chart warning banner |
| `src/app/dashboard/page.tsx` | Destructure new `deriveCashFlows()` return |
| `src/app/dashboard/crypto/page.tsx` | Same destructuring |
| `src/app/dashboard/stocks/page.tsx` | Same destructuring |
| `src/app/dashboard/cash/page.tsx` | Same destructuring |
| `src/app/share/[token]/page.tsx` | Same destructuring |
| `src/app/share/[token]/crypto/page.tsx` | Same destructuring |
| `src/app/share/[token]/stocks/page.tsx` | Same destructuring |
| `src/app/share/[token]/cash/page.tsx` | Same destructuring |

---

## Chunk 1: Foundation — Migration, Types, logActivity, Pure Helpers

### Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/002_cashflow_columns.sql`

- [ ] **Step 1: Write migration file**

```sql
-- 002_cashflow_columns.sql
-- Pre-computed cashflow and delta status tracking on activity_log

-- New columns for cashflow values
ALTER TABLE activity_log ADD COLUMN cashflow_amount_usd NUMERIC(18,2);
ALTER TABLE activity_log ADD COLUMN cashflow_amount_eur NUMERIC(18,2);
ALTER TABLE activity_log ADD COLUMN cashflow_asset_class TEXT;
ALTER TABLE activity_log ADD COLUMN cashflow_status TEXT;
ALTER TABLE activity_log ADD COLUMN delta_status TEXT;
ALTER TABLE activity_log ADD COLUMN cashflow_attempted_at TIMESTAMPTZ;
ALTER TABLE activity_log ADD COLUMN delta_attempted_at TIMESTAMPTZ;

-- Partial indexes for backfill queries
CREATE INDEX idx_activity_log_pending_cashflows
  ON activity_log (user_id) WHERE cashflow_status = 'pending';
CREATE INDEX idx_activity_log_pending_deltas
  ON activity_log (user_id) WHERE delta_status = 'pending';

-- Seed delta_status = 'pending' for legacy adjustment rows with NULL deltas
-- (FX failures before status tracking existed). Without this, backfill won't find them.
UPDATE activity_log
SET delta_status = 'pending'
WHERE is_adjustment = true
  AND delta_usd IS NULL
  AND delta_status IS NULL
  AND undone_at IS NULL
  AND entity_type IN (
    'crypto_position', 'stock_position',
    'exchange_deposit', 'broker_deposit', 'bank_account'
  );
```

- [ ] **Step 2: Apply migration locally**

Run: `supabase db reset` (if local Supabase running) or `supabase migration up`
Expected: Migration applies cleanly, 7 columns added

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/002_cashflow_columns.sql
git commit -m "feat: add cashflow/delta status columns to activity_log"
```

---

### Task 2: TypeScript Types

**Files:**
- Modify: `src/lib/types.ts:524-543` (ActivityLog interface)

- [ ] **Step 1: Add 7 new fields to ActivityLog**

In `src/lib/types.ts`, extend the `ActivityLog` interface to add the new columns after `compensates_for`:

```typescript
// Add after line 541 (compensates_for: string | null;)
  cashflow_amount_usd: number | null;
  cashflow_amount_eur: number | null;
  cashflow_asset_class: string | null;
  cashflow_status: string | null;
  delta_status: string | null;
  cashflow_attempted_at: string | null;
  delta_attempted_at: string | null;
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors (existing code doesn't reference these fields yet)

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add cashflow/delta status fields to ActivityLog type"
```

---

### Task 3: Pure Cashflow Computation Helpers

**Files:**
- Create: `src/lib/cashflow.ts`
- Create: `__tests__/unit/cashflow.test.ts`

These are pure functions (no DB, no async) extracted for testability — same pattern as `src/lib/deltas.ts`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/unit/cashflow.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  computeCashflowFromPrices,
  classifyAssetClass,
} from "@/lib/cashflow";

describe("computeCashflowFromPrices", () => {
  it("crypto buy — positive cashflow (money entered portfolio)", () => {
    const result = computeCashflowFromPrices({
      action: "created",
      beforeQty: 0,
      afterQty: 0.5,
      priceUsd: 100000,
      priceEur: 92000,
    });
    expect(result).toEqual({ usd: 50000, eur: 46000 });
  });

  it("crypto sell — negative cashflow (money left portfolio)", () => {
    const result = computeCashflowFromPrices({
      action: "removed",
      beforeQty: 0.5,
      afterQty: 0,
      priceUsd: 100000,
      priceEur: 92000,
    });
    expect(result).toEqual({ usd: -50000, eur: -46000 });
  });

  it("crypto update — difference in qty × price", () => {
    const result = computeCashflowFromPrices({
      action: "updated",
      beforeQty: 0.3,
      afterQty: 0.5,
      priceUsd: 100000,
      priceEur: 92000,
    });
    expect(result).toEqual({ usd: 20000, eur: 18400 });
  });

  it("cash entity EUR — uses fxRate for conversion", () => {
    const result = computeCashflowFromPrices({
      action: "created",
      beforeQty: 0,
      afterQty: 1000,
      entityCurrency: "EUR",
      fxRate: 1.08,
    });
    expect(result.usd).toBeCloseTo(1080);
    expect(result.eur).toBe(1000);
  });

  it("cash entity USD — uses fxRate for EUR conversion", () => {
    const result = computeCashflowFromPrices({
      action: "created",
      beforeQty: 0,
      afterQty: 1000,
      entityCurrency: "USD",
      fxRate: 1.08,
    });
    expect(result.usd).toBe(1000);
    expect(result.eur).toBeCloseTo(925.93, 1);
  });

  it("zero qty change — returns zero", () => {
    const result = computeCashflowFromPrices({
      action: "updated",
      beforeQty: 5,
      afterQty: 5,
      priceUsd: 100,
      priceEur: 92,
    });
    expect(result).toEqual({ usd: 0, eur: 0 });
  });
});

describe("classifyAssetClass", () => {
  it("crypto_position → crypto", () => {
    expect(classifyAssetClass("crypto_position")).toBe("crypto");
  });

  it("crypto_position with stablecoin → cash", () => {
    expect(classifyAssetClass("crypto_position", true)).toBe("cash");
  });

  it("stock_position → stocks", () => {
    expect(classifyAssetClass("stock_position")).toBe("stocks");
  });

  it("bank_account → cash", () => {
    expect(classifyAssetClass("bank_account")).toBe("cash");
  });

  it("exchange_deposit → cash", () => {
    expect(classifyAssetClass("exchange_deposit")).toBe("cash");
  });

  it("broker_deposit → cash", () => {
    expect(classifyAssetClass("broker_deposit")).toBe("cash");
  });

  it("crypto_asset → null (no cashflow)", () => {
    expect(classifyAssetClass("crypto_asset")).toBeNull();
  });

  it("wallet → null", () => {
    expect(classifyAssetClass("wallet")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --reporter=verbose __tests__/unit/cashflow.test.ts`
Expected: FAIL — module `@/lib/cashflow` not found

- [ ] **Step 3: Write the implementation**

Create `src/lib/cashflow.ts`:

```typescript
/**
 * Pure cashflow computation helpers — no DB, no async, no "use server".
 * Companion to src/lib/deltas.ts (same pattern: extracted for testability).
 */

import { positionQtyDelta, cashDelta } from "@/lib/deltas";
import type { AssetClass } from "@/lib/actions/benchmark";

/**
 * Compute cashflow USD/EUR values from prices already available at write time.
 *
 * Two modes:
 * 1. Position entities (crypto/stock): pass priceUsd + priceEur
 * 2. Cash entities (bank/deposit): pass entityCurrency + fxRate (EUR/USD)
 */
export function computeCashflowFromPrices(params: {
  action: string;
  beforeQty: number;
  afterQty: number;
  /** For position entities: USD price per unit */
  priceUsd?: number;
  /** For position entities: EUR price per unit */
  priceEur?: number;
  /** For cash entities: the entity's native currency */
  entityCurrency?: string;
  /** EUR/USD rate (e.g., 1.08 = 1 EUR buys 1.08 USD) */
  fxRate?: number;
}): { usd: number; eur: number } {
  const { action, beforeQty, afterQty } = params;

  // Position mode: qty × price
  if (params.priceUsd != null || params.priceEur != null) {
    const delta = positionQtyDelta(action, beforeQty, afterQty);
    return {
      usd: delta * (params.priceUsd ?? 0),
      eur: delta * (params.priceEur ?? 0),
    };
  }

  // Cash mode: amount delta × FX conversion
  const delta = cashDelta(action, beforeQty, afterQty);
  const fxRate = params.fxRate ?? 1;
  const currency = params.entityCurrency ?? "USD";

  if (currency === "EUR") {
    return { usd: delta * fxRate, eur: delta };
  }
  if (currency === "USD") {
    return { usd: delta, eur: fxRate > 0 ? delta / fxRate : delta };
  }
  // Other currencies: not expected in this codebase (EUR/USD only)
  return { usd: delta, eur: delta };
}

/**
 * Map entity_type to asset class for cashflow classification.
 * Returns null for entity types that don't produce cashflows.
 */
export function classifyAssetClass(
  entityType: string,
  isStablecoin?: boolean
): AssetClass | null {
  if (entityType === "crypto_position") {
    return isStablecoin ? "cash" : "crypto";
  }
  if (entityType === "stock_position") return "stocks";
  if (
    entityType === "bank_account" ||
    entityType === "exchange_deposit" ||
    entityType === "broker_deposit"
  ) {
    return "cash";
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --reporter=verbose __tests__/unit/cashflow.test.ts`
Expected: All 14 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/cashflow.ts __tests__/unit/cashflow.test.ts
git commit -m "feat: add pure cashflow computation helpers with tests"
```

---

### Task 4: Extend `logActivity()` Signature

**Files:**
- Modify: `src/lib/actions/activity-log.ts:49-92` (logActivity function)

- [ ] **Step 1: Add new parameters to logActivity**

In `src/lib/actions/activity-log.ts`, extend the `logActivity` params type (after `created_at?: string;` on line 63):

```typescript
  // Cashflow tracking (pre-computed at write time)
  cashflow_amount_usd?: number | null;
  cashflow_amount_eur?: number | null;
  cashflow_asset_class?: string | null;
  cashflow_status?: "complete" | "pending" | null;
  delta_status?: "complete" | "pending" | null;
```

Then in the insert object (after the `created_at` spread on line 87), add:

```typescript
      cashflow_amount_usd: params.cashflow_amount_usd ?? null,
      cashflow_amount_eur: params.cashflow_amount_eur ?? null,
      cashflow_asset_class: params.cashflow_asset_class ?? null,
      cashflow_status: params.cashflow_status ?? null,
      delta_status: params.delta_status ?? null,
```

Note: `cashflow_attempted_at` and `delta_attempted_at` are NOT included in `logActivity()` — these timestamps are only written by the backfill function (Task 13) via direct Supabase updates, not through the activity logging path.

- [ ] **Step 2: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors (all new fields are optional, existing callers unchanged)

- [ ] **Step 3: Commit**

```bash
git add src/lib/actions/activity-log.ts
git commit -m "feat: extend logActivity with cashflow/delta status fields"
```

---

### Task 5: Extend `toggleActivityAdjustment()` — Cashflow/Delta Swap

**Files:**
- Modify: `src/lib/actions/activity-log.ts:261-298` (toggleActivityAdjustment)

When toggling a row's adjustment flag, cashflow and delta semantics invert. This is the most complex single change.

- [ ] **Step 1: Refactor toggleActivityAdjustment**

Replace the current `toggleActivityAdjustment` function body (lines 261-298) with the extended version that swaps cashflow/delta values:

```typescript
export async function toggleActivityAdjustment(
  logId: string,
  isAdjustment: boolean
): Promise<void> {
  validateUUID(logId, "Activity log ID");
  const supabase = await createServerSupabaseClient();

  // Fetch full row to access snapshots
  const { data: row, error: fetchErr } = await supabase
    .from("activity_log")
    .select("*")
    .eq("id", logId)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);
  if (!row) throw new Error("Activity log entry not found");

  let deltaUsd: number | null = null;
  let deltaEur: number | null = null;
  let deltaStatus: string | null = null;
  let cashflowUsd: number | null = null;
  let cashflowEur: number | null = null;
  let cashflowAssetClass: string | null = null;
  let cashflowStatus: string | null = null;

  if (isAdjustment) {
    // Toggling ON (becomes adjustment) → compute delta, clear cashflow
    try {
      const deltas = await computeDeltaFromSnapshots(
        row.entity_type,
        row.action,
        row.created_at,
        row.before_snapshot as Record<string, unknown> | null,
        row.after_snapshot as Record<string, unknown> | null
      );
      deltaUsd = Math.round(deltas.usd * 100) / 100;
      deltaEur = Math.round(deltas.eur * 100) / 100;
      deltaStatus = "complete";
    } catch (err) {
      console.error("[activity-log] Delta computation failed on toggle:", err instanceof Error ? err.message : err);
      deltaStatus = "pending";
    }
    // Clear cashflow (no longer a real money flow)
    cashflowUsd = null;
    cashflowEur = null;
    cashflowAssetClass = null;
    cashflowStatus = null;
  } else {
    // Toggling OFF (becomes non-adjustment) → compute cashflow, clear delta
    try {
      const values = await computeDeltaFromSnapshots(
        row.entity_type,
        row.action,
        row.created_at,
        row.before_snapshot as Record<string, unknown> | null,
        row.after_snapshot as Record<string, unknown> | null
      );
      cashflowUsd = Math.round(values.usd * 100) / 100;
      cashflowEur = Math.round(values.eur * 100) / 100;

      // Determine asset class
      const { classifyAssetClass } = await import("@/lib/cashflow");
      // Check stablecoin status for crypto positions
      let isStablecoin = false;
      if (row.entity_type === "crypto_position") {
        const snap = (row.after_snapshot ?? row.before_snapshot) as Record<string, unknown> | null;
        const assetId = snap?.crypto_asset_id as string | undefined;
        if (assetId) {
          const { data: asset } = await supabase
            .from("crypto_assets")
            .select("subcategory")
            .eq("id", assetId)
            .single();
          isStablecoin = asset?.subcategory?.toLowerCase() === "stablecoin";
        }
      }
      cashflowAssetClass = classifyAssetClass(row.entity_type, isStablecoin);
      cashflowStatus = "complete";
    } catch (err) {
      console.error("[activity-log] Cashflow computation failed on toggle:", err instanceof Error ? err.message : err);
      cashflowStatus = "pending";
    }
    // Clear delta (no longer an adjustment)
    deltaUsd = null;
    deltaEur = null;
    deltaStatus = null;
  }

  const { error } = await supabase
    .from("activity_log")
    .update({
      is_adjustment: isAdjustment,
      delta_usd: deltaUsd,
      delta_eur: deltaEur,
      delta_status: deltaStatus,
      cashflow_amount_usd: cashflowUsd,
      cashflow_amount_eur: cashflowEur,
      cashflow_asset_class: cashflowAssetClass,
      cashflow_status: cashflowStatus,
    })
    .eq("id", logId);
  if (error) throw new Error(error.message);
}
```

- [ ] **Step 2: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/actions/activity-log.ts
git commit -m "feat: swap cashflow/delta values on adjustment toggle"
```

---

### Task 6: Verify Undo Handles Cashflow/Delta Status Correctly

**Files:**
- Verify: `src/lib/actions/undo.ts` (no changes needed)

The undo mechanism sets `undone_at` on the row. The new `deriveCashFlows()` already filters `undone_at IS NULL`, so undone rows are excluded regardless of their cashflow/delta status. **Do NOT clear status fields on undo** — if the undo is later reversed (un-undo sets `undone_at: null`), the row must retain its original status to reappear in cashflow results. Clearing status would cause permanent data loss on undo/redo cycles.

- [ ] **Step 1: Verify the `undone_at IS NULL` filter exists in the new deriveCashFlows**

Confirm Task 11's new `deriveCashFlows()` includes `.is("undone_at", null)`. This is the primary guard — no status clearing needed.

- [ ] **Step 2: Commit (no changes — verification only)**

No commit needed. This task is a design verification checkpoint.

---

## Chunk 2: Write Path — Action Files, Cash Modal Plumbing, Delta Status Retrofit

### Task 7: Crypto Actions — Write-Time Cashflow

**Files:**
- Modify: `src/lib/actions/crypto.ts`

Crypto is the simplest case: no FX conversion needed (prices in USD/EUR passed directly). No try/catch for FX failures.

- [ ] **Step 1: Add cashflow computation to `upsertPosition()` — removal branch**

In `crypto.ts`, find the removal branch of `upsertPosition()` (around line 279-301). Currently:

```typescript
      let deltaUsd: number | null = null;
      let deltaEur: number | null = null;
      if (opts?.isAdjustment && (opts.currentPriceUsd || opts.currentPriceEur)) {
        const qty = (existing.quantity as number) ?? 0;
        deltaUsd = -(qty * (opts.currentPriceUsd ?? 0));
        deltaEur = -(qty * (opts.currentPriceEur ?? 0));
      }
```

Replace with:

```typescript
      let deltaUsd: number | null = null;
      let deltaEur: number | null = null;
      let cashflowUsd: number | null = null;
      let cashflowEur: number | null = null;
      let cashflowAssetClass: string | null = null;
      let cashflowStatus: "complete" | "pending" | null = null;
      let deltaStatus: "complete" | "pending" | null = null;

      if (opts?.currentPriceUsd || opts?.currentPriceEur) {
        const qty = (existing.quantity as number) ?? 0;
        const valUsd = -(qty * (opts.currentPriceUsd ?? 0));
        const valEur = -(qty * (opts.currentPriceEur ?? 0));

        if (opts?.isAdjustment) {
          deltaUsd = valUsd;
          deltaEur = valEur;
          deltaStatus = "complete";
        } else {
          const { classifyAssetClass } = await import("@/lib/cashflow");
          cashflowUsd = valUsd;
          cashflowEur = valEur;
          cashflowAssetClass = classifyAssetClass("crypto_position", false);
          cashflowStatus = "complete";
        }
      }
```

Then update the `logActivity` call to include the new fields:

```typescript
      await logActivity({
        action: "removed",
        entity_type: "crypto_position",
        entity_name: ticker,
        description: `Removed ${ticker} position (qty set to 0)`,
        entity_id: existing.id,
        entity_table: "crypto_positions",
        before_snapshot: existing,
        after_snapshot: null,
        is_adjustment: opts?.isAdjustment,
        delta_usd: deltaUsd,
        delta_eur: deltaEur,
        delta_status: deltaStatus,
        cashflow_amount_usd: cashflowUsd,
        cashflow_amount_eur: cashflowEur,
        cashflow_asset_class: cashflowAssetClass,
        cashflow_status: cashflowStatus,
        transfer_group_id: opts?.transferGroupId,
        created_at: opts?.effectiveDate,
      });
```

- [ ] **Step 2: Add cashflow computation to `upsertPosition()` — upsert branch**

Find the upsert branch delta computation (around line 364-372). Currently:

```typescript
    let deltaUsd: number | null = null;
    let deltaEur: number | null = null;
    if (opts?.isAdjustment && (opts.currentPriceUsd || opts.currentPriceEur)) {
      const beforeQty = (before?.quantity as number) ?? 0;
      const afterQty = input.quantity;
      const qtyDelta = afterQty - beforeQty;
      deltaUsd = qtyDelta * (opts.currentPriceUsd ?? 0);
      deltaEur = qtyDelta * (opts.currentPriceEur ?? 0);
    }
```

Replace with same pattern as removal branch but using `positionQtyDelta` semantics (the existing code already computes the correct sign via afterQty - beforeQty for "updated", which matches):

```typescript
    let deltaUsd: number | null = null;
    let deltaEur: number | null = null;
    let cashflowUsd: number | null = null;
    let cashflowEur: number | null = null;
    let cashflowAssetClass: string | null = null;
    let cashflowStatus: "complete" | "pending" | null = null;
    let deltaStatus: "complete" | "pending" | null = null;

    if (opts?.currentPriceUsd || opts?.currentPriceEur) {
      const beforeQty = (before?.quantity as number) ?? 0;
      const afterQty = input.quantity;
      const qtyDelta = afterQty - beforeQty;
      const valUsd = qtyDelta * (opts.currentPriceUsd ?? 0);
      const valEur = qtyDelta * (opts.currentPriceEur ?? 0);

      if (opts?.isAdjustment) {
        deltaUsd = valUsd;
        deltaEur = valEur;
        deltaStatus = "complete";
      } else {
        const { classifyAssetClass } = await import("@/lib/cashflow");
        cashflowUsd = valUsd;
        cashflowEur = valEur;
        cashflowAssetClass = classifyAssetClass("crypto_position", false);
        cashflowStatus = "complete";
      }
    }
```

Update the `logActivity` call similarly (add 5 new fields).

- [ ] **Step 3: Add cashflow computation to `deletePosition()`**

Find the delta computation in `deletePosition()` (around line 423-429). Apply same pattern: compute value, route to delta (if adjustment) or cashflow (if not).

```typescript
  let deltaUsd: number | null = null;
  let deltaEur: number | null = null;
  let cashflowUsd: number | null = null;
  let cashflowEur: number | null = null;
  let cashflowAssetClass: string | null = null;
  let cashflowStatus: "complete" | "pending" | null = null;
  let deltaStatus: "complete" | "pending" | null = null;

  if (snapshot && (opts?.currentPriceUsd || opts?.currentPriceEur)) {
    const qty = (snapshot.quantity as number) ?? 0;
    const valUsd = -(qty * (opts?.currentPriceUsd ?? 0));
    const valEur = -(qty * (opts?.currentPriceEur ?? 0));

    if (opts?.isAdjustment) {
      deltaUsd = valUsd;
      deltaEur = valEur;
      deltaStatus = "complete";
    } else {
      const { classifyAssetClass } = await import("@/lib/cashflow");
      cashflowUsd = valUsd;
      cashflowEur = valEur;
      cashflowAssetClass = classifyAssetClass("crypto_position", false);
      cashflowStatus = "complete";
    }
  }
```

Update `logActivity` call with 5 new fields.

- [ ] **Step 4: Handle stablecoin classification**

For the stablecoin check, we need the crypto asset's subcategory. In `upsertPosition()`, the asset is already fetched on line 254. Add a subcategory fetch:

Change line 254-255:
```typescript
  const { data: asset } = await supabase
    .from("crypto_assets")
    .select("ticker, subcategory")
    .eq("id", input.crypto_asset_id)
    .is("deleted_at", null)
    .single();
  const ticker = asset?.ticker ?? "Unknown";
  const isStablecoin = asset?.subcategory?.toLowerCase() === "stablecoin";
```

Then in the cashflow blocks, use `classifyAssetClass("crypto_position", isStablecoin)` instead of `false`.

For `deletePosition()`, the snapshot join already fetches from `crypto_assets`. Add subcategory to the select:

Change line 407-408:
```typescript
    .select("*, crypto_assets(ticker, subcategory)")
```

Then extract: `const isStablecoin = (snapshot?.crypto_assets as { subcategory?: string } | null)?.subcategory?.toLowerCase() === "stablecoin";`

- [ ] **Step 5: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/actions/crypto.ts
git commit -m "feat: compute cashflow at write time for crypto mutations"
```

---

### Task 8: Stock Actions — Write-Time Cashflow + Delta Status

**Files:**
- Modify: `src/lib/actions/stocks.ts`

Stocks follow the same pattern as crypto but with FX conversion (try/catch around `toUsdAndEur()`). The catch blocks get `delta_status: "pending"` or `cashflow_status: "pending"`.

- [ ] **Step 1: Refactor `upsertStockPosition()` — removal branch (lines 305-318)**

Replace the existing delta block with the dual-path pattern:

```typescript
      let deltaUsd: number | null = null;
      let deltaEur: number | null = null;
      let cashflowUsd: number | null = null;
      let cashflowEur: number | null = null;
      let cashflowAssetClass: string | null = null;
      let cashflowStatus: "complete" | "pending" | null = null;
      let deltaStatus: "complete" | "pending" | null = null;

      if (opts?.currentPriceNative) {
        const qty = (existing.quantity as number) ?? 0;
        const deltaNative = -(qty * opts.currentPriceNative);

        if (opts?.isAdjustment) {
          try {
            const { toUsdAndEur } = await import("@/lib/actions/activity-log");
            const converted = await toUsdAndEur(deltaNative, opts.assetCurrency ?? "USD", opts.effectiveDate?.split("T")[0]);
            deltaUsd = converted.usd;
            deltaEur = converted.eur;
            deltaStatus = "complete";
          } catch (err) {
            console.error("[stocks] FX delta failed, marked pending:", err instanceof Error ? err.message : err);
            deltaStatus = "pending";
          }
        } else {
          try {
            const { toUsdAndEur } = await import("@/lib/actions/activity-log");
            const converted = await toUsdAndEur(deltaNative, opts.assetCurrency ?? "USD", opts.effectiveDate?.split("T")[0]);
            const { classifyAssetClass } = await import("@/lib/cashflow");
            cashflowUsd = converted.usd;
            cashflowEur = converted.eur;
            cashflowAssetClass = classifyAssetClass("stock_position");
            cashflowStatus = "complete";
          } catch (err) {
            console.error("[stocks] FX cashflow failed, marked pending:", err instanceof Error ? err.message : err);
            cashflowStatus = "pending";
          }
        }
      }
```

Update `logActivity` call with 5 new fields.

- [ ] **Step 2: Refactor `upsertStockPosition()` — upsert branch**

Same dual-path pattern as Step 1. Key differences:
- `const beforeQty = (before?.quantity as number) ?? 0;`
- `const qtyDelta = afterQty - beforeQty;`
- `const deltaNative = qtyDelta * opts.currentPriceNative;`
- Adjustment path: `toUsdAndEur(deltaNative, ...)` → `deltaUsd`/`deltaEur` + `deltaStatus`
- Non-adjustment path: `toUsdAndEur(deltaNative, ...)` → `cashflowUsd`/`cashflowEur` + `classifyAssetClass("stock_position")` + `cashflowStatus`
- Both paths: catch block sets respective status to `"pending"`

Update `logActivity` call with 5 new fields.

- [ ] **Step 3: Refactor `deleteStockPosition()`**

Same dual-path pattern. Key differences:
- `const qty = (snapshot?.quantity as number) ?? 0;`
- `const deltaNative = -(qty * (opts?.currentPriceNative ?? 0));` (negative — money leaving)
- Adjustment path: `toUsdAndEur(deltaNative, ...)` → `deltaUsd`/`deltaEur` + `deltaStatus`
- Non-adjustment path: `toUsdAndEur(deltaNative, ...)` → `cashflowUsd`/`cashflowEur` + `classifyAssetClass("stock_position")` + `cashflowStatus`
- Catch block: set respective status to `"pending"`

Update `logActivity` call with 5 new fields.

- [ ] **Step 4: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/stocks.ts
git commit -m "feat: compute cashflow at write time for stock mutations"
```

---

### Task 9: Cash Action Files — Cashflow + FX Rate Opt + Delta Status

**Files:**
- Modify: `src/lib/actions/broker-deposits.ts`
- Modify: `src/lib/actions/exchange-deposits.ts`
- Modify: `src/lib/actions/bank-accounts.ts`

Cash actions are the most uniform. Each has 3 mutations (create/update/delete) × 1 catch block = 3 catch blocks per file. The changes:
1. Accept `fxRate?: number` in opts
2. When `isAdjustment = false`: compute cashflow using `fxRate` (or fallback to `toUsdAndEur()`)
3. When `isAdjustment = true`: existing delta computation unchanged, add `delta_status` tracking
4. Pass 5 new fields to `logActivity()`

- [ ] **Step 1: Refactor `broker-deposits.ts` — `createBrokerDeposit`**

Add `fxRate?: number` to opts type (line 36):

```typescript
  opts?: { isAdjustment?: boolean; transferGroupId?: string; effectiveDate?: string; fxRate?: number }
```

Replace the delta computation block (lines 75-85) with:

```typescript
  let deltaUsd: number | null = null;
  let deltaEur: number | null = null;
  let cashflowUsd: number | null = null;
  let cashflowEur: number | null = null;
  let cashflowAssetClass: string | null = null;
  let cashflowStatus: "complete" | "pending" | null = null;
  let deltaStatus: "complete" | "pending" | null = null;

  if (created) {
    const amount = created.amount ?? 0;
    const currency = created.currency ?? "USD";

    if (opts?.isAdjustment) {
      try {
        const converted = await toUsdAndEur(amount, currency, opts?.effectiveDate?.split("T")[0]);
        deltaUsd = Math.round(converted.usd * 100) / 100;
        deltaEur = Math.round(converted.eur * 100) / 100;
        deltaStatus = "complete";
      } catch (err) {
        console.error("[broker-deposits] FX delta failed, marked pending:", err instanceof Error ? err.message : err);
        deltaStatus = "pending";
      }
    } else {
      const { computeCashflowFromPrices, classifyAssetClass } = await import("@/lib/cashflow");
      if (opts?.fxRate) {
        const cf = computeCashflowFromPrices({
          action: "created", beforeQty: 0, afterQty: amount,
          entityCurrency: currency, fxRate: opts.fxRate,
        });
        cashflowUsd = Math.round(cf.usd * 100) / 100;
        cashflowEur = Math.round(cf.eur * 100) / 100;
        cashflowStatus = "complete";
      } else {
        // Fallback: use FX API
        try {
          const converted = await toUsdAndEur(amount, currency);
          cashflowUsd = Math.round(converted.usd * 100) / 100;
          cashflowEur = Math.round(converted.eur * 100) / 100;
          cashflowStatus = "complete";
        } catch (err) {
          console.error("[broker-deposits] FX cashflow failed, marked pending:", err instanceof Error ? err.message : err);
          cashflowStatus = "pending";
        }
      }
      cashflowAssetClass = classifyAssetClass("broker_deposit");
    }
  }
```

Update `logActivity` call with 5 new fields.

- [ ] **Step 2: Refactor `updateBrokerDeposit` and `deleteBrokerDeposit`**

Same dual-path pattern as Step 1. Key differences per function:
- **`updateBrokerDeposit`**: `action: "updated"`, `beforeQty: before.amount`, `afterQty: after.amount` (delta = difference). Add `fxRate?: number` to opts type.
- **`deleteBrokerDeposit`**: `action: "removed"`, `beforeQty: amount`, `afterQty: 0` (delta = negative amount). Add `fxRate?: number` to opts type.

Both: route to delta (adjustment) or cashflow (non-adjustment), with `classifyAssetClass("broker_deposit")` and status tracking. Update `logActivity` calls with 5 new fields.

- [ ] **Step 3: Refactor `exchange-deposits.ts` — all 3 mutations**

Same dual-path pattern as broker-deposits. For each of `createExchangeDeposit`, `updateExchangeDeposit`, `deleteExchangeDeposit`:
- Add `fxRate?: number` to opts type
- Create: `action: "created"`, `beforeQty: 0`, `afterQty: amount`
- Update: `action: "updated"`, `beforeQty: before.amount`, `afterQty: after.amount`
- Delete: `action: "removed"`, `beforeQty: amount`, `afterQty: 0`
- Asset class: `classifyAssetClass("exchange_deposit")`

Update `logActivity` calls with 5 new fields.

- [ ] **Step 4: Refactor `bank-accounts.ts` — all 3 mutations**

Same pattern but uses `balance` field instead of `amount`. For each of `createBankAccount`, `updateBankAccount`, `deleteBankAccount`:
- Add `fxRate?: number` to opts type (these have more complex opts — append to existing fields)
- Create: `action: "created"`, `beforeQty: 0`, `afterQty: balance`
- Update: `action: "updated"`, `beforeQty: before.balance`, `afterQty: after.balance`
- Delete: `action: "removed"`, `beforeQty: balance`, `afterQty: 0`
- Asset class: `classifyAssetClass("bank_account")`

Update `logActivity` calls with 5 new fields.

- [ ] **Step 5: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 6: Run all existing tests**

Run: `npm test`
Expected: All 217 unit tests pass (existing delta tests unchanged)

- [ ] **Step 7: Commit**

```bash
git add src/lib/actions/broker-deposits.ts src/lib/actions/exchange-deposits.ts src/lib/actions/bank-accounts.ts
git commit -m "feat: compute cashflow at write time for cash mutations"
```

---

### Task 10: Cash Modal FX Rate Plumbing

**Files:**
- Modify: `src/components/cash/broker-deposit-modal.tsx`
- Modify: `src/components/cash/exchange-deposit-modal.tsx`
- Modify: `src/components/cash/bank-account-modal.tsx`
- Modify: `src/components/cash/cash-table.tsx`
- Modify: `src/components/accounts/accounts-view.tsx`
- Modify: `src/app/dashboard/accounts/page.tsx`

Thread the EUR/USD rate from the page → modal → server action.

- [ ] **Step 1: Add `fxRate` prop to `BrokerDepositModal`**

In `broker-deposit-modal.tsx`, add to interface:

```typescript
interface BrokerDepositModalProps {
  open: boolean;
  onClose: () => void;
  editing: BrokerDeposit | null;
  brokers: Broker[];
  fxRate?: number;  // EUR/USD rate for cashflow computation
}
```

Destructure `fxRate` from props. In `handleSubmit`, pass it to server actions:

```typescript
      if (editing) {
        await updateBrokerDeposit(editing.id, input, { isAdjustment, fxRate });
      } else {
        await createBrokerDeposit(input, { isAdjustment, fxRate });
      }
```

- [ ] **Step 2: Add `fxRate` prop to `ExchangeDepositModal` and `BankAccountModal`**

Same pattern for both. `BankAccountModal` passes `fxRate` through the opts object to `createBankAccount`/`updateBankAccount`.

- [ ] **Step 3: Pass EUR/USD rate from cash page through `CashTable` to modals**

The cash page already fetches `eurUsdData` from Yahoo (`getStockPrices(["EURUSD=X"])`). Pass `regularMarketPrice` to `CashTable`:

In `cash/page.tsx`:
```typescript
  <CashTable
    // ... existing props ...
    eurUsdRate={eurUsdData?.regularMarketPrice ?? undefined}
  />
```

In `cash-table.tsx`, accept `eurUsdRate?: number` prop and forward to each modal:
```typescript
  <BrokerDepositModal ... fxRate={eurUsdRate} />
  <ExchangeDepositModal ... fxRate={eurUsdRate} />
  <BankAccountModal ... fxRate={eurUsdRate} />
```

- [ ] **Step 4: Handle accounts page modals**

The accounts page renders all 3 cash modals via `accounts-view.tsx` (not just `BankAccountModal`). Changes needed:

1. In `dashboard/accounts/page.tsx`: add `getStockPrices(["EURUSD=X"])` to `Promise.all` (if not already fetched). Extract `eurUsdRate = eurUsdBatch["EURUSD=X"]?.regularMarketPrice`. Pass to `AccountsView`.
2. In `accounts-view.tsx`: accept `eurUsdRate?: number` prop. Pass as `fxRate={eurUsdRate}` to all 3 modals:
   - `<BrokerDepositModal ... fxRate={eurUsdRate} />`
   - `<ExchangeDepositModal ... fxRate={eurUsdRate} />`
   - `<BankAccountModal ... fxRate={eurUsdRate} />`

- [ ] **Step 5: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 6: Commit**

```bash
git add src/components/cash/broker-deposit-modal.tsx src/components/cash/exchange-deposit-modal.tsx src/components/cash/bank-account-modal.tsx src/components/cash/cash-table.tsx src/components/accounts/accounts-view.tsx src/app/dashboard/cash/page.tsx src/app/dashboard/accounts/page.tsx
git commit -m "feat: thread FX rate from pages through cash modals to server actions"
```

---

## Chunk 3: Read Path — New deriveCashFlows, Caller Updates, Backfill

### Task 11: New DB-Only `deriveCashFlows()`

**Files:**
- Modify: `src/lib/actions/benchmark.ts`

- [ ] **Step 1: Write the new function body**

Replace the entire `deriveCashFlows` function body (the old 388-line implementation). Old helper functions (`buildPriceMap`, `getPrice`, `toUsd`, `toEur`, `CashFlowEventInternal`) will be removed now to keep lint clean — rollback path is "revert the commit" via git history.

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
    .is("undone_at", null)
    .order("created_at", { ascending: true })
    .limit(10000);
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query;

  if (error) {
    console.error("[benchmark] deriveCashFlows query failed:", error.message);
    return { events: [], pendingCount: 0, failedCount: 0 };
  }

  // Pending/failed counts for UI warning
  let pendingQuery = supabase
    .from("activity_log")
    .select("*", { count: "exact", head: true })
    .is("undone_at", null)
    .or("cashflow_status.eq.pending,delta_status.eq.pending");
  let failedQuery = supabase
    .from("activity_log")
    .select("*", { count: "exact", head: true })
    .is("undone_at", null)
    .or("cashflow_status.eq.failed,delta_status.eq.failed");
  if (userId) {
    pendingQuery = pendingQuery.eq("user_id", userId);
    failedQuery = failedQuery.eq("user_id", userId);
  }
  const [pendingResult, failedResult] = await Promise.all([pendingQuery, failedQuery]);

  return {
    events: (data ?? []).map((row) => ({
      date: (row.created_at as string).split("T")[0],
      amount_usd: (row.cashflow_amount_usd as number) ?? 0,
      amount_eur: (row.cashflow_amount_eur as number) ?? undefined,
      asset_class: (row.cashflow_asset_class as AssetClass) ?? undefined,
      entity_name: (row.entity_name as string) ?? undefined,
    })),
    pendingCount: pendingResult.count ?? 0,
    failedCount: failedResult.count ?? 0,
  };
});
```

Note: The old return type was `Promise<CashFlowEvent[]>`. The new return type is `Promise<{ events: CashFlowEvent[]; pendingCount: number; failedCount: number }>`. All callers must be updated.

- [ ] **Step 2: Remove unused imports (but keep old helper functions for rollback)**

The old function used `fetchIndexHistory` and `fetchCoinHistory`. These imports are now unused but keep them temporarily — they'll be removed in Task 16.

Actually, TypeScript will warn about unused imports and the lint will fail. Comment them out with a `// CLEANUP: remove after production verification` note, or remove them now since the old code is still in git history.

Better: remove the old helper functions and imports now to keep lint clean. The rollback plan is "revert the commit" not "uncomment code".

Remove:
- `import { fetchIndexHistory } from "@/lib/prices/yahoo";` (line 6)
- `import { fetchCoinHistory } from "@/lib/prices/coingecko";` (line 7)
- `CashFlowEventInternal` type (lines 22-26)
- `PriceMap` type, `buildPriceMap()`, `getPrice()` helpers (lines 29-53)
- Everything between the old function signature and the new implementation

Keep:
- `AssetClass` type export (line 11)
- `CashFlowEvent` interface (lines 13-19)
- `cache` import from React (line 3)
- Supabase client imports (lines 4-5)

- [ ] **Step 3: Verify build — expect caller errors**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: Type errors at all 8 callers (return type changed from `CashFlowEvent[]` to `{ events, pendingCount, failedCount }`)

- [ ] **Step 4: Commit (callers broken — will fix next)**

```bash
git add src/lib/actions/benchmark.ts
git commit -m "feat: replace deriveCashFlows with DB-only implementation"
```

---

### Task 12: Update All 8 Callers of `deriveCashFlows()`

**Files:**
- Modify: `src/app/dashboard/page.tsx`
- Modify: `src/app/dashboard/crypto/page.tsx`
- Modify: `src/app/dashboard/stocks/page.tsx`
- Modify: `src/app/dashboard/cash/page.tsx`
- Modify: `src/app/share/[token]/page.tsx`
- Modify: `src/app/share/[token]/crypto/page.tsx`
- Modify: `src/app/share/[token]/stocks/page.tsx`
- Modify: `src/app/share/[token]/cash/page.tsx`

All callers need to destructure `{ events: cashFlows }` from the result. The `pendingCount`/`failedCount` are only used by the dashboard main page (for chart banner).

- [ ] **Step 1: Update `dashboard/page.tsx`**

Change the destructuring (line 34):
```typescript
    cashFlows,
```
to:
```typescript
    cashFlowResult,
```

Then after the `Promise.all`, destructure:
```typescript
  const { events: cashFlows, pendingCount: cfPendingCount, failedCount: cfFailedCount } = cashFlowResult;
```

Store `cfPendingCount` and `cfFailedCount` as local variables — they'll be wired to `PortfolioChart` in Task 14 (don't pass them yet, as the props don't exist on the component).

- [ ] **Step 2: Update `dashboard/crypto/page.tsx`**

Rename the `cashFlows` binding in the `Promise.all` destructuring to `cashFlowResult`, then extract events:
```typescript
  const [assets, wallets, profile, cashFlowResult] = ...
  const cashFlows = cashFlowResult.events;
```

- [ ] **Step 3: Update `dashboard/stocks/page.tsx`**

Same destructuring pattern. The variable position in the `Promise.all` array matches the position of the `deriveCashFlows()` call. Rename to `cashFlowResult`, extract `.events`:
```typescript
  const [positions, brokers, profile, cashFlowResult] = ...
  const cashFlows = cashFlowResult.events;
```

- [ ] **Step 4: Update `dashboard/cash/page.tsx`**

Cash page has 8 bindings in `Promise.all`. `cashFlows` is the last one:
```typescript
  const [bankAccounts, exchangeDeposits, brokerDeposits, wallets, brokers, profile, cryptoAssets, cashFlowResult] = ...
  const cashFlows = cashFlowResult.events;
```

- [ ] **Step 5: Update all 4 share pages**

Each share page calls `deriveCashFlows(share.owner_id)` or `deriveCashFlows(data.share.owner_id)`. For each:
- `share/[token]/page.tsx`: Rename to `cashFlowResult`, extract `.events` as `cashFlows`
- `share/[token]/crypto/page.tsx`: Same pattern
- `share/[token]/stocks/page.tsx`: Same pattern
- `share/[token]/cash/page.tsx`: Same pattern

Share pages don't need `pendingCount`/`failedCount` — the share viewer has no action to take on pending items.

- [ ] **Step 6: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors (all callers now extract `.events`, pending/failed counts are unused variables in non-dashboard pages — suppress with underscore prefix `_cfPendingCount` if needed)

- [ ] **Step 7: Commit**

```bash
git add src/app/dashboard/page.tsx src/app/dashboard/crypto/page.tsx src/app/dashboard/stocks/page.tsx src/app/dashboard/cash/page.tsx src/app/share/
git commit -m "feat: update all deriveCashFlows callers for new return type"
```

---

### Task 13: Backfill Function

**Files:**
- Create: `src/lib/actions/backfill.ts`

This is the most complex new file. It processes legacy rows that don't have cashflow values yet.

- [ ] **Step 1: Create `backfill.ts`**

```typescript
"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { classifyAssetClass } from "@/lib/cashflow";
import { computeDeltaFromSnapshots } from "./activity-log";

const BATCH_SIZE = 50;
const THROTTLE_MS = 24 * 60 * 60 * 1000; // 24 hours between retries
const MAX_DAYS_BEFORE_EXHAUSTED = 3; // 3 days minimum before escalating to failed

export async function backfillCashflowsAndDeltas(): Promise<{
  processed: number;
  succeeded: number;
  pending: number;
  failed: number;
}> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { processed: 0, succeeded: 0, pending: 0, failed: 0 };

  const now = new Date();
  const throttleDate = new Date(now.getTime() - THROTTLE_MS).toISOString();

  // Query rows needing cashflow backfill:
  // 1. Legacy rows: cashflow_status IS NULL + entity produces cashflows + not adjustment + not undone
  // 2. Pending rows: cashflow_status = 'pending' + not recently attempted
  const { data: cashflowRows } = await supabase
    .from("activity_log")
    .select("id, action, entity_type, entity_id, entity_table, before_snapshot, after_snapshot, created_at, cashflow_attempted_at")
    .eq("user_id", user.id)
    .eq("is_adjustment", false)
    .is("undone_at", null)
    .in("entity_type", ["crypto_position", "stock_position", "exchange_deposit", "broker_deposit", "bank_account"])
    .or(`cashflow_status.is.null,and(cashflow_status.eq.pending,or(cashflow_attempted_at.is.null,cashflow_attempted_at.lt.${throttleDate}))`)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  // Query rows needing delta backfill
  const { data: deltaRows } = await supabase
    .from("activity_log")
    .select("id, action, entity_type, entity_id, entity_table, before_snapshot, after_snapshot, created_at, delta_attempted_at")
    .eq("user_id", user.id)
    .eq("delta_status", "pending")
    .is("undone_at", null)
    .or(`delta_attempted_at.is.null,delta_attempted_at.lt.${throttleDate}`)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  const allRows = [...(cashflowRows ?? []), ...(deltaRows ?? [])];
  if (allRows.length === 0) {
    return { processed: 0, succeeded: 0, pending: 0, failed: 0 };
  }

  let succeeded = 0;
  let pending = 0;
  let failed = 0;

  for (const row of allRows) {
    const isCashflow = (cashflowRows ?? []).some((r) => r.id === row.id);

    try {
      // Use computeDeltaFromSnapshots for both cashflow and delta computation
      const values = await computeDeltaFromSnapshots(
        row.entity_type,
        row.action,
        row.created_at,
        row.before_snapshot as Record<string, unknown> | null,
        row.after_snapshot as Record<string, unknown> | null
      );

      if (isCashflow) {
        // Determine asset class
        let isStablecoin = false;
        if (row.entity_type === "crypto_position") {
          const snap = (row.after_snapshot ?? row.before_snapshot) as Record<string, unknown> | null;
          const assetId = snap?.crypto_asset_id as string | undefined;
          if (assetId) {
            const { data: asset } = await supabase
              .from("crypto_assets")
              .select("subcategory")
              .eq("id", assetId)
              .single();
            isStablecoin = asset?.subcategory?.toLowerCase() === "stablecoin";
          }
        }
        const assetClass = classifyAssetClass(row.entity_type, isStablecoin);

        await supabase.from("activity_log").update({
          cashflow_amount_usd: Math.round(values.usd * 100) / 100,
          cashflow_amount_eur: Math.round(values.eur * 100) / 100,
          cashflow_asset_class: assetClass,
          cashflow_status: "complete",
          cashflow_attempted_at: now.toISOString(),
        }).eq("id", row.id);
      } else {
        await supabase.from("activity_log").update({
          delta_usd: Math.round(values.usd * 100) / 100,
          delta_eur: Math.round(values.eur * 100) / 100,
          delta_status: "complete",
          delta_attempted_at: now.toISOString(),
        }).eq("id", row.id);
      }
      succeeded++;
    } catch (err) {
      console.error(`[backfill] Failed row ${row.id}:`, err instanceof Error ? err.message : err);

      // Check if retries exhausted via attempted_at timestamps
      // (days since first attempt approximates attempt count — acceptable for invite-only app)
      const attemptedAt = isCashflow ? row.cashflow_attempted_at : row.delta_attempted_at;
      const daysSinceFirst = attemptedAt
        ? (now.getTime() - new Date(attemptedAt as string).getTime()) / THROTTLE_MS
        : 0;
      const isExhausted = daysSinceFirst >= MAX_DAYS_BEFORE_EXHAUSTED - 1;

      if (isExhausted) {
        // Try snapshot estimation fallback before giving up
        let estimateUsd = 0;
        let estimateEur = 0;
        let hasEstimate = false;

        try {
          // Find portfolio_snapshots bracketing the event date
          const eventDate = row.created_at.split("T")[0];
          const { data: snapBefore } = await supabase
            .from("portfolio_snapshots")
            .select("crypto_value_usd, stocks_value_usd, cash_value_usd, crypto_value_eur, stocks_value_eur, cash_value_eur")
            .eq("user_id", user.id)
            .lt("snapshot_date", eventDate)
            .order("snapshot_date", { ascending: false })
            .limit(1)
            .single();
          const { data: snapAfter } = await supabase
            .from("portfolio_snapshots")
            .select("crypto_value_usd, stocks_value_usd, cash_value_usd, crypto_value_eur, stocks_value_eur, cash_value_eur")
            .eq("user_id", user.id)
            .gte("snapshot_date", eventDate)
            .order("snapshot_date", { ascending: true })
            .limit(1)
            .single();

          if (snapBefore && snapAfter) {
            // Infer cashflow from class-level value change between snapshots
            const assetClass = classifyAssetClass(row.entity_type);
            const classKey = assetClass === "crypto" ? "crypto" : assetClass === "stocks" ? "stocks" : "cash";
            estimateUsd = ((snapAfter as Record<string, number>)[`${classKey}_value_usd`] ?? 0)
              - ((snapBefore as Record<string, number>)[`${classKey}_value_usd`] ?? 0);
            estimateEur = ((snapAfter as Record<string, number>)[`${classKey}_value_eur`] ?? 0)
              - ((snapBefore as Record<string, number>)[`${classKey}_value_eur`] ?? 0);
            hasEstimate = true;
          }
        } catch {
          // Snapshot estimation failed — will use $0
        }

        if (isCashflow) {
          const assetClass = classifyAssetClass(row.entity_type);
          await supabase.from("activity_log").update({
            cashflow_amount_usd: Math.round(estimateUsd * 100) / 100,
            cashflow_amount_eur: Math.round(estimateEur * 100) / 100,
            cashflow_asset_class: assetClass,
            cashflow_status: hasEstimate ? "complete" : "failed",
            cashflow_attempted_at: now.toISOString(),
          }).eq("id", row.id);
        } else {
          await supabase.from("activity_log").update({
            delta_usd: Math.round(estimateUsd * 100) / 100,
            delta_eur: Math.round(estimateEur * 100) / 100,
            delta_status: hasEstimate ? "complete" : "failed",
            delta_attempted_at: now.toISOString(),
          }).eq("id", row.id);
        }
        failed++;
      } else {
        // Update attempted_at, keep pending
        const updateField = isCashflow ? "cashflow_attempted_at" : "delta_attempted_at";
        await supabase.from("activity_log").update({
          [updateField]: now.toISOString(),
        }).eq("id", row.id);
        pending++;
      }
    }
  }

  return { processed: allRows.length, succeeded, pending, failed };
}
```

**Note:** This uses `computeDeltaFromSnapshots` which is currently a private function in `activity-log.ts`. It needs to be exported first.

- [ ] **Step 2: Export `computeDeltaFromSnapshots` from `activity-log.ts`**

In `activity-log.ts`, change the function declaration (around line 134):
```typescript
async function computeDeltaFromSnapshots(
```
to:
```typescript
export async function computeDeltaFromSnapshots(
```

The static import at the top of `backfill.ts` (from Step 1) already references this.

- [ ] **Step 3: Wire backfill to dashboard page load**

In `src/app/dashboard/page.tsx`, add a fire-and-forget backfill call alongside the existing snapshot save:

```typescript
import { backfillCashflowsAndDeltas } from "@/lib/actions/backfill";

// After the existing saveSnapshot fire-and-forget (around line 165)
backfillCashflowsAndDeltas().catch((err) =>
  console.error("[backfill] fire-and-forget failed:", err)
);
```

- [ ] **Step 4: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/backfill.ts src/lib/actions/activity-log.ts src/app/dashboard/page.tsx
git commit -m "feat: add backfill function for legacy cashflow/delta rows"
```

---

## Chunk 4: UI Warnings, Tests, and Cleanup

### Task 14: Chart Warning Banner Component

**Files:**
- Create: `src/components/dashboard/chart-warning-banner.tsx`
- Create: `__tests__/component/chart-warning-banner.test.tsx`
- Modify: `src/components/dashboard/portfolio-chart.tsx`

- [ ] **Step 1: Write component test**

Create `__tests__/component/chart-warning-banner.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChartWarningBanner } from "@/components/dashboard/chart-warning-banner";

describe("ChartWarningBanner", () => {
  it("renders nothing when counts are zero", () => {
    const { container } = render(<ChartWarningBanner pendingCount={0} failedCount={0} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders amber banner for pending only", () => {
    render(<ChartWarningBanner pendingCount={3} failedCount={0} />);
    expect(screen.getByText(/awaiting price data/i)).toBeTruthy();
  });

  it("renders red banner for failed only", () => {
    render(<ChartWarningBanner pendingCount={0} failedCount={2} />);
    expect(screen.getByText(/estimated values/i)).toBeTruthy();
  });

  it("renders both when both present", () => {
    render(<ChartWarningBanner pendingCount={1} failedCount={1} />);
    expect(screen.getByText(/awaiting price data/i)).toBeTruthy();
    expect(screen.getByText(/estimated values/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:component -- --reporter=verbose __tests__/component/chart-warning-banner.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write the component**

Create `src/components/dashboard/chart-warning-banner.tsx`:

```tsx
import { Clock, AlertTriangle } from "lucide-react";
import Link from "next/link";

interface ChartWarningBannerProps {
  pendingCount: number;
  failedCount: number;
}

export function ChartWarningBanner({ pendingCount, failedCount }: ChartWarningBannerProps) {
  if (pendingCount === 0 && failedCount === 0) return null;

  return (
    <div className="space-y-1.5 mb-3">
      {pendingCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 text-amber-400 text-xs">
          <Clock className="w-3.5 h-3.5 shrink-0" />
          <span>
            {pendingCount} {pendingCount === 1 ? "transaction is" : "transactions are"} awaiting price data.{" "}
            <Link href="/dashboard/history" className="underline hover:text-amber-300">
              View activity log
            </Link>
          </span>
        </div>
      )}
      {failedCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 text-red-400 text-xs">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>
            {failedCount} {failedCount === 1 ? "transaction has" : "transactions have"} estimated values.{" "}
            <Link href="/dashboard/history" className="underline hover:text-red-300">
              View activity log
            </Link>
          </span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:component -- --reporter=verbose __tests__/component/chart-warning-banner.test.tsx`
Expected: All 4 tests PASS

- [ ] **Step 5: Add banner to `PortfolioChart`**

In `portfolio-chart.tsx`, add props:

```typescript
  pendingCount?: number;
  failedCount?: number;
```

Import and render the banner at the top of the chart area (just before the chart div):

```typescript
import { ChartWarningBanner } from "./chart-warning-banner";

// Inside the component, before the chart:
<ChartWarningBanner pendingCount={pendingCount ?? 0} failedCount={failedCount ?? 0} />
```

Then in `dashboard/page.tsx`, pass the counts (using the variables extracted in Task 12):

```typescript
<PortfolioChart
  // ... existing props ...
  pendingCount={cfPendingCount}
  failedCount={cfFailedCount}
/>
```

Only `dashboard/page.tsx` passes these props. The 3 detail pages (crypto/stocks/cash) and 4 share pages don't show the banner — they pass `0`/`undefined` (default), since the banner links to the activity log which is only on the main dashboard. The `PortfolioChart` props are optional, so no changes needed at those callers.

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/chart-warning-banner.tsx __tests__/component/chart-warning-banner.test.tsx src/components/dashboard/portfolio-chart.tsx src/app/dashboard/page.tsx
git commit -m "feat: add chart warning banner for pending/failed cashflows"
```

---

### Task 15: Activity Timeline Status Icons

**Files:**
- Create: `src/components/ui/cashflow-status-icon.tsx`
- Create: `__tests__/component/cashflow-status-icon.test.tsx`
- Modify: `src/components/history/activity-timeline.tsx`

- [ ] **Step 1: Write the component test**

Create `__tests__/component/cashflow-status-icon.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CashflowStatusIcon } from "@/components/ui/cashflow-status-icon";

describe("CashflowStatusIcon", () => {
  it("renders nothing when both statuses are null", () => {
    const { container } = render(<CashflowStatusIcon cashflowStatus={null} deltaStatus={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when statuses are complete", () => {
    const { container } = render(<CashflowStatusIcon cashflowStatus="complete" deltaStatus="complete" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders amber clock for pending status", () => {
    const { container } = render(<CashflowStatusIcon cashflowStatus="pending" deltaStatus={null} />);
    expect(container.querySelector(".text-amber-400")).toBeTruthy();
  });

  it("renders red alert for failed status", () => {
    const { container } = render(<CashflowStatusIcon cashflowStatus="failed" deltaStatus={null} />);
    expect(container.querySelector(".text-red-400")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:component -- --reporter=verbose __tests__/component/cashflow-status-icon.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Create the status icon component**

Create `src/components/ui/cashflow-status-icon.tsx`:

```tsx
import { Clock, AlertTriangle } from "lucide-react";

interface CashflowStatusIconProps {
  cashflowStatus: string | null;
  deltaStatus: string | null;
}

export function CashflowStatusIcon({ cashflowStatus, deltaStatus }: CashflowStatusIconProps) {
  const isPending = cashflowStatus === "pending" || deltaStatus === "pending";
  const isFailed = cashflowStatus === "failed" || deltaStatus === "failed";

  if (!isPending && !isFailed) return null;

  // Build tooltip text
  const parts: string[] = [];
  if (cashflowStatus === "pending") parts.push("Cashflow data pending");
  if (deltaStatus === "pending") parts.push("Delta data pending");
  if (cashflowStatus === "failed") parts.push("Cashflow uses estimate");
  if (deltaStatus === "failed") parts.push("Delta uses estimate");

  if (isFailed) {
    return (
      <span title={parts.join(". ") + ". Chart uses estimate."}>
        <AlertTriangle className="w-3 h-3 text-red-400" />
      </span>
    );
  }

  return (
    <span title={parts.join(". ") + ". Will retry automatically."}>
      <Clock className="w-3 h-3 text-amber-400" />
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:component -- --reporter=verbose __tests__/component/cashflow-status-icon.test.tsx`
Expected: All 4 tests PASS

- [ ] **Step 5: Add status icons to activity timeline rows**

In `activity-timeline.tsx`, import the component:

```typescript
import { CashflowStatusIcon } from "@/components/ui/cashflow-status-icon";
```

In the single-entry row rendering (in the right-side div next to the time, before the time label and after the undo button section), add:

```tsx
  {/* Status icon for pending/failed cashflows */}
  <CashflowStatusIcon
    cashflowStatus={log.cashflow_status}
    deltaStatus={log.delta_status}
  />
```

- [ ] **Step 6: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 7: Commit**

```bash
git add src/components/ui/cashflow-status-icon.tsx __tests__/component/cashflow-status-icon.test.tsx src/components/history/activity-timeline.tsx
git commit -m "feat: add pending/failed status icons to activity timeline"
```

---

### Task 16: Cleanup — Remove Old Price-Fetching Code

**Files:**
- Modify: `src/lib/actions/benchmark.ts`

**IMPORTANT:** Only do this after verifying the new path works in production for a few days. During development, do it after confirming the backfill works on local data.

- [ ] **Step 1: Verify old code was already removed in Task 11**

Task 11 already removed old helper functions and imports to keep lint clean. Verify `benchmark.ts` contains only:
- `AssetClass` type export
- `CashFlowEvent` interface export
- `cache` and Supabase client imports
- The new ~40-line `deriveCashFlows` function

If any old code remains (leftover imports, `fetchCoinHistory`/`fetchIndexHistory` references, `PriceMap`, `buildPriceMap`, `getPrice`, `toUsd`, `toEur`, `CashFlowEventInternal`), remove it now.

The file should be ~60 lines total.

- [ ] **Step 2: Verify lint and build**

Run: `npm run lint && npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Run full test suite**

Run: `npm run test:all`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/lib/actions/benchmark.ts
git commit -m "refactor: remove old price-fetching code from deriveCashFlows"
```

---

### Task 17: Unit Tests for New deriveCashFlows

**Files:**
- Create: `__tests__/unit/derive-cashflows-db.test.ts`

- [ ] **Step 1: Write unit tests for the new DB-only deriveCashFlows**

Create `__tests__/unit/derive-cashflows-db.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

// Mock Supabase client
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockIs = vi.fn();
const mockOr = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: mockEq.mockReturnThis(),
        is: mockIs.mockReturnThis(),
        or: mockOr.mockReturnThis(),
        order: mockOrder.mockReturnThis(),
        limit: mockLimit.mockResolvedValue({
          data: [
            {
              cashflow_amount_usd: 50000,
              cashflow_amount_eur: 46000,
              cashflow_asset_class: "crypto",
              entity_name: "Bitcoin",
              created_at: "2025-01-15T10:00:00Z",
            },
          ],
          error: null,
        }),
      })),
    })),
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe("deriveCashFlows (DB-only)", () => {
  it("maps DB rows to CashFlowEvent array", async () => {
    const { deriveCashFlows } = await import("@/lib/actions/benchmark");
    const result = await deriveCashFlows();
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      date: "2025-01-15",
      amount_usd: 50000,
      amount_eur: 46000,
      asset_class: "crypto",
      entity_name: "Bitcoin",
    });
  });

  it("returns empty events on error", async () => {
    mockLimit.mockResolvedValueOnce({ data: null, error: { message: "DB error" } });
    const { deriveCashFlows } = await import("@/lib/actions/benchmark");
    const result = await deriveCashFlows();
    expect(result.events).toEqual([]);
    expect(result.pendingCount).toBe(0);
  });
});
```

Note: Full mock wiring may need adjustment based on the actual Supabase client chain. The test validates the mapping logic and error handling.

- [ ] **Step 2: Run tests**

Run: `npm test -- --reporter=verbose __tests__/unit/derive-cashflows-db.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add __tests__/unit/derive-cashflows-db.test.ts
git commit -m "test: add unit tests for DB-only deriveCashFlows"
```

---

### Task 18: Final Verification

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: 0 errors, 0 warnings

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 3: Run all tests**

Run: `npm run test:all`
Expected: All unit + component + integration tests pass

- [ ] **Step 4: Verify locally**

Start dev server, trigger a mutation (e.g., add a crypto position), check:
- `activity_log` row has `cashflow_amount_usd`, `cashflow_status = 'complete'`
- Dashboard chart loads correctly
- Activity timeline shows no status icons (all rows complete)
- Toggle adjustment on a row → cashflow cleared, delta computed

- [ ] **Step 5: Final commit if any fixups needed**

---

## Summary

| Task | Description | Files | Estimated |
|------|-------------|-------|-----------|
| 1 | Migration | 1 new | 2 min |
| 2 | TypeScript types | 1 modified | 2 min |
| 3 | Pure cashflow helpers + tests | 2 new | 10 min |
| 4 | logActivity extension | 1 modified | 5 min |
| 5 | toggleActivityAdjustment swap | 1 modified | 15 min |
| 6 | Undo verification (no changes) | — | 2 min |
| 7 | Crypto write-time cashflow | 1 modified | 15 min |
| 8 | Stock write-time cashflow | 1 modified | 15 min |
| 9 | Cash actions cashflow (3 files) | 3 modified | 20 min |
| 10 | Cash modal FX plumbing | 7 modified | 15 min |
| 11 | New deriveCashFlows | 1 modified | 10 min |
| 12 | Update 8 callers | 8 modified | 10 min |
| 13 | Backfill function | 1 new + 1 modified | 20 min |
| 14 | Chart warning banner | 2 new + 2 modified | 15 min |
| 15 | Timeline status icons + tests | 2 new + 1 modified | 15 min |
| 16 | Cleanup old code | 1 modified | 5 min |
| 17 | Unit tests (deriveCashFlows) | 1 new | 10 min |
| 18 | Final verification | — | 10 min |
| **Total** | | **~37 files** | **~3 hrs** |

### Parallelization opportunities (for subagent execution)

- Tasks 7 + 8 + 9 (action files) can run in parallel after Tasks 4+6
- Tasks 14 + 15 (UI) can run in parallel after Task 12
- Tasks 15 + 17 (tests) can run in parallel with Task 14
- Task 10 (modal plumbing) can run in parallel with Tasks 7-9
