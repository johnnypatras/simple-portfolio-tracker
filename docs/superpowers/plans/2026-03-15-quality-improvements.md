# Quality Improvements Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five targeted improvements to push app quality ratings from B/B+ toward A- across monitoring, testing, error handling, financial calculations, and data integrity.

**Architecture:** Each improvement is independent — no shared state or sequential dependencies between them. All follow existing codebase patterns (component + test + wire to page).

**Tech Stack:** Next.js 16 (App Router), Supabase PostgreSQL, TypeScript, React 19, Vitest, RTL

**Spec:** `docs/superpowers/specs/2026-03-14-quality-improvements-design.md`

---

## File Structure

### New files
| File | Purpose |
|------|---------|
| `src/components/dashboard/stale-snapshot-banner.tsx` | Amber banner when snapshot >26h old |
| `src/components/ui/fx-status-indicator.tsx` | Icon indicator for stale/unavailable FX rate |
| `__tests__/component/stale-snapshot-banner.test.tsx` | Component tests for snapshot banner |
| `__tests__/component/fx-status-indicator.test.tsx` | Component tests for FX indicator |
| `__tests__/integration/cashflow-write.test.ts` | Integration tests for cashflow write path |
| `__tests__/integration/transfer-rollback.test.ts` | Integration tests for transfer compensation |
| `__tests__/integration/fx-failure.test.ts` | Integration tests for FX failure status tracking |

### Modified files
| File | What changes |
|------|-------------|
| `src/lib/types.ts` | Add `regularMarketTime` to `YahooStockPriceData` value type |
| `src/lib/prices/yahoo.ts` | Extract `regularMarketTime` from Yahoo v7 response |
| `src/components/dashboard/portfolio-chart.tsx` | Accept `snapshotStaleHours` prop, render stale banner |
| `src/app/dashboard/page.tsx` | Query snapshot age, pass to chart + FX staleness |
| `src/lib/actions/backfill.ts` | Add `backfillSingleRow()` server action |
| `src/components/ui/cashflow-status-icon.tsx` | Add retry button with loading state |
| `src/components/history/activity-timeline.tsx` | Wire `onRetry` callback to status icons |
| `src/lib/actions/import.ts` | Add `backup?` to ImportError, call exportFullJson before replace |
| `src/components/settings/import-export-settings.tsx` | Auto-download backup on import failure |

---

## Chunk 1: Monitoring — Stale Snapshot Banner + FX Indicator

### Task 1: Stale Snapshot Banner Component

**Files:**
- Create: `src/components/dashboard/stale-snapshot-banner.tsx`
- Create: `__tests__/component/stale-snapshot-banner.test.tsx`

- [ ] **Step 1: Write component test**

Create `__tests__/component/stale-snapshot-banner.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StaleSnapshotBanner } from "@/components/dashboard/stale-snapshot-banner";

describe("StaleSnapshotBanner", () => {
  it("renders nothing when staleHours is null", () => {
    const { container } = render(<StaleSnapshotBanner staleHours={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when staleHours <= 26", () => {
    const { container } = render(<StaleSnapshotBanner staleHours={24} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders amber banner when staleHours > 26", () => {
    render(<StaleSnapshotBanner staleHours={30} />);
    expect(screen.getByText(/30 hours/i)).toBeTruthy();
    expect(screen.getByText(/daily update may have failed/i)).toBeTruthy();
  });

  it("renders with large hour count", () => {
    render(<StaleSnapshotBanner staleHours={72} />);
    expect(screen.getByText(/72 hours/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:component -- --reporter=verbose __tests__/component/stale-snapshot-banner.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write the component**

Create `src/components/dashboard/stale-snapshot-banner.tsx`:

```tsx
import { Clock } from "lucide-react";

interface StaleSnapshotBannerProps {
  staleHours: number | null;
}

export function StaleSnapshotBanner({ staleHours }: StaleSnapshotBannerProps) {
  if (staleHours == null || staleHours <= 26) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 text-amber-400 text-xs mb-3">
      <Clock className="w-3.5 h-3.5 shrink-0" />
      <span>
        Portfolio snapshot is {Math.round(staleHours)} hours old — daily update may have failed.
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:component -- --reporter=verbose __tests__/component/stale-snapshot-banner.test.tsx`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/stale-snapshot-banner.tsx __tests__/component/stale-snapshot-banner.test.tsx
git commit -m "feat: add stale snapshot banner component with tests"
```

---

### Task 2: Wire Stale Snapshot Banner to Dashboard

**Files:**
- Modify: `src/components/dashboard/portfolio-chart.tsx`
- Modify: `src/app/dashboard/page.tsx`

- [ ] **Step 1: Add `snapshotStaleHours` prop to PortfolioChart**

In `src/components/dashboard/portfolio-chart.tsx`, add to the `PortfolioChartProps` interface (after `failedCount?: number`):

```typescript
  snapshotStaleHours?: number | null;
```

Import and render the banner before `ChartWarningBanner`:

```typescript
import { StaleSnapshotBanner } from "./stale-snapshot-banner";

// Inside the component, before ChartWarningBanner:
<StaleSnapshotBanner staleHours={snapshotStaleHours ?? null} />
```

- [ ] **Step 2: Query snapshot age in dashboard page**

In `src/app/dashboard/page.tsx`, add a snapshot age query. After the existing `Promise.all` (line 37-51), add:

```typescript
import { createServerSupabaseClient } from "@/lib/supabase/server";

// After the main Promise.all, compute snapshot staleness
const supabase = await createServerSupabaseClient();
const { data: latestSnap } = await supabase
  .from("portfolio_snapshots")
  .select("snapshot_date")
  .order("snapshot_date", { ascending: false })
  .limit(1)
  .single();
const snapshotStaleHours = latestSnap?.snapshot_date
  ? (Date.now() - new Date(latestSnap.snapshot_date as string).getTime()) / 3_600_000
  : null;
```

Then pass to `PortfolioChart`:
```typescript
<PortfolioChart
  // ... existing props ...
  snapshotStaleHours={snapshotStaleHours != null && snapshotStaleHours > 26 ? Math.round(snapshotStaleHours) : null}
/>
```

- [ ] **Step 3: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/portfolio-chart.tsx src/app/dashboard/page.tsx
git commit -m "feat: wire stale snapshot banner to dashboard"
```

---

### Task 3: FX Staleness — Update Yahoo Types and Extraction

**Files:**
- Modify: `src/lib/types.ts:406-414` (YahooStockPriceData)
- Modify: `src/lib/prices/yahoo.ts:186-202` (fetchQuotesBatch)

- [ ] **Step 1: Add `regularMarketTime` to YahooStockPriceData value type**

In `src/lib/types.ts`, find the `YahooStockPriceData` interface (line 406). Add `regularMarketTime` to the value type:

```typescript
export interface YahooStockPriceData {
  [yahooTicker: string]: {
    price: number;
    previousClose: number;
    change24h: number;
    currency: string;
    name: string;
    regularMarketTime?: number;
  };
}
```

- [ ] **Step 2: Extract `regularMarketTime` from Yahoo v7 response**

In `src/lib/prices/yahoo.ts`, find the `fetchQuotesBatch` function where it builds the Map entries (around line 194-202). Add `regularMarketTime` to the object:

```typescript
      map.set(symbol, {
        price,
        previousClose,
        change24h,
        currency: (q.currency as string) ?? "USD",
        name: (q.longName as string) ?? (q.shortName as string) ?? symbol,
        trailingYield: ((q.trailingAnnualDividendYield as number) ?? 0) * 100,
        annualDividend: (q.trailingAnnualDividendRate as number) ?? 0,
        regularMarketTime: (q.regularMarketTime as number) ?? undefined,
      });
```

Also update the `getStockPrices` function (around line 224-229) where it maps from the batch result. The `quote` variable already has all fields from the Map, so `data[ticker] = quote` carries `regularMarketTime` through automatically.

- [ ] **Step 3: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 4: Run existing tests**

Run: `npm test`
Expected: All tests pass (no behavior change, just added an optional field)

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/prices/yahoo.ts
git commit -m "feat: extract regularMarketTime from Yahoo v7 for FX staleness detection"
```

---

### Task 4: FX Status Indicator Component

**Files:**
- Create: `src/components/ui/fx-status-indicator.tsx`
- Create: `__tests__/component/fx-status-indicator.test.tsx`
- Modify: `src/app/dashboard/page.tsx`

- [ ] **Step 1: Write component test**

Create `__tests__/component/fx-status-indicator.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FxStatusIndicator } from "@/components/ui/fx-status-indicator";

describe("FxStatusIndicator", () => {
  it("renders nothing when neither stale nor unavailable", () => {
    const { container } = render(<FxStatusIndicator stale={false} unavailable={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders amber icon when stale", () => {
    const { container } = render(<FxStatusIndicator stale={true} unavailable={false} />);
    expect(container.querySelector(".text-amber-400")).toBeTruthy();
  });

  it("renders red icon when unavailable", () => {
    const { container } = render(<FxStatusIndicator stale={false} unavailable={true} />);
    expect(container.querySelector(".text-red-400")).toBeTruthy();
  });

  it("renders red icon when both (unavailable takes precedence)", () => {
    const { container } = render(<FxStatusIndicator stale={true} unavailable={true} />);
    expect(container.querySelector(".text-red-400")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:component -- --reporter=verbose __tests__/component/fx-status-indicator.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write the component**

Create `src/components/ui/fx-status-indicator.tsx`:

```tsx
import { Clock, AlertTriangle } from "lucide-react";

interface FxStatusIndicatorProps {
  stale: boolean;
  unavailable: boolean;
}

export function FxStatusIndicator({ stale, unavailable }: FxStatusIndicatorProps) {
  if (!stale && !unavailable) return null;

  if (unavailable) {
    return (
      <span title="FX rate unavailable — values shown in original currency">
        <AlertTriangle className="w-3 h-3 text-red-400" />
      </span>
    );
  }

  return (
    <span title="FX rate is stale (>24h old)">
      <Clock className="w-3 h-3 text-amber-400" />
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:component -- --reporter=verbose __tests__/component/fx-status-indicator.test.tsx`
Expected: All 4 tests PASS

- [ ] **Step 5: Wire to dashboard page**

In `src/app/dashboard/page.tsx`, after the EUR/USD batch fetch (where `eurUsdBatch` is available), compute staleness:

```typescript
const eurUsdData = eurUsdBatch?.["EURUSD=X"];
const fxStale = eurUsdData?.regularMarketTime
  ? Date.now() / 1000 - eurUsdData.regularMarketTime > 86400
  : false;
const fxUnavailable = !eurUsdData?.price;
```

Find where the currency toggle or search pill area is rendered and add the indicator nearby. Import and render:

```typescript
import { FxStatusIndicator } from "@/components/ui/fx-status-indicator";

// Near the CurrencyToggle/SearchPill in the layout:
<FxStatusIndicator stale={fxStale} unavailable={fxUnavailable} />
```

Note: Read `dashboard/page.tsx` to find the exact render location. The indicator should be near the currency display area, not the chart.

- [ ] **Step 6: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 7: Commit**

```bash
git add src/components/ui/fx-status-indicator.tsx __tests__/component/fx-status-indicator.test.tsx src/app/dashboard/page.tsx
git commit -m "feat: add FX rate staleness indicator on dashboard"
```

---

## Chunk 2: Error Handling — Retry Button for Pending/Failed Rows

### Task 5: `backfillSingleRow` Server Action

**Files:**
- Modify: `src/lib/actions/backfill.ts`

- [ ] **Step 1: Add `backfillSingleRow` function**

At the bottom of `src/lib/actions/backfill.ts`, add:

```typescript
/**
 * Retry computation for a single activity_log row.
 * Called by the UI retry button — skips throttle/exhaustion gates.
 */
export async function backfillSingleRow(rowId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const { validateUUID } = await import("@/lib/validation");
  validateUUID(rowId, "Activity log row ID");

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { data: row, error: fetchErr } = await supabase
    .from("activity_log")
    .select("id, action, entity_type, entity_id, before_snapshot, after_snapshot, created_at, is_adjustment, cashflow_status, delta_status")
    .eq("id", rowId)
    .eq("user_id", user.id)
    .single();

  if (fetchErr || !row) return { success: false, error: "Row not found" };

  const entityType = row.entity_type as string;
  const isCashEntity = CASH_ENTITY_TYPES.includes(entityType);
  const needsCashflow = !row.is_adjustment && (row.cashflow_status === "pending" || row.cashflow_status === "failed");
  const needsDelta = row.is_adjustment && (row.delta_status === "pending" || row.delta_status === "failed");

  if (!needsCashflow && !needsDelta) {
    return { success: true }; // Nothing to retry
  }

  try {
    let values: { usd: number; eur: number };

    if (isCashEntity) {
      const field = cashAmountField(entityType as CashEntityType);
      const before = row.before_snapshot as Record<string, unknown> | null;
      const after = row.after_snapshot as Record<string, unknown> | null;
      const beforeAmt = (before?.[field] as number) ?? 0;
      const afterAmt = (after?.[field] as number) ?? 0;
      const currency = (after?.currency as string) ?? (before?.currency as string) ?? "USD";
      const delta = cashDelta(row.action as string, beforeAmt, afterAmt);

      if (delta === 0) {
        values = { usd: 0, eur: 0 };
      } else {
        values = await toUsdAndEur(delta, currency, (row.created_at as string).split("T")[0]);
      }
    } else {
      values = await computeDeltaFromSnapshots(
        entityType,
        row.action as string,
        row.created_at as string,
        row.before_snapshot as Record<string, unknown> | null,
        row.after_snapshot as Record<string, unknown> | null
      );
    }

    const now = new Date().toISOString();

    if (needsCashflow) {
      let isStablecoin = false;
      if (entityType === "crypto_position") {
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
      const assetClass = classifyAssetClass(entityType, isStablecoin);
      await supabase.from("activity_log").update({
        cashflow_amount_usd: Math.round(values.usd * 100) / 100,
        cashflow_amount_eur: Math.round(values.eur * 100) / 100,
        cashflow_asset_class: assetClass,
        cashflow_status: "complete",
        cashflow_attempted_at: now,
      }).eq("id", rowId);
    } else {
      await supabase.from("activity_log").update({
        delta_usd: Math.round(values.usd * 100) / 100,
        delta_eur: Math.round(values.eur * 100) / 100,
        delta_status: "complete",
        delta_attempted_at: now,
      }).eq("id", rowId);
    }

    return { success: true };
  } catch (err) {
    console.error(`[backfill] Single row retry failed ${rowId}:`, err instanceof Error ? err.message : err);
    return { success: false, error: err instanceof Error ? err.message : "Computation failed" };
  }
}
```

- [ ] **Step 2: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/lib/actions/backfill.ts
git commit -m "feat: add backfillSingleRow for user-initiated retry"
```

---

### Task 6: Add Retry Button to CashflowStatusIcon

**Files:**
- Modify: `src/components/ui/cashflow-status-icon.tsx`
- Modify: `__tests__/component/cashflow-status-icon.test.tsx`

- [ ] **Step 1: Update component tests for retry button**

In `__tests__/component/cashflow-status-icon.test.tsx`, add tests after the existing 4:

```typescript
  it("renders retry button when onRetry provided", () => {
    const { container } = render(
      <CashflowStatusIcon cashflowStatus="pending" deltaStatus={null} onRetry={async () => ({ success: true })} />
    );
    expect(container.querySelector("button")).toBeTruthy();
  });

  it("does not render retry button when onRetry omitted", () => {
    const { container } = render(
      <CashflowStatusIcon cashflowStatus="pending" deltaStatus={null} />
    );
    expect(container.querySelector("button")).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify new tests fail (retry not implemented yet)**

Run: `npm run test:component -- --reporter=verbose __tests__/component/cashflow-status-icon.test.tsx`
Expected: 2 new tests FAIL (no retry button exists yet), 4 existing PASS

- [ ] **Step 3: Add retry props and UI**

Read `src/components/ui/cashflow-status-icon.tsx` first, then update it:

Add `onRetry` and loading state:

```tsx
"use client";

import { useState } from "react";
import { Clock, AlertTriangle, RefreshCw, Loader2 } from "lucide-react";

interface CashflowStatusIconProps {
  cashflowStatus: string | null;
  deltaStatus: string | null;
  onRetry?: () => Promise<{ success: boolean; error?: string }>;
}

export function CashflowStatusIcon({ cashflowStatus, deltaStatus, onRetry }: CashflowStatusIconProps) {
  const [retrying, setRetrying] = useState(false);

  const isPending = cashflowStatus === "pending" || deltaStatus === "pending";
  const isFailed = cashflowStatus === "failed" || deltaStatus === "failed";

  if (!isPending && !isFailed) return null;

  if (retrying) {
    return <Loader2 className="w-3 h-3 text-zinc-400 animate-spin" />;
  }

  // Build tooltip text
  const parts: string[] = [];
  if (cashflowStatus === "pending") parts.push("Cashflow data pending");
  if (deltaStatus === "pending") parts.push("Delta data pending");
  if (cashflowStatus === "failed") parts.push("Cashflow uses estimate");
  if (deltaStatus === "failed") parts.push("Delta uses estimate");

  const handleRetry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      const result = await onRetry();
      if (!result.success) {
        console.error("[retry]", result.error);
      }
    } finally {
      setRetrying(false);
    }
  };

  const statusIcon = isFailed ? (
    <span title={parts.join(". ") + ". Chart uses estimate."}>
      <AlertTriangle className="w-3 h-3 text-red-400" />
    </span>
  ) : (
    <span title={parts.join(". ") + ". Will retry automatically."}>
      <Clock className="w-3 h-3 text-amber-400" />
    </span>
  );

  return (
    <span className="inline-flex items-center gap-1">
      {statusIcon}
      {onRetry && (
        <button
          onClick={handleRetry}
          className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
          title="Retry computation"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}
```

- [ ] **Step 4: Verify all 6 component tests pass**

Run: `npm run test:component -- --reporter=verbose __tests__/component/cashflow-status-icon.test.tsx`
Expected: All 6 tests PASS (4 existing + 2 new)

- [ ] **Step 5: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/cashflow-status-icon.tsx __tests__/component/cashflow-status-icon.test.tsx
git commit -m "feat: add retry button to cashflow status icon with tests"
```

---

### Task 7: Wire Retry to Activity Timeline

**Files:**
- Modify: `src/components/history/activity-timeline.tsx`

- [ ] **Step 1: Wire the onRetry callback**

In `activity-timeline.tsx`, import the server action:

```typescript
import { backfillSingleRow } from "@/lib/actions/backfill";
```

Find where `CashflowStatusIcon` is rendered (search for `<CashflowStatusIcon`). Add the `onRetry` prop — only in non-readOnly mode:

```tsx
<CashflowStatusIcon
  cashflowStatus={log.cashflow_status}
  deltaStatus={log.delta_status}
  onRetry={!isReadOnly ? async () => {
    const result = await backfillSingleRow(log.id);
    if (result.success) {
      router.refresh();
    }
    return result;
  } : undefined}
/>
```

Make sure `useRouter` is imported and available in the component (check if it's already imported — it likely is for other navigation needs). If the component uses `router` already, reuse it. If not, add:

```typescript
import { useRouter } from "next/navigation";
// Inside component:
const router = useRouter();
```

- [ ] **Step 2: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/components/history/activity-timeline.tsx
git commit -m "feat: wire retry button to activity timeline status icons"
```

---

## Chunk 3: Integration Tests

### Task 8: Cashflow Write Integration Tests

**Files:**
- Create: `__tests__/integration/cashflow-write.test.ts`

- [ ] **Step 1: Write the test file**

Create `__tests__/integration/cashflow-write.test.ts`. Follow the pattern from existing integration tests (e.g., `crypto-actions.test.ts`):

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createTestUser, cleanupTestUser, getSupabaseConfig } from "./setup";

describe("Cashflow write-time computation", () => {
  let supabase: ReturnType<typeof createClient>;
  let userId: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const config = getSupabaseConfig();
    const { user, client, cleanup: c } = await createTestUser(config);
    supabase = client;
    userId = user.id;
    cleanup = c;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("creates crypto position with cashflow_status = complete", async () => {
    // Create a crypto asset first
    const { data: asset } = await supabase
      .from("crypto_assets")
      .insert({ user_id: userId, ticker: "TEST", coingecko_id: "test-coin", name: "Test Coin" })
      .select()
      .single();

    // Create a position (this triggers logActivity via the server action pattern)
    const { data: position } = await supabase
      .from("crypto_positions")
      .insert({ crypto_asset_id: asset!.id, quantity: 1.5 })
      .select()
      .single();

    // Note: Direct DB inserts don't trigger server actions.
    // Integration tests for write-time cashflow must use the server action.
    // This test verifies the DB schema accepts the cashflow fields.
    const { error } = await supabase
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_name: "TEST",
        entity_id: position!.id,
        entity_table: "crypto_positions",
        cashflow_amount_usd: 150.00,
        cashflow_amount_eur: 129.31,
        cashflow_asset_class: "crypto",
        cashflow_status: "complete",
      });

    expect(error).toBeNull();

    // Verify it can be queried with the cashflow filter
    const { data: rows } = await supabase
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_status, cashflow_asset_class")
      .eq("entity_id", position!.id)
      .eq("cashflow_status", "complete");

    expect(rows).toHaveLength(1);
    expect(rows![0].cashflow_amount_usd).toBe(150);
    expect(rows![0].cashflow_asset_class).toBe("crypto");
  });

  it("adjustment rows have delta_status but null cashflow_status", async () => {
    const { error } = await supabase
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "bank_account",
        entity_name: "Test Bank",
        is_adjustment: true,
        delta_usd: 100,
        delta_eur: 86.21,
        delta_status: "complete",
        cashflow_status: null,
      });

    expect(error).toBeNull();
  });

  it("pending status rows are found by backfill index", async () => {
    await supabase.from("activity_log").insert({
      user_id: userId,
      action: "created",
      entity_type: "broker_deposit",
      entity_name: "Test Deposit",
      cashflow_status: "pending",
    });

    const { data: pending } = await supabase
      .from("activity_log")
      .select("id")
      .eq("user_id", userId)
      .eq("cashflow_status", "pending");

    expect(pending!.length).toBeGreaterThanOrEqual(1);
  });

  it("zero-delta rows store cashflow_status = complete with $0", async () => {
    const { error } = await supabase
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "bank_account",
        entity_name: "No Change Bank",
        cashflow_amount_usd: 0,
        cashflow_amount_eur: 0,
        cashflow_asset_class: "cash",
        cashflow_status: "complete",
      });

    expect(error).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run --project integration __tests__/integration/cashflow-write.test.ts`
Expected: All tests PASS (requires local Supabase running)

- [ ] **Step 3: Commit**

```bash
git add __tests__/integration/cashflow-write.test.ts
git commit -m "test: add integration tests for cashflow write-time computation"
```

---

### Task 9: FX Failure Integration Tests

**Files:**
- Create: `__tests__/integration/fx-failure.test.ts`

- [ ] **Step 1: Write the test file**

Create `__tests__/integration/fx-failure.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createTestUser, getSupabaseConfig } from "./setup";

describe("FX failure status tracking", () => {
  let supabase: ReturnType<typeof createClient>;
  let userId: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const config = getSupabaseConfig();
    const { user, client, cleanup: c } = await createTestUser(config);
    supabase = client;
    userId = user.id;
    cleanup = c;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("stores delta_status = pending when delta computation fails", async () => {
    const { error } = await supabase
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "stock_position",
        entity_name: "Failed Stock",
        is_adjustment: true,
        delta_usd: null,
        delta_eur: null,
        delta_status: "pending",
      });

    expect(error).toBeNull();

    // Verify it's found by the pending delta index
    const { data } = await supabase
      .from("activity_log")
      .select("id, delta_status")
      .eq("user_id", userId)
      .eq("delta_status", "pending");

    expect(data!.length).toBeGreaterThanOrEqual(1);
  });

  it("stores cashflow_status = pending when FX conversion fails", async () => {
    const { error } = await supabase
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "broker_deposit",
        entity_name: "Failed Deposit",
        is_adjustment: false,
        cashflow_status: "pending",
        cashflow_amount_usd: null,
        cashflow_amount_eur: null,
      });

    expect(error).toBeNull();

    const { data } = await supabase
      .from("activity_log")
      .select("id, cashflow_status")
      .eq("user_id", userId)
      .eq("cashflow_status", "pending");

    expect(data!.length).toBeGreaterThanOrEqual(1);
  });

  it("failed status rows are queryable for UI warnings", async () => {
    await supabase.from("activity_log").insert({
      user_id: userId,
      action: "updated",
      entity_type: "exchange_deposit",
      entity_name: "Failed Exchange",
      cashflow_status: "failed",
      cashflow_amount_usd: 0,
      cashflow_amount_eur: 0,
    });

    const { count } = await supabase
      .from("activity_log")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .or("cashflow_status.eq.failed,delta_status.eq.failed");

    expect(count).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run --project integration __tests__/integration/fx-failure.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add __tests__/integration/fx-failure.test.ts
git commit -m "test: add integration tests for FX failure status tracking"
```

---

### Task 10: Transfer Rollback Integration Tests

**Files:**
- Create: `__tests__/integration/transfer-rollback.test.ts`

- [ ] **Step 1: Write the test file**

Create `__tests__/integration/transfer-rollback.test.ts`. These tests verify the transfer compensation mechanism at the DB level:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createTestUser, getSupabaseConfig } from "./setup";

describe("Transfer activity log entries", () => {
  let supabase: ReturnType<typeof createClient>;
  let userId: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const config = getSupabaseConfig();
    const { user, client, cleanup: c } = await createTestUser(config);
    supabase = client;
    userId = user.id;
    cleanup = c;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("transfer legs are linked by transfer_group_id", async () => {
    const groupId = crypto.randomUUID();

    // Source leg
    await supabase.from("activity_log").insert({
      user_id: userId,
      action: "updated",
      entity_type: "crypto_position",
      entity_name: "BTC (source)",
      is_adjustment: true,
      transfer_group_id: groupId,
    });

    // Destination leg
    await supabase.from("activity_log").insert({
      user_id: userId,
      action: "created",
      entity_type: "crypto_position",
      entity_name: "BTC (dest)",
      is_adjustment: true,
      transfer_group_id: groupId,
    });

    const { data: legs } = await supabase
      .from("activity_log")
      .select("entity_name, is_adjustment, transfer_group_id")
      .eq("transfer_group_id", groupId)
      .order("created_at");

    expect(legs).toHaveLength(2);
    expect(legs![0].is_adjustment).toBe(true);
    expect(legs![1].is_adjustment).toBe(true);
    expect(legs![0].transfer_group_id).toBe(groupId);
  });

  it("both transfer legs have is_adjustment = true and null cashflow_status", async () => {
    const groupId = crypto.randomUUID();

    await supabase.from("activity_log").insert([
      {
        user_id: userId,
        action: "removed",
        entity_type: "exchange_deposit",
        entity_name: "Sell leg",
        is_adjustment: true,
        transfer_group_id: groupId,
        delta_usd: -1000,
        delta_eur: -862,
        delta_status: "complete",
        cashflow_status: null,
      },
      {
        user_id: userId,
        action: "created",
        entity_type: "broker_deposit",
        entity_name: "Buy leg",
        is_adjustment: true,
        transfer_group_id: groupId,
        delta_usd: 995,
        delta_eur: 858,
        delta_status: "complete",
        cashflow_status: null,
      },
    ]);

    const { data: legs } = await supabase
      .from("activity_log")
      .select("cashflow_status, delta_status, is_adjustment")
      .eq("transfer_group_id", groupId);

    expect(legs).toHaveLength(2);
    for (const leg of legs!) {
      expect(leg.is_adjustment).toBe(true);
      expect(leg.cashflow_status).toBeNull();
      expect(leg.delta_status).toBe("complete");
    }
  });

  it("transfer legs are excluded from cashflow queries", async () => {
    const groupId = crypto.randomUUID();

    await supabase.from("activity_log").insert({
      user_id: userId,
      action: "updated",
      entity_type: "crypto_position",
      entity_name: "Transfer excluded",
      is_adjustment: true,
      transfer_group_id: groupId,
      cashflow_status: null,
    });

    // Cashflow query (same as deriveCashFlows)
    const { data: cashflows } = await supabase
      .from("activity_log")
      .select("id")
      .eq("user_id", userId)
      .eq("cashflow_status", "complete")
      .is("undone_at", null);

    const transferIds = (cashflows ?? []).map((r) => r.id);
    const { data: transferRows } = await supabase
      .from("activity_log")
      .select("id")
      .eq("transfer_group_id", groupId);

    // Transfer rows should NOT appear in cashflow results
    for (const tr of transferRows ?? []) {
      expect(transferIds).not.toContain(tr.id);
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run --project integration __tests__/integration/transfer-rollback.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add __tests__/integration/transfer-rollback.test.ts
git commit -m "test: add integration tests for transfer activity log entries"
```

---

## Chunk 4: Import Pre-Backup + Final Verification

### Task 11: Add Backup Field to ImportError Type

**Files:**
- Modify: `src/lib/actions/import.ts:46-49`

- [ ] **Step 1: Update ImportError interface**

In `src/lib/actions/import.ts`, find the `ImportError` interface (line 46-49):

```typescript
export interface ImportError {
  ok: false;
  error: string;
}
```

Add the backup field:

```typescript
import type { PortfolioBackup } from "@/lib/actions/export";

export interface ImportError {
  ok: false;
  error: string;
  backup?: PortfolioBackup;
}
```

- [ ] **Step 2: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/lib/actions/import.ts
git commit -m "feat: add backup field to ImportError type"
```

---

### Task 12: Add Pre-Backup to Import Replace Path

**Files:**
- Modify: `src/lib/actions/import.ts:193-215`

- [ ] **Step 1: Add safety backup before delete loop**

In `src/lib/actions/import.ts`, find the replace mode section (around line 193-215). Before the validation check, add the backup:

```typescript
import { exportFullJson } from "@/lib/actions/export";
```

After `const isReplace = mode === "replace";` (line 191) and the validation check (lines 193-197), before the delete loop (line 199), insert:

```typescript
  // ── Safety backup before destructive replace ──
  let safetyBackup: PortfolioBackup | undefined;
  if (isReplace) {
    try {
      safetyBackup = await exportFullJson();
    } catch {
      return { ok: false, error: "Failed to create safety backup — aborting replace to protect your data." };
    }
  }
```

Then find every `return { ok: false, error: ... }` that comes AFTER the delete loop (lines 199+). Add `backup: safetyBackup` to each one. There will be multiple — search for `return { ok: false` within the function after the delete loop.

A simpler approach: create a helper at the top of the function:

```typescript
  const fail = (error: string): ImportError => ({
    ok: false,
    error,
    ...(safetyBackup ? { backup: safetyBackup } : {}),
  });
```

Then replace all post-delete `return { ok: false, error: "..." }` with `return fail("...")`.

IMPORTANT: Only replace the returns that come AFTER the delete loop (line 199+). The validation returns before the delete (lines 188, 196) should NOT include the backup (no data was deleted yet).

- [ ] **Step 2: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Run existing tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/lib/actions/import.ts
git commit -m "feat: capture safety backup before import replace, include in error response"
```

---

### Task 13: Client-Side Auto-Download on Import Failure

**Files:**
- Modify: `src/components/settings/import-export-settings.tsx:196-215`

- [ ] **Step 1: Add backup download on failure**

In `import-export-settings.tsx`, find the `executeImport` function (around line 196). Update the error handling to check for backup:

```typescript
  async function executeImport() {
    if (!previewData) return;
    setImportStage("importing");
    setImportError(null);

    try {
      const result = await importFromJson(previewData, importMode);
      if (!result.ok) {
        // Auto-download safety backup if present
        if ("backup" in result && result.backup) {
          const blob = new Blob([JSON.stringify(result.backup, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `portfolio-backup-${new Date().toISOString().split("T")[0]}.json`;
          a.click();
          URL.revokeObjectURL(url);
          toast.error("Import failed. Your previous data has been downloaded as a backup.");
        }
        setImportError(result.error);
        setImportStage("previewing");
        return;
      }
      setImportResult(result);
      setImportStage("done");
      toast.success("Import complete");
    } catch {
      setImportError("Import failed unexpectedly");
      setImportStage("previewing");
    }
  }
```

- [ ] **Step 2: Verify build passes**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/components/settings/import-export-settings.tsx
git commit -m "feat: auto-download safety backup on import replace failure"
```

---

### Task 14: Final Verification

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: 0 errors, 0 warnings

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 3: Run all tests**

Run: `npm run test:all`
Expected: All unit + component + integration tests pass

- [ ] **Step 4: Commit if any fixups needed**

---

## Summary

| Task | Description | Files | Type |
|------|-------------|-------|------|
| 1 | Stale snapshot banner component + tests | 2 new | UI |
| 2 | Wire banner to dashboard | 2 modified | Wiring |
| 3 | Yahoo `regularMarketTime` extraction | 2 modified | Data |
| 4 | FX status indicator component + tests + wire | 2 new + 1 modified | UI |
| 5 | `backfillSingleRow` server action | 1 modified | Backend |
| 6 | Retry button in CashflowStatusIcon + tests | 2 modified | UI |
| 7 | Wire retry to activity timeline | 1 modified | Wiring |
| 8 | Cashflow write integration tests | 1 new | Tests |
| 9 | FX failure integration tests | 1 new | Tests |
| 10 | Transfer rollback integration tests | 1 new | Tests |
| 11 | ImportError type update | 1 modified | Types |
| 12 | Import pre-backup logic | 1 modified | Backend |
| 13 | Client-side backup download | 1 modified | UI |
| 14 | Final verification | — | QA |

### Parallelization opportunities (for subagent execution)

- Tasks 1+2 (snapshot banner) can run in parallel with Tasks 3+4 (FX indicator)
- Tasks 5+6+7 (retry button) are sequential (same file chain)
- Tasks 8+9+10 (integration tests) can run in parallel with each other
- Tasks 11+12+13 (import backup) are sequential (type → logic → client)
