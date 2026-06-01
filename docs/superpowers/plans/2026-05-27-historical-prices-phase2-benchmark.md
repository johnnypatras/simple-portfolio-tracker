# Historical-Price Chart Augmentation — Phase 2 (S&P Benchmark) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Prerequisite:** Phase 1 (`2026-05-27-historical-prices-phase1-portfolio.md`) must be fully implemented and green first. Phase 2 builds directly on its module, types, and cached prices.

**Goal:** Extend the S&P 500 benchmark line back over the same range Phase 1 extended the portfolio line, so the comparison is coherent ("your 2021 BTC vs the S&P since 2021").

**Architecture:** Two surgical changes — no benchmark-algorithm rewrite. (1) Extend the `^SP500TR` history fetch back to the earliest backdated purchase date. (2) Inject **synthetic** benchmark cash flows for `is_adjustment` backdated lots (the ones `deriveCashFlows` deliberately excludes), valued at `qty × historical_price(effective_date) × fx` — the *same* value Phase 1 puts on the portfolio line, so the existing S&P-units seed reconciles to ~0 delta automatically. Non-adjustment backdated lots are already cash flows in `deriveCashFlows` and need no synthetic event.

**Tech Stack:** Same as Phase 1. Touches `benchmark.ts`, the Phase 1 synthesis module (additive), and the two pages that render the S&P benchmark line (`dashboard/page.tsx`, `share/[token]/page.tsx`).

**Spec:** `docs/superpowers/specs/2026-05-27-historical-prices-augmentation-design.md` (Phase 2 section + Open Question 2 — resolved below).
**Branch:** `feat/historical-prices-chart`. **Merge to `main` only after Phase 2 is complete** (the spec's deploy-together rule — shipping Phase 1 alone leaves an incoherent half-extended chart on the live app).

---

## Why this is correct (resolves spec Open Question 2)

The S&P benchmark (`enrichCashFlowAdjusted`, `chart-enrichment.ts:221`) works in two parts:
1. **Units replay:** for each `CashFlowEvent`, buy `amount_usd / sp500Price(date)` S&P units. Pre-`chartStart` flows accumulate into `preChartUnits`.
2. **Seed:** force `preChartUnits` so the benchmark *starts* at the adjusted portfolio value at `chartStart` (= `points[0].date`).

`deriveCashFlows` (`benchmark.ts:20`) sources `amount_usd` from the pre-computed `cashflow_amount_usd` column and **excludes `is_adjustment` rows** (it filters `cashflow_status='complete'`; adjustments have cashflow cleared). It dates events by `COALESCE(effective_date, created_at)`.

After Phase 1, `chartStart` moves back to the earliest backdated `effective_date`. Three cases:

| Backdated lot type | In `deriveCashFlows`? | What Phase 2 must do |
|---|---|---|
| `is_adjustment=false` (real backdated buy) | **Yes**, at `effective_date`, amount = `qty × historical_price(effective_date)` | Nothing extra — already a cash flow. Just extend `sp500History` so its date has an S&P price. |
| `is_adjustment=true` (balance correction) | **No** (excluded) | Inject a synthetic cash flow at `effective_date`, valued identically. |
| Single `is_adjustment` lot only | No | Synthetic flow at `chartStart`; the seed alone would also suffice, but the synthetic flow keeps the multi-lot path uniform. |

**Seed reconciliation:** because both the synthetic amount and the non-adjustment `cashflow_amount` equal `qty × historical_price(effective_date)` — the same number Phase 1's `lotContributionAtDate` puts on the portfolio line at `chartStart` — the seed's `neededUnits = adjustedFirstUsd / sp500StartPrice` ≈ the units the replay already bought. `seedDelta ≈ 0`. No seed-logic change needed.

**No double-count:** synthetic flows are emitted only for `is_adjustment` deltas (absent from `deriveCashFlows`); real flows only for non-adjustment deltas. Disjoint by construction.

---

## File Structure

**Modified files:**
- `src/lib/portfolio/historical-prices-augmentation.ts` — additive: carry `is_adjustment` through `ActivityForLot` → `QtyDelta` → `buildHistoricalLots`; add the pure `buildBenchmarkCashFlows`. (Phase 1 tests stay green — the field is optional.)
- `src/lib/actions/benchmark.ts` — add the `getHistoricalBenchmarkExtension(userId?)` server action (mirrors `deriveCashFlows`' client-selection).
- `src/app/dashboard/page.tsx` — extend the `^SP500TR` range + merge synthetic cash flows.
- `src/app/share/[token]/page.tsx` — same, with the admin client + explicit `ownerUserId`.

**Test files:**
- `__tests__/unit/historical-prices-augmentation.test.ts` — extend for `buildBenchmarkCashFlows` + `is_adjustment` threading.
- `__tests__/unit/chart-enrichment.test.ts` (or the existing benchmark test file) — extended-range seed reconciliation + multi-lot.
- `__tests__/integration/historical-benchmark-extension.test.ts` — `getHistoricalBenchmarkExtension` end-to-end.

---

## Task 1: Thread `is_adjustment` through the lot pipeline

**Files:**
- Modify: `src/lib/portfolio/historical-prices-augmentation.ts`
- Test: `__tests__/unit/historical-prices-augmentation.test.ts`

Additive change so `buildBenchmarkCashFlows` (Task 2) can emit synthetic flows only for adjustment deltas. Optional field → Phase 1 tests unaffected.

- [ ] **Step 1: Write the failing test (append to the Phase 1 test file)**

```typescript
describe("buildHistoricalLots — is_adjustment threading (Phase 2)", () => {
  it("propagates is_adjustment from activity rows onto each delta", () => {
    const rows: ActivityForLot[] = [
      {
        entity_id: "btc-1",
        entity_type: "crypto_position",
        action: "create",
        effective_date: "2021-01-01",
        created_at: "2026-05-20T10:00:00Z",
        before_quantity: null,
        after_quantity: 2,
        is_adjustment: true,
        asset_kind: "crypto",
        asset_key: "bitcoin",
        fetch_symbol: "BTC-USD",
        native_currency: "USD",
        asset_class: "crypto",
      },
    ];
    const lots = buildHistoricalLots(rows);
    expect(lots[0].deltas[0].is_adjustment).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/unit/historical-prices-augmentation.test.ts -t "is_adjustment threading"`
Expected: FAIL — `ActivityForLot` has no `is_adjustment`; `QtyDelta.is_adjustment` is undefined.

- [ ] **Step 3: Add the optional field and thread it**

In `src/lib/portfolio/historical-prices-augmentation.ts`:

Extend `QtyDelta`:
```typescript
export type QtyDelta = {
  effective_date: string;
  qty_delta: number;
  /** Phase 2: true when this delta came from an is_adjustment activity row
   *  (excluded from deriveCashFlows → needs a synthetic benchmark cash flow). */
  is_adjustment?: boolean;
};
```

Extend `ActivityForLot` (add the field):
```typescript
  // ...existing fields...
  is_adjustment: boolean;
```

In `buildHistoricalLots`, when pushing a delta, carry it:
```typescript
      deltas.push({
        effective_date: r.effective_date ?? day,
        qty_delta: qtyDelta,
        is_adjustment: r.is_adjustment,
      });
```

In `fetchHistoricalPriceInputsFor`, add `is_adjustment` to both activity selects and to the `activity.push({...})` mapping for crypto and stock:
```typescript
// in both .select(...) strings, add is_adjustment:
"entity_id, action, effective_date, created_at, before_snapshot, after_snapshot, is_adjustment"
// in both activity.push({...}) blocks:
      is_adjustment: (r.is_adjustment as boolean) ?? false,
```

- [ ] **Step 4: Run to verify pass (and Phase 1 suite still green)**

Run: `npx vitest run __tests__/unit/historical-prices-augmentation.test.ts`
Expected: PASS — all Phase 1 tests plus the new threading test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/portfolio/historical-prices-augmentation.ts __tests__/unit/historical-prices-augmentation.test.ts
git commit -m "feat: thread is_adjustment through historical lot pipeline (Phase 2 prep)"
```

---

## Task 2: Pure `buildBenchmarkCashFlows`

**Files:**
- Modify: `src/lib/portfolio/historical-prices-augmentation.ts`
- Test: `__tests__/unit/historical-prices-augmentation.test.ts`

Emit one `CashFlowEvent` per **`is_adjustment` delta**, valued at `qty_delta × historical_price(effective_date) × usdRate` — matching the portfolio-line value at that date so the S&P seed reconciles. Buys (+qty) → positive (money in), sells (−qty) → negative (money out).

- [ ] **Step 1: Write the failing tests (append)**

```typescript
import { buildBenchmarkCashFlows } from "@/lib/portfolio/historical-prices-augmentation";
import type { CashFlowEvent } from "@/lib/types";

describe("buildBenchmarkCashFlows", () => {
  const prices: HistoricalPriceRow[] = [
    px("crypto", "bitcoin", "2021-01-01", 30000),
    px("crypto", "bitcoin", "2023-06-01", 27000),
    px("fx", "EUR", "2021-01-01", 1.2),
    px("fx", "EUR", "2023-06-01", 1.08),
  ];

  it("emits a positive flow for an is_adjustment buy, valued qty × price × usdRate", () => {
    const lots: HistoricalLot[] = [
      {
        position_id: "btc-1",
        asset_kind: "crypto",
        asset_key: "bitcoin",
        fetch_symbol: "BTC-USD",
        native_currency: "USD",
        asset_class: "crypto",
        capture_date: "2026-05-01",
        deltas: [{ effective_date: "2021-01-01", qty_delta: 2, is_adjustment: true }],
      },
    ];
    const flows = buildBenchmarkCashFlows(lots, prices);
    expect(flows).toHaveLength(1);
    expect(flows[0].date).toBe("2021-01-01");
    expect(flows[0].amount_usd).toBeCloseTo(2 * 30000, 2); // 60000 USD deployed
    expect(flows[0].amount_eur).toBeCloseTo((2 * 30000) / 1.2, 2);
    expect(flows[0].asset_class).toBe("crypto");
  });

  it("emits a negative flow for an is_adjustment sell", () => {
    const lots: HistoricalLot[] = [
      {
        position_id: "btc-1",
        asset_kind: "crypto",
        asset_key: "bitcoin",
        fetch_symbol: "BTC-USD",
        native_currency: "USD",
        asset_class: "crypto",
        capture_date: "2026-05-01",
        deltas: [
          { effective_date: "2021-01-01", qty_delta: 2, is_adjustment: true },
          { effective_date: "2023-06-01", qty_delta: -1, is_adjustment: true },
        ],
      },
    ];
    const flows = buildBenchmarkCashFlows(lots, prices).sort((a, b) => a.date.localeCompare(b.date));
    expect(flows[1].amount_usd).toBeCloseTo(-1 * 27000, 2); // -27000 (money out)
  });

  it("ignores non-adjustment deltas (already in deriveCashFlows — no double-count)", () => {
    const lots: HistoricalLot[] = [
      {
        position_id: "btc-1",
        asset_kind: "crypto",
        asset_key: "bitcoin",
        fetch_symbol: "BTC-USD",
        native_currency: "USD",
        asset_class: "crypto",
        capture_date: "2026-05-01",
        deltas: [{ effective_date: "2021-01-01", qty_delta: 2, is_adjustment: false }],
      },
    ];
    expect(buildBenchmarkCashFlows(lots, prices)).toEqual([]);
  });

  it("skips a delta when no historical price exists at-or-before its date", () => {
    const lots: HistoricalLot[] = [
      {
        position_id: "btc-1",
        asset_kind: "crypto",
        asset_key: "bitcoin",
        fetch_symbol: "BTC-USD",
        native_currency: "USD",
        asset_class: "crypto",
        capture_date: "2026-05-01",
        deltas: [{ effective_date: "2020-01-01", qty_delta: 2, is_adjustment: true }],
      },
    ];
    // Earliest price is 2021-01-01 → nothing on-or-before 2020-01-01 → skip.
    expect(buildBenchmarkCashFlows(lots, prices)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/unit/historical-prices-augmentation.test.ts -t "buildBenchmarkCashFlows"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement `buildBenchmarkCashFlows`**

Append to `src/lib/portfolio/historical-prices-augmentation.ts`. (Add `import type { CashFlowEvent } from "@/lib/types";` to the top imports.)

```typescript
/**
 * Synthetic benchmark cash flows for is_adjustment backdated lots — the lots
 * deriveCashFlows excludes. One event per is_adjustment delta, at its
 * effective_date, valued qty_delta × historical_price(date) × usdRate.
 *
 * Valuing at the same historical price Phase 1 puts on the portfolio line makes
 * the S&P-units seed (chart-enrichment.ts) reconcile to ~0 delta. Buys (+qty)
 * are positive (money deployed), sells (−qty) negative (money withdrawn) — the
 * same sign convention as deriveCashFlows.
 *
 * Pure. Non-adjustment deltas are skipped (already present in deriveCashFlows).
 * A delta with no price at-or-before its date is skipped (never fabricated).
 */
export function buildBenchmarkCashFlows(
  lots: HistoricalLot[],
  prices: HistoricalPriceRow[],
): CashFlowEvent[] {
  if (lots.length === 0) return [];
  const priceIndex = buildPriceIndex(prices);
  const fxIndex = priceIndex;
  const events: CashFlowEvent[] = [];

  for (const lot of lots) {
    const series = priceIndex.get(`${lot.asset_kind}:${lot.asset_key}`);
    if (!series) continue;
    for (const d of lot.deltas) {
      if (d.is_adjustment !== true) continue;
      if (!Number.isFinite(d.qty_delta) || d.qty_delta === 0) continue;

      const priceNative = findPriceAtOrBefore(series, d.effective_date);
      if (priceNative === null || !Number.isFinite(priceNative) || priceNative <= 0) continue;

      const usdRate = usdPerUnit(fxIndex, lot.native_currency, d.effective_date);
      if (usdRate === null || !Number.isFinite(usdRate) || usdRate <= 0) continue;

      const amountUsd = d.qty_delta * priceNative * usdRate;
      if (!Number.isFinite(amountUsd)) continue;

      const usdPerEur = usdPerUnit(fxIndex, "EUR", d.effective_date);
      const amountEur =
        usdPerEur !== null && Number.isFinite(usdPerEur) && usdPerEur > 0
          ? amountUsd / usdPerEur
          : undefined;

      events.push({
        date: d.effective_date,
        amount_usd: amountUsd,
        amount_eur: amountEur,
        asset_class: lot.asset_class,
      });
    }
  }
  return events;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run __tests__/unit/historical-prices-augmentation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/portfolio/historical-prices-augmentation.ts __tests__/unit/historical-prices-augmentation.test.ts
git commit -m "feat: buildBenchmarkCashFlows (synthetic S&P cash flows for is_adjustment backdated lots)"
```

---

## Task 3: Server helper — `getHistoricalBenchmarkExtension`

**Files:**
- Modify: `src/lib/actions/benchmark.ts`
- Test: `__tests__/integration/historical-benchmark-extension.test.ts`

A `"use server"` wrapper mirroring `deriveCashFlows(userId?)`'s client selection. Returns the earliest backdated date (to size the S&P fetch) and the synthetic cash flows (to merge into the chart's `cashFlows`).

- [ ] **Step 1: Implement the server action**

Append to `src/lib/actions/benchmark.ts`:

```typescript
import {
  fetchHistoricalPriceInputsFor,
  buildBenchmarkCashFlows,
} from "@/lib/portfolio/historical-prices-augmentation";
import type { CashFlowEvent } from "@/lib/types";

/**
 * Phase 2: inputs for extending the S&P benchmark back over Phase 1's
 * synthesized range.
 *   - earliestDate: the earliest backdated effective_date (null if none) — the
 *     caller sizes the ^SP500TR history fetch to reach it.
 *   - syntheticCashFlows: benchmark-only cash flows for is_adjustment backdated
 *     lots (absent from deriveCashFlows). Merge into the chart's cashFlows.
 *
 * Client selection mirrors deriveCashFlows: explicit userId → admin client
 * (cross-user share/comparison); omitted → authenticated server client (RLS).
 * Prices are already cached by Phase 1's getSnapshots on the same render, so
 * this is a cheap cache read in the common case.
 */
export async function getHistoricalBenchmarkExtension(
  userId?: string,
): Promise<{ earliestDate: string | null; syntheticCashFlows: CashFlowEvent[] }> {
  if (userId) validateUUID(userId, "User ID");
  const supabase = userId ? createAdminClient() : await createServerSupabaseClient();
  const resolvedUserId = userId ?? (await supabase.auth.getUser()).data.user?.id;
  if (!resolvedUserId) return { earliestDate: null, syntheticCashFlows: [] };

  const { lots, prices } = await fetchHistoricalPriceInputsFor(supabase, resolvedUserId);
  if (lots.length === 0) return { earliestDate: null, syntheticCashFlows: [] };

  let earliestDate: string | null = null;
  for (const lot of lots) {
    for (const d of lot.deltas) {
      if (earliestDate === null || d.effective_date < earliestDate) {
        earliestDate = d.effective_date;
      }
    }
  }

  return {
    earliestDate,
    syntheticCashFlows: buildBenchmarkCashFlows(lots, prices),
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Write the integration test**

Create `__tests__/integration/historical-benchmark-extension.test.ts`. Seed (via the admin client) a user with: a backdated `is_adjustment=true` crypto activity row (effective ~2 years back) + matching `historical_prices` rows for its coin + EUR fx. Assert:

```typescript
// (use the project's integration setup helpers — match the real exports)
describe("getHistoricalBenchmarkExtension", () => {
  it("returns the earliest backdated date and a synthetic cash flow for the is_adjustment lot", async () => {
    // ...seed user + crypto_asset(bitcoin) + crypto_position + is_adjustment
    //    activity_log entry (effective_date 2-yr-back, after.quantity=2) +
    //    historical_prices rows (crypto:bitcoin + fx:EUR covering the range)...
    const { earliestDate, syntheticCashFlows } = await getHistoricalBenchmarkExtension(testUserId);
    expect(earliestDate).toBe("<the backdated effective_date>");
    expect(syntheticCashFlows).toHaveLength(1);
    expect(syntheticCashFlows[0].amount_usd).toBeGreaterThan(0);
    expect(syntheticCashFlows[0].asset_class).toBe("crypto");
  });

  it("returns {null, []} for a user with no backdated lots", async () => {
    const res = await getHistoricalBenchmarkExtension(otherUserId);
    expect(res).toEqual({ earliestDate: null, syntheticCashFlows: [] });
  });
});
```

- [ ] **Step 4: Run the integration test**

Run (local Supabase up): `npx vitest run --project integration __tests__/integration/historical-benchmark-extension.test.ts`
Expected: PASS (re-run on transient signUp flakiness).

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/benchmark.ts __tests__/integration/historical-benchmark-extension.test.ts
git commit -m "feat: getHistoricalBenchmarkExtension (earliest date + synthetic S&P cash flows)"
```

---

## Task 4: Wire into the dashboard chart

**Files:**
- Modify: `src/app/dashboard/page.tsx` (the parallel fetch at lines 46-52 + the `cashFlows` derivation at line 66)

Extend the `^SP500TR` range to reach the earliest backdated date, and merge synthetic cash flows into the array passed to both `DashboardGrid` and `PortfolioChart`.

- [ ] **Step 1: Fetch the benchmark extension and compute the S&P range**

In `src/app/dashboard/page.tsx`, add the import (alongside the existing `deriveCashFlows` import at line 7):
```typescript
import { deriveCashFlows, getHistoricalBenchmarkExtension } from "@/lib/actions/benchmark";
```

The current parallel block fetches the S&P with a fixed `ALL_SNAPSHOTS_DAYS`. Because the synthesized chart can begin earlier than that, the S&P history must reach `earliestDate`. Restructure so the extension resolves first (cheap — prices are cached by `getSnapshots` on the same render), then size the S&P fetch:

Replace the existing `Promise.all([...])` (lines ~45-52) with:
```typescript
  const benchmarkExtension = await getHistoricalBenchmarkExtension();

  // Size the S&P history so it reaches the earliest synthesized (backdated)
  // date. fetchIndexHistory uses explicit period1/period2, so a large `days`
  // is honored (no range=max downsampling). Fall back to ALL_SNAPSHOTS_DAYS
  // when there are no backdated lots.
  const sp500Days = benchmarkExtension.earliestDate
    ? Math.max(
        ALL_SNAPSHOTS_DAYS,
        Math.ceil(
          (Date.now() - new Date(`${benchmarkExtension.earliestDate}T00:00:00Z`).getTime()) /
            86_400_000,
        ),
      )
    : ALL_SNAPSHOTS_DAYS;

  const [chartSnapshots, sp500TRHistory, cashFlowResult, adjustmentDeltas] = await Promise.all([
    getSnapshots(ALL_SNAPSHOTS_DAYS),
    fetchIndexHistory("^SP500TR", sp500Days),
    deriveCashFlows(),
    getAdjustmentDeltas(),
  ]);
```

> `getSnapshots(ALL_SNAPSHOTS_DAYS)` stays as-is — Phase 1's `augmentAndExtendSnapshots` prepends the synthesized rows regardless of the `days` filter (see Phase 1, Task 8, Step 1 note). Only the S&P fetch needs the widened range.

- [ ] **Step 2: Merge synthetic cash flows**

Replace the `cashFlows` destructure (line 66) so synthetic flows are appended (sorted ascending — `enrichChartData` and the period cards expect chronological order):
```typescript
  const { events: realCashFlows, pendingCount: cfPendingCount, failedCount: cfFailedCount } = cashFlowResult;
  const cashFlows = [...realCashFlows, ...benchmarkExtension.syntheticCashFlows].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
```

(Both `DashboardGrid` and `PortfolioChart` already receive `cashFlows` — lines 143 & 154 — so this single merge covers both.)

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/page.tsx
git commit -m "feat: extend dashboard S&P benchmark back over synthesized range"
```

---

## Task 5: Wire into the share page

**Files:**
- Modify: `src/app/share/[token]/page.tsx` (its `fetchIndexHistory` + `deriveCashFlows` assembly — found via grep in planning)

Same two changes, but cross-user: pass the owner's `userId` to `getHistoricalBenchmarkExtension` (admin client), matching how the share page already passes the owner id to `deriveCashFlows`.

- [ ] **Step 1: Inspect the share page's existing assembly**

Run: `grep -n "fetchIndexHistory\|deriveCashFlows\|ALL_SNAPSHOTS_DAYS\|cashFlows\|ownerUserId\|userId\|getSharedPortfolio" src/app/share/[token]/page.tsx`
Identify: the owner user-id variable in scope, the `deriveCashFlows(<ownerId>)` call, and the `fetchIndexHistory("^SP500TR", ...)` call.

- [ ] **Step 2: Apply the same extension (owner-scoped)**

Mirror Task 4 using the owner id. Add the import, then before the S&P fetch:
```typescript
import { deriveCashFlows, getHistoricalBenchmarkExtension } from "@/lib/actions/benchmark";

// <ownerId> is the share owner's user_id already resolved on this page.
const benchmarkExtension = await getHistoricalBenchmarkExtension(ownerId);
const sp500Days = benchmarkExtension.earliestDate
  ? Math.max(
      ALL_SNAPSHOTS_DAYS,
      Math.ceil(
        (Date.now() - new Date(`${benchmarkExtension.earliestDate}T00:00:00Z`).getTime()) /
          86_400_000,
      ),
    )
  : ALL_SNAPSHOTS_DAYS;
```
Pass `sp500Days` into the page's `fetchIndexHistory("^SP500TR", sp500Days)` call, and merge synthetic flows into the page's `cashFlows`:
```typescript
const cashFlows = [...realCashFlows, ...benchmarkExtension.syntheticCashFlows].sort((a, b) =>
  a.date.localeCompare(b.date),
);
```

> **Engineer note:** match `ownerId` / `realCashFlows` to the page's actual variable names from Step 1. The share page resolves the owner via the share token; reuse that id (do not call `auth.getUser()` — the viewer is not the owner).

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add "src/app/share/[token]/page.tsx"
git commit -m "feat: extend share-page S&P benchmark back over synthesized range"
```

---

## Task 6: Benchmark correctness tests (extended range)

**Files:**
- Test: `__tests__/unit/chart-enrichment.test.ts` (extend; or create if absent — check `grep -rln "enrichChartData" __tests__/`)

Prove the *combined* behavior: with synthesized portfolio points + a synthetic cash flow at `chartStart` valued at the same historical price, the S&P benchmark starts at the portfolio value (seed reconciles) and a second backdated lot adds units at its date.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { enrichChartData, type ChartPoint } from "@/lib/portfolio/chart-enrichment";
import type { CashFlowEvent, AdjustmentDelta } from "@/lib/types";

// Minimal ChartPoint factory (match the real ChartPoint shape).
function point(date: string, valueUsd: number): ChartPoint {
  return {
    date,
    value: valueUsd,
    valueUsd,
    cryptoUsd: valueUsd,
    stocksUsd: 0,
    cashUsd: 0,
    // ...fill any other required ChartPoint fields with 0/defaults...
  } as ChartPoint;
}

describe("enrichChartData — extended range with synthetic benchmark cash flow", () => {
  it("seeds the S&P to the portfolio value at chartStart (seedDelta ≈ 0)", () => {
    // Portfolio: 2 BTC synthesized. 2021-01-01 value 60k (30k/BTC), 2026 value 120k.
    const points = [point("2021-01-01", 60000), point("2026-01-01", 120000)];
    // Synthetic benchmark cash flow at chartStart, valued identically (60k).
    const cashFlows: CashFlowEvent[] = [
      { date: "2021-01-01", amount_usd: 60000, asset_class: "crypto" },
    ];
    // S&P doubled 2021→2026 (3000 → 6000).
    const sp500History = [
      { date: "2021-01-01", close: 3000 },
      { date: "2026-01-01", close: 6000 },
    ];
    const out = enrichChartData({
      points,
      viewMode: "total",
      primaryCurrency: "USD",
      sp500History,
      cashFlows,
      adjustmentDeltas: [] as AdjustmentDelta[],
      snapshotRatios: null,
    });
    // At chartStart the benchmark equals the portfolio value (seed reconciles).
    expect(out[0].sp500Value).toBeCloseTo(60000, 0);
    // 2021→2026 the S&P doubled → benchmark ≈ 120k (60k × 6000/3000).
    expect(out[1].sp500Value).toBeCloseTo(120000, 0);
  });

  it("adds S&P units for a second backdated lot at its later date", () => {
    const points = [
      point("2021-01-01", 60000),  // BTC only
      point("2022-01-01", 90000),  // BTC + new AAPL lot
      point("2026-01-01", 200000),
    ];
    const cashFlows: CashFlowEvent[] = [
      { date: "2021-01-01", amount_usd: 60000, asset_class: "crypto" },
      { date: "2022-01-01", amount_usd: 20000, asset_class: "stocks" }, // AAPL deployed
    ];
    const sp500History = [
      { date: "2021-01-01", close: 3000 },
      { date: "2022-01-01", close: 4000 },
      { date: "2026-01-01", close: 6000 },
    ];
    const out = enrichChartData({
      points,
      viewMode: "total",
      primaryCurrency: "USD",
      sp500History,
      cashFlows,
      adjustmentDeltas: [] as AdjustmentDelta[],
      snapshotRatios: null,
    });
    // 2021 seed: 60000/3000 = 20 units. 2022 adds 20000/4000 = 5 units → 25.
    // 2026: 25 × 6000 = 150000.
    expect(out[2].sp500Value).toBeCloseTo(150000, 0);
  });
});
```

- [ ] **Step 2: Run to verify (these may PASS immediately — the seed logic is unchanged)**

Run: `npx vitest run __tests__/unit/chart-enrichment.test.ts -t "extended range"`
Expected: PASS. These tests are **characterization tests** — they lock in that the *existing* seed + units replay produce a coherent extended benchmark once Phase 1/2 feed it synthesized points + synthetic flows. If they fail, the cause is a `ChartPoint` shape mismatch in the factory (fix the factory to match the real type) — not a benchmark-logic bug.

> **Engineer note:** read the real `ChartPoint` interface (`chart-enrichment.ts:15`) and fill every required field in `point()`. The values that matter are `date`, `value`, `valueUsd`, and the per-slice `*Usd` fields for `viewMode: "total"`.

- [ ] **Step 3: Commit**

```bash
git add __tests__/unit/chart-enrichment.test.ts
git commit -m "test: S&P benchmark coherence over extended (synthesized) range"
```

---

## Task 7: End-to-end verification + merge readiness

**Files:** none (verification + docs)

- [ ] **Step 1: Full automated gate**

Run:
```bash
npm run lint && npm run typecheck && npm run build && npm test && npm run test:component
```
With local Supabase: `npm run test:integration`.
Expected: all green.

- [ ] **Step 2: Manual smoke — coherent two-line chart**

`npm run dev`, sign in, ensure a backdated crypto lot exists (from Phase 1 smoke). On the dashboard "All" chart:
- The **portfolio line** extends back to the purchase date (Phase 1). ✓
- The **S&P benchmark line** now *also* starts at the purchase date, seeded to the portfolio value there, and diverges by S&P returns over the same span. ✓
- Both lines start together at `chartStart` (the seed reconciliation) — no S&P line "stub" beginning only at the first cron snapshot.
- Toggle a second backdated lot at a different date → the S&P line steps up at that date (units added). 
- Switch to "% Return" mode → both lines start at 0% and diverge. No console errors.

- [ ] **Step 3: Verify the share page matches**

Open a share link for the same portfolio → the share chart's S&P line extends back identically (owner-scoped path). 

- [ ] **Step 4: Update memory, spec, CLAUDE.md**

- `~/.claude/projects/-Users-lxp-simple-portfolio-tracker/memory/chart-correctness-architecture.md`: mark Phase 2 complete; record the resolution of Open Question 2 (synthetic is_adjustment cash flows + extended `^SP500TR` range + seed self-reconciliation).
- Update `~/.claude/projects/-Users-lxp-simple-portfolio-tracker/memory/benchmark.md` with the synthetic-cash-flow mechanism.
- Spec status → "implemented". CLAUDE.md roadmap → note historical-prices chart extension shipped.

- [ ] **Step 5: Commit docs**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-05-27-historical-prices-augmentation-design.md
git commit -m "docs: mark historical-prices Phase 2 (S&P benchmark) complete"
```

- [ ] **Step 6: Merge readiness (do NOT merge without the user)**

Both phases are now on `feat/historical-prices-chart`. Per the spec's deploy-together rule, the branch is ready to merge to `main` (which auto-deploys). **Surface this to the user for explicit approval — do not merge or push to main autonomously.** Recommended: open a PR summarizing both phases for review.

---

## Self-Review (completed during planning)

- **Spec coverage (Phase 2):** S&P benchmark extends back over the synthesized range ✓ (Tasks 4-5); backdated acquisitions counted as cash flows at `effective_date` ✓ (Task 2, for `is_adjustment` lots; non-adjustment already in `deriveCashFlows`); seed correctness across the seam ✓ (Task 6 — reconciles to ~0 by valuing at the same historical price); dedicated Phase 2 tests ✓ (Tasks 2, 3, 6). **Open Question 2 resolved** in "Why this is correct".
- **Double-count guard:** synthetic flows emitted only for `is_adjustment` deltas (disjoint from `deriveCashFlows`'s non-adjustment set) — Task 2 test "ignores non-adjustment deltas".
- **Type consistency:** `buildBenchmarkCashFlows(lots, prices): CashFlowEvent[]` and `getHistoricalBenchmarkExtension(userId?) → { earliestDate, syntheticCashFlows }` are stable across Tasks 2-5; `QtyDelta.is_adjustment` (optional) is added once (Task 1) and consumed in Task 2; reuses Phase 1's `HistoricalLot`/`HistoricalPriceRow`/`findPriceAtOrBefore`/`usdPerUnit` verbatim.
- **Placeholder scan:** no TBD/"add error handling"/"similar to Task N". Integration + ChartPoint factory details flagged for the engineer to match against real exports/types (named explicitly, not hand-waved).
- **Deferred (YAGNI):** detail pages (`crypto`/`stocks`/`cash`) and their share variants render period-card deposit breakdowns from `cashFlows` but not the S&P line; extending synthetic flows there improves deposit-breakdown completeness but is not required for benchmark coherence. Note as a follow-up; not in Phase 2 scope.
