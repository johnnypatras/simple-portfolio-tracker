# Chart View Mode Cycling — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a cycle button to the portfolio chart for viewing asset-class slices (Total/Investments/Crypto/Stocks/Cash) with per-mode adjustment deltas and S&P benchmark recomputation.

**Architecture:** Client-side view modes using existing snapshot breakdown columns (`crypto_value_usd`, `stocks_value_usd`, `cash_value_usd`). `getAdjustmentDeltas()` extended to return per-asset-class cumulative sums by including `entity_type` in the query. S&P benchmark scaled per mode using snapshot allocation ratios.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Recharts, Supabase, lucide-react

**Design doc:** `docs/plans/2026-03-02-chart-view-modes-design.md`

---

### Task 1: Extend `AdjustmentDelta` with per-asset-class fields

**Files:**
- Modify: `src/lib/actions/activity-log.ts:289-337`

**Context:** The `AdjustmentDelta` interface and `getAdjustmentDeltas()` function currently return a single cumulative stream (`cumulative_usd`, `cumulative_eur`). Every `activity_log` row already has an `entity_type` column — we just need to include it in the SELECT and group the cumulative sums by asset class.

**Step 1: Extend the `AdjustmentDelta` interface**

In `src/lib/actions/activity-log.ts`, find the interface at line 289:

```ts
export interface AdjustmentDelta {
  date: string;
  cumulative_usd: number;
  cumulative_eur: number;
}
```

Replace with:

```ts
export interface AdjustmentDelta {
  date: string;
  cumulative_usd: number;
  cumulative_eur: number;
  crypto_cumulative_usd: number;
  crypto_cumulative_eur: number;
  stocks_cumulative_usd: number;
  stocks_cumulative_eur: number;
  cash_cumulative_usd: number;
  cash_cumulative_eur: number;
}
```

**Step 2: Update `getAdjustmentDeltas()` to include `entity_type` and build per-class sums**

Find the function body starting at line 295. Replace the entire function with:

```ts
export async function getAdjustmentDeltas(
  userId?: string
): Promise<AdjustmentDelta[]> {
  const supabase = userId
    ? createAdminClient()
    : await createServerSupabaseClient();

  let query = supabase
    .from("activity_log")
    .select("created_at, delta_usd, delta_eur, entity_type")
    .eq("is_adjustment", true)
    .is("undone_at", null)
    .not("delta_usd", "is", null)
    .order("created_at", { ascending: true });

  if (userId) {
    query = query.eq("user_id", userId);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  if (!data?.length) return [];

  // Entity-type to asset-class mapping
  const getAssetClass = (entityType: string): "crypto" | "stocks" | "cash" | null => {
    if (entityType === "crypto_position") return "crypto";
    if (entityType === "stock_position") return "stocks";
    if (entityType === "bank_account" || entityType === "exchange_deposit" || entityType === "broker_deposit") return "cash";
    return null;
  };

  // Build cumulative sums by date — total + per asset class
  const byDate = new Map<string, {
    usd: number; eur: number;
    cryptoUsd: number; cryptoEur: number;
    stocksUsd: number; stocksEur: number;
    cashUsd: number; cashEur: number;
  }>();

  let cumUsd = 0, cumEur = 0;
  let cryptoUsd = 0, cryptoEur = 0;
  let stocksUsd = 0, stocksEur = 0;
  let cashUsd = 0, cashEur = 0;

  for (const row of data) {
    const dUsd = (row.delta_usd as number) ?? 0;
    const dEur = (row.delta_eur as number) ?? 0;
    cumUsd += dUsd;
    cumEur += dEur;

    const assetClass = getAssetClass(row.entity_type as string);
    if (assetClass === "crypto") { cryptoUsd += dUsd; cryptoEur += dEur; }
    else if (assetClass === "stocks") { stocksUsd += dUsd; stocksEur += dEur; }
    else if (assetClass === "cash") { cashUsd += dUsd; cashEur += dEur; }

    const date = (row.created_at as string).split("T")[0];
    byDate.set(date, {
      usd: cumUsd, eur: cumEur,
      cryptoUsd, cryptoEur,
      stocksUsd, stocksEur,
      cashUsd, cashEur,
    });
  }

  return Array.from(byDate.entries()).map(([date, v]) => ({
    date,
    cumulative_usd: v.usd,
    cumulative_eur: v.eur,
    crypto_cumulative_usd: v.cryptoUsd,
    crypto_cumulative_eur: v.cryptoEur,
    stocks_cumulative_usd: v.stocksUsd,
    stocks_cumulative_eur: v.stocksEur,
    cash_cumulative_usd: v.cashUsd,
    cash_cumulative_eur: v.cashEur,
  }));
}
```

**Step 3: Verify build**

Run: `npm run build`
Expected: Clean build. The chart component imports `AdjustmentDelta` but only reads `cumulative_usd` and `cumulative_eur` — additional fields are ignored until Task 2.

**Step 4: Commit**

```bash
git add src/lib/actions/activity-log.ts
git commit -m "feat: per-asset-class adjustment deltas in getAdjustmentDeltas"
```

---

### Task 2: Add view mode state and cycle button to chart

**Files:**
- Modify: `src/components/dashboard/portfolio-chart.tsx`

**Context:** The chart component is a single `PortfolioChart` function (~600 lines) using Recharts. It has toggle buttons for Adj, Allocation, and S&P 500 in a header row. We're adding a new cycle button and `viewMode` state. This task adds only the button and state — data transformation comes in Task 3.

**Step 1: Add imports and constants**

At the top of the file, add `BarChart3` to the lucide-react import:

```ts
import { Layers, TrendingUp, Info, SlidersHorizontal, BarChart3 } from "lucide-react";
```

After the `PERIODS` constant (line 41), add the view mode type and constants:

```ts
const VIEW_MODES = ["total", "investments", "crypto", "stocks", "cash"] as const;
type ChartViewMode = (typeof VIEW_MODES)[number];

const VIEW_MODE_LABELS: Record<ChartViewMode, string> = {
  total: "Total",
  investments: "Investments",
  crypto: "Crypto",
  stocks: "Stocks",
  cash: "Cash",
};

const CHART_TITLES: Record<ChartViewMode, string> = {
  total: "Portfolio Value",
  investments: "Investments Value",
  crypto: "Crypto Value",
  stocks: "Stocks Value",
  cash: "Cash Value",
};
```

**Step 2: Add `viewMode` state**

Inside the `PortfolioChart` component, after the `showAdjusted` state (line 61), add:

```ts
const [viewMode, setViewMode] = useState<ChartViewMode>("total");
```

**Step 3: Add the cycle button to the header**

Find the header `<div className="flex items-center gap-3">` (line 323). The `<h3>` currently shows "Portfolio Value". Change it to use the mode title:

```tsx
<h3 className="text-sm font-medium text-zinc-400">{CHART_TITLES[viewMode]}</h3>
```

Add the cycle button immediately after the `<h3>`, BEFORE the existing Adj toggle button:

```tsx
<button
  onClick={() => {
    const nextIdx = (VIEW_MODES.indexOf(viewMode) + 1) % VIEW_MODES.length;
    setViewMode(VIEW_MODES[nextIdx]);
  }}
  className={`flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md transition-colors ${
    viewMode !== "total"
      ? "bg-blue-500/20 text-blue-400"
      : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800"
  }`}
  title="Cycle view: Total → Investments → Crypto → Stocks → Cash"
>
  <BarChart3 className="w-3 h-3" />
  <span>{viewMode === "total" ? "View" : VIEW_MODE_LABELS[viewMode]}</span>
</button>
```

**Step 4: Verify build**

Run: `npm run build`
Expected: Clean build. Button renders but doesn't affect chart data yet (the `useMemo` doesn't use `viewMode` — that's Task 3).

**Step 5: Commit**

```bash
git add src/components/dashboard/portfolio-chart.tsx
git commit -m "feat: add view mode cycle button to portfolio chart"
```

---

### Task 3: Wire view mode into chart data transformation

**Files:**
- Modify: `src/components/dashboard/portfolio-chart.tsx` (the `useMemo` block, lines 70–285)
- Modify: `src/app/dashboard/page.tsx` (pass new props)
- Modify: `src/app/share/[token]/page.tsx` (pass new props)

**Context:** The main `useMemo` computes chart points from snapshots, applies adjustment deltas, and builds S&P benchmark. We need to: (a) add new props for live slice values, (b) extract slice values per mode, (c) use per-asset-class deltas, (d) scale S&P cash flows by allocation ratio.

**Step 1: Add new props to `PortfolioChartProps`**

Find the interface at line 19. Add these optional props:

```ts
liveSlices?: { crypto: number; stocks: number; cash: number };
liveSlicesUsd?: { crypto: number; stocks: number; cash: number };
```

Destructure them in the function signature (after `adjustmentDeltas`):

```ts
liveSlices,
liveSlicesUsd,
```

**Step 2: Add slice value helper inside `useMemo`**

Inside the `useMemo` callback, right after the `const points = filtered.map(...)` block (around line 93), add a helper that also stores per-snapshot breakdown for S&P ratio scaling later:

First, modify the `points` mapping to include the raw USD breakdowns on each point. Change the `points` map to:

```ts
const points = filtered.map((s) => {
  const totalUsd = s.total_value_usd || 1;
  return {
    date: s.snapshot_date,
    value: s[valueKey] ?? 0,
    valueUsd: s.total_value_usd ?? 0,
    cryptoPct: (s.crypto_value_usd / totalUsd) * 100,
    stocksPct: (s.stocks_value_usd / totalUsd) * 100,
    cashPct: (s.cash_value_usd / totalUsd) * 100,
    // Per-asset-class USD values for view modes + S&P ratio scaling
    cryptoUsd: s.crypto_value_usd ?? 0,
    stocksUsd: s.stocks_value_usd ?? 0,
    cashUsd: s.cash_value_usd ?? 0,
  };
});
```

Then add the slice value helper right after the points array is built (after the live-value append/update block ending around line 111):

```ts
// ── Slice value extraction per view mode ──
const getSliceValueUsd = (p: typeof points[number]): number => {
  if (viewMode === "total") return p.valueUsd;
  if (viewMode === "investments") return p.cryptoUsd + p.stocksUsd;
  if (viewMode === "crypto") return p.cryptoUsd;
  if (viewMode === "stocks") return p.stocksUsd;
  return p.cashUsd; // cash
};

const toDisplayFromUsd = (usd: number, p: { value: number; valueUsd: number }): number => {
  if (primaryCurrency === "USD") return usd;
  if (p.valueUsd === 0) return usd;
  return usd * (p.value / p.valueUsd);
};

const getSliceValue = (p: typeof points[number]): number => {
  if (viewMode === "total") return p.value;
  return toDisplayFromUsd(getSliceValueUsd(p), p);
};
```

When appending today's live value, also set the USD breakdowns. Find the block that appends/updates today's point (lines 96-111). Update the append case:

```ts
if (lastDate !== TODAY) {
  const lastPoint = points[points.length - 1];
  points.push({
    date: TODAY,
    value: liveValue,
    valueUsd: liveValueUsd,
    cryptoPct: lastPoint?.cryptoPct ?? 0,
    stocksPct: lastPoint?.stocksPct ?? 0,
    cashPct: lastPoint?.cashPct ?? 0,
    cryptoUsd: liveSlicesUsd?.crypto ?? lastPoint?.cryptoUsd ?? 0,
    stocksUsd: liveSlicesUsd?.stocks ?? lastPoint?.stocksUsd ?? 0,
    cashUsd: liveSlicesUsd?.cash ?? lastPoint?.cashUsd ?? 0,
  });
} else {
  const tp = points[points.length - 1];
  tp.value = liveValue;
  tp.valueUsd = liveValueUsd;
  if (liveSlicesUsd) {
    tp.cryptoUsd = liveSlicesUsd.crypto;
    tp.stocksUsd = liveSlicesUsd.stocks;
    tp.cashUsd = liveSlicesUsd.cash;
  }
}
```

**Step 3: Update the delta lookup to use per-asset-class deltas**

Find the `deltaLookup` block (lines 118-143). Replace it with a version that reads the correct slice delta based on `viewMode`:

```ts
// ── Adjustment delta lookup (per view mode) ──
const getDeltaPair = (d: AdjustmentDelta): { cumUsd: number; cumEur: number } => {
  if (viewMode === "total") return { cumUsd: d.cumulative_usd, cumEur: d.cumulative_eur };
  if (viewMode === "investments") return {
    cumUsd: d.crypto_cumulative_usd + d.stocks_cumulative_usd,
    cumEur: d.crypto_cumulative_eur + d.stocks_cumulative_eur,
  };
  if (viewMode === "crypto") return { cumUsd: d.crypto_cumulative_usd, cumEur: d.crypto_cumulative_eur };
  if (viewMode === "stocks") return { cumUsd: d.stocks_cumulative_usd, cumEur: d.stocks_cumulative_eur };
  return { cumUsd: d.cash_cumulative_usd, cumEur: d.cash_cumulative_eur };
};

const deltaLookup = adjustmentDeltas.map((d) => ({
  date: d.date,
  ...getDeltaPair(d),
}));

const finalCumDelta =
  deltaLookup.length > 0
    ? deltaLookup[deltaLookup.length - 1]
    : { cumUsd: 0, cumEur: 0 };

const getCumulativeDelta = (
  date: string
): { usd: number; eur: number } => {
  if (deltaLookup.length === 0) return { usd: 0, eur: 0 };
  let result = { usd: 0, eur: 0 };
  for (const d of deltaLookup) {
    if (d.date <= date) {
      result = { usd: d.cumUsd, eur: d.cumEur };
    } else {
      break;
    }
  }
  return result;
};
```

**Step 4: Scale S&P cash flows by allocation ratio**

In the cash-flow-adjusted S&P block (starting around line 178), the `sp500Units` accumulation currently uses raw `cf.amount_usd`. When `viewMode !== "total"`, scale each cash flow by the snapshot allocation ratio at the cash flow date.

Add a snapshot lookup helper right after the `getCumulativeDelta` function:

```ts
// ── Snapshot ratio lookup for S&P scaling ──
// Build a sorted array of { date, ratio } for the current view mode
const snapshotRatios = viewMode === "total"
  ? null // no scaling needed
  : filtered.map((s) => {
      const totalUsd = s.total_value_usd || 1;
      let sliceUsd: number;
      if (viewMode === "investments") sliceUsd = (s.crypto_value_usd ?? 0) + (s.stocks_value_usd ?? 0);
      else if (viewMode === "crypto") sliceUsd = s.crypto_value_usd ?? 0;
      else if (viewMode === "stocks") sliceUsd = s.stocks_value_usd ?? 0;
      else sliceUsd = s.cash_value_usd ?? 0;
      return { date: s.snapshot_date, ratio: sliceUsd / totalUsd };
    });

const getSliceRatio = (date: string): number => {
  if (!snapshotRatios || snapshotRatios.length === 0) return 1;
  let ratio = snapshotRatios[0].ratio; // fallback to first
  for (const sr of snapshotRatios) {
    if (sr.date <= date) ratio = sr.ratio;
    else break;
  }
  return ratio;
};
```

Then in the cash flow loop (around line 184), scale the amount:

```ts
for (const cf of cashFlows) {
  const price = getSp500Price(cf.date);
  if (price && price > 0) {
    const scaledAmount = cf.amount_usd * getSliceRatio(cf.date);
    sp500Units += scaledAmount / price;
  }
  // ...rest unchanged
}
```

**Step 5: Update the enriched point value to use slice value**

In the `enriched = points.map(...)` block (around line 232), change the `adjustedValue` computation to work on the slice value instead of the total:

```ts
enriched = points.map((p) => {
  // ... existing sp500 logic unchanged ...

  // Compute adjusted value for the CURRENT VIEW MODE's slice
  const sliceVal = getSliceValue(p);
  const delta = getCumulativeDelta(p.date);
  const deltaDisplay = primaryCurrency === "EUR" ? delta.eur : delta.usd;
  const finalDeltaDisplay = primaryCurrency === "EUR" ? finalCumDelta.cumEur : finalCumDelta.cumUsd;
  const adjustedValue = sliceVal + (finalDeltaDisplay - deltaDisplay);

  return { ...p, value: sliceVal, sp500Value, adjustedValue, rawValue: sliceVal };
});
```

Do the same for the fallback block (around line 252). The `portfolioStart` calculation and the point mapping both need to use `getSliceValue(p)` instead of `p.value`.

**Step 6: Update the `useMemo` dependency array**

Add `viewMode`, `liveSlices`, `liveSlicesUsd` to the dependency array at line 285:

```ts
}, [snapshots, liveValue, liveValueUsd, liveSlices, liveSlicesUsd, valueKey, primaryCurrency, period.days, sp500History, cashFlows, adjustmentDeltas, viewMode]);
```

**Step 7: Wire live slice props from dashboard page**

In `src/app/dashboard/page.tsx`, find the `<PortfolioChart>` usage (line 167). Add:

```tsx
<PortfolioChart
  snapshots={chartSnapshots}
  liveValue={summary.totalValue}
  liveValueUsd={summary.totalValueUsd}
  primaryCurrency={primaryCurrency}
  sp500History={sp500TRHistory}
  cashFlows={cashFlows}
  adjustmentDeltas={adjustmentDeltas}
  liveSlices={{
    crypto: summary.cryptoValue,
    stocks: summary.stocksValue,
    cash: summary.cashValue,
  }}
  liveSlicesUsd={{
    crypto: summary.cryptoValueUsd,
    stocks: summary.stocksValueUsd,
    cash: summary.cashValueUsd,
  }}
/>
```

**Step 8: Wire live slice props from share page**

In `src/app/share/[token]/page.tsx`, make the same change to the `<PortfolioChart>` usage (line 121):

```tsx
<PortfolioChart
  snapshots={snapshots}
  liveValue={summary.totalValue}
  liveValueUsd={summary.totalValueUsd}
  primaryCurrency={primaryCurrency}
  sp500History={sp500TRHistory}
  cashFlows={cashFlows}
  adjustmentDeltas={adjustmentDeltas}
  liveSlices={{
    crypto: summary.cryptoValue,
    stocks: summary.stocksValue,
    cash: summary.cashValue,
  }}
  liveSlicesUsd={{
    crypto: summary.cryptoValueUsd,
    stocks: summary.stocksValueUsd,
    cash: summary.cashValueUsd,
  }}
/>
```

**Step 9: Verify build**

Run: `npm run build`
Expected: Clean build. Chart now responds to view mode cycling with correct slice values, per-mode deltas, and scaled S&P.

**Step 10: Commit**

```bash
git add src/components/dashboard/portfolio-chart.tsx src/app/dashboard/page.tsx src/app/share/[token]/page.tsx
git commit -m "feat: wire view mode into chart data transformation with per-mode S&P"
```

---

### Task 4: Update tooltip for view modes

**Files:**
- Modify: `src/components/dashboard/portfolio-chart.tsx` (tooltip section, around line 414)

**Context:** The chart tooltip currently always shows "Portfolio" as the label. It needs to reflect the current view mode and show mode-appropriate values.

**Step 1: Update the tooltip content**

Find the tooltip `content` callback (line 415). The display value logic is already correct (it reads from `adjustedValue` vs `value` based on `showAdjusted`). Just update the label.

Change the value display `<p>` tag to include a label:

```tsx
<Tooltip
  content={({ active, payload }) => {
    if (!active || !payload?.[0]) return null;
    const point = payload[0].payload as {
      date: string;
      value: number;
      adjustedValue?: number;
      rawValue?: number;
      sp500Value?: number;
      cryptoPct: number;
      stocksPct: number;
      cashPct: number;
    };
    const displayValue =
      hasDeltas && showAdjusted
        ? (point.adjustedValue ?? point.value)
        : point.value;
    return (
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 shadow-lg">
        <p className="text-xs text-zinc-400">
          {formatDate(point.date)}
        </p>
        <p className="text-sm font-medium text-zinc-100">
          {viewMode !== "total" && (
            <span className="text-zinc-500 mr-1">{VIEW_MODE_LABELS[viewMode]}</span>
          )}
          {fmtCurrencyCompact(displayValue, primaryCurrency)}
        </p>
        {hasDeltas && showAdjusted && point.rawValue != null && Math.abs(point.rawValue - displayValue) > 0.5 && (
          <p className="text-[10px] text-zinc-600 mt-0.5">
            Raw: {fmtCurrencyCompact(point.rawValue, primaryCurrency)}
          </p>
        )}
        {showBenchmark && point.sp500Value != null && (
          <p className="text-xs text-zinc-500 mt-0.5">
            S&P 500 TR {fmtCurrencyCompact(point.sp500Value, primaryCurrency)}
          </p>
        )}
        {showAllocation && (
          <div className="flex gap-3 mt-1 text-[10px]">
            <span className="text-orange-400">
              Crypto {point.cryptoPct.toFixed(0)}%
            </span>
            <span className="text-blue-400">
              Stocks {point.stocksPct.toFixed(0)}%
            </span>
            <span className="text-emerald-400">
              Cash {point.cashPct.toFixed(0)}%
            </span>
          </div>
        )}
      </div>
    );
  }}
/>
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean build.

**Step 3: Commit**

```bash
git add src/components/dashboard/portfolio-chart.tsx
git commit -m "feat: update chart tooltip labels for view modes"
```

---

### Task 5: Visual verification and edge case testing

**Files:** No file changes — verification only.

**Step 1: Start dev server**

Run: `npm run dev`

**Step 2: Visual verification checklist**

Open the dashboard in the browser and verify:

1. **Cycle button visible**: next to chart title, shows "View" when in total mode
2. **Click cycles through modes**: Total → Investments → Crypto → Stocks → Cash → Total
3. **Chart title updates**: "Portfolio Value" → "Investments Value" → etc.
4. **Button styling**: zinc when total (inactive), blue when any other mode (active)
5. **Chart line changes**: line values change per mode (investments < total, crypto < investments, etc.)
6. **Adj toggle works in all modes**: toggle on/off, chart adjusts per mode
7. **S&P benchmark visible in all modes**: dashed line adjusts per mode
8. **Tooltip shows mode label**: "Investments €X" in investments mode, etc.
9. **Allocation overlay still works**: % lines visible alongside slice view
10. **Period selector still works**: 24H/3D/7D/30D/90D/1Y/All all function
11. **Live value (today's point)**: last point uses live slice value, not stale snapshot

**Step 3: Edge cases**

1. **Cash-only mode with no cash**: shows flat line at 0 — acceptable
2. **Adj toggle in crypto mode**: only crypto adjustment deltas apply
3. **S&P in cash mode**: S&P scaled by cash ratio (small line)

**Step 4: Final build check**

Run: `npm run build`
Expected: Clean production build.

**Step 5: Commit any fixes found during verification**

```bash
git add -A
git commit -m "fix: chart view mode edge cases"
```

(Only if fixes were needed — skip if verification passed cleanly.)
