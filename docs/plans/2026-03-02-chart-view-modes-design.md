# Chart View Mode Cycling — Design

## Goal

Add a cycle button to the portfolio chart that lets users view asset-class slices (Total → Investments → Crypto → Stocks → Cash) with the S&P 500 benchmark recomputed per mode. The adjustment toggle works in all modes using per-asset-class deltas.

## Architecture

Client-side approach. Snapshots already store per-asset-class USD breakdowns (`crypto_value_usd`, `stocks_value_usd`, `cash_value_usd`). View modes derive slice values from these columns and convert to display currency using the snapshot's implicit FX rate. No new DB columns or migrations needed.

## View Modes

| Mode | Value source | Label |
|------|-------------|-------|
| `total` | `total_value_{eur\|usd}` (existing behavior) | Total |
| `investments` | `crypto_value_usd + stocks_value_usd` → converted | Investments |
| `crypto` | `crypto_value_usd` → converted | Crypto |
| `stocks` | `stocks_value_usd` → converted | Stocks |
| `cash` | `cash_value_usd` → converted | Cash |

Type: `type ChartViewMode = "total" | "investments" | "crypto" | "stocks" | "cash"`

Cycle order: Total → Investments → Crypto → Stocks → Cash → Total

---

## 1. Slice Value Extraction

Each snapshot has `crypto_value_usd`, `stocks_value_usd`, `cash_value_usd`. For non-total modes, compute the slice in display currency:

```ts
function getSliceValue(snapshot, mode, primaryCurrency) {
  if (mode === "total") return snapshot[valueKey]; // existing path

  // Get USD slice
  let sliceUsd;
  if (mode === "investments") sliceUsd = snapshot.crypto_value_usd + snapshot.stocks_value_usd;
  else if (mode === "crypto") sliceUsd = snapshot.crypto_value_usd;
  else if (mode === "stocks") sliceUsd = snapshot.stocks_value_usd;
  else sliceUsd = snapshot.cash_value_usd;

  // Convert to display currency using snapshot's implicit FX rate
  if (primaryCurrency === "USD") return sliceUsd;
  const fxRate = snapshot.total_value_eur / snapshot.total_value_usd;
  return sliceUsd * fxRate;
}
```

Edge case: if `total_value_usd === 0`, FX rate can't be derived — fall back to 1.0 (only happens with empty portfolio).

---

## 2. Per-Asset-Class Adjustment Deltas

### Current state

`getAdjustmentDeltas()` returns a single cumulative stream (`cumulative_usd`, `cumulative_eur`). `entity_type` is already stored on every `activity_log` row but not included in the query or output.

### Change

Add `entity_type` to the SELECT, then build 4 parallel cumulative sums: total + crypto + stocks + cash.

Entity-type-to-asset-class mapping:

| `entity_type` | Asset class |
|---|---|
| `crypto_position` | `crypto` |
| `stock_position` | `stocks` |
| `bank_account`, `exchange_deposit`, `broker_deposit` | `cash` |

Updated interface:

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

The chart uses the appropriate slice delta based on view mode:

| View Mode | Delta fields used |
|---|---|
| `total` | `cumulative_usd/eur` (existing) |
| `investments` | `crypto_cumulative + stocks_cumulative` |
| `crypto` | `crypto_cumulative_usd/eur` |
| `stocks` | `stocks_cumulative_usd/eur` |
| `cash` | `cash_cumulative_usd/eur` |

The Adj toggle stays visible and works in all 5 modes.

---

## 3. S&P 500 Benchmark per Mode

### Approach: ratio-based scaling

Cash flows from `deriveCashFlows()` represent total portfolio deposits/withdrawals (already excluding adjustments). They don't carry entity_type — and can't, since purchases are flagged as adjustments and excluded.

To get mode-specific S&P, scale each cash flow by the asset-class ratio at the cash flow date:

```
adjusted_cash_flow = cash_flow × (slice_value_usd / total_value_usd)
```

The ratio comes from the nearest snapshot on or before the cash flow date.

For `investments` mode: ratio = `(crypto_value_usd + stocks_value_usd) / total_value_usd`

The rationale: if 60% of your portfolio is in investments when you deposit $1000, then $600 of that deposit is "attributable" to the investment portion. So the S&P benchmark for investments only buys $600 worth of units on that date.

This is exact (uses actual portfolio composition at each cash flow date) and requires no server-side changes.

---

## 4. Live Value for Today's Point

The chart appends today's live value as the last point. In non-total modes, the live slice values come from the `aggregatePortfolio()` summary which already computes `cryptoValueUsd`, `stocksValueUsd`, `cashValueUsd`.

New props needed on `PortfolioChart`:

```ts
liveSlices?: { crypto: number; stocks: number; cash: number }  // in display currency
liveSlicesUsd?: { crypto: number; stocks: number; cash: number }
```

Wired from dashboard page: `summary.cryptoValue`, `summary.stocksValue`, `summary.cashValue` (display currency) and `summary.cryptoValueUsd`, etc.

---

## 5. UI — Cycle Button

Placement: left of the existing Adj toggle button, same row.

Appearance:
- Inactive (total mode): zinc-600 text, like other toggle buttons
- Active (any non-total mode): `bg-blue-500/20 text-blue-400`
- Shows current mode label (e.g., "Investments", "Crypto")
- Icon: `BarChart3` from lucide-react (stacked bars suggest asset breakdown)

Behavior:
- Click cycles through modes in order
- Returns to "Total" at end of cycle (button returns to inactive state)

```tsx
const VIEW_MODES = ["total", "investments", "crypto", "stocks", "cash"] as const;

// Cycle on click
const nextMode = VIEW_MODES[(VIEW_MODES.indexOf(viewMode) + 1) % VIEW_MODES.length];
```

---

## 6. Tooltip

The tooltip shows the mode-appropriate value:

- Label changes: "Portfolio" / "Investments" / "Crypto" / "Stocks" / "Cash"
- "Raw" line (when Adj active and different): shows unadjusted slice value
- S&P line: shows recomputed S&P value for the current mode

---

## 7. Allocation Overlay Interaction

The allocation % overlay (Crypto/Stocks/Cash lines) remains visible in all modes — it's useful context even when viewing a single slice. No changes needed.

---

## 8. Chart Header Title

Currently "Portfolio Value". Changes based on mode:

| Mode | Title |
|---|---|
| `total` | Portfolio Value |
| `investments` | Investments Value |
| `crypto` | Crypto Value |
| `stocks` | Stocks Value |
| `cash` | Cash Value |

---

## 9. Edge Cases

- **0% allocation at cash flow date**: if `total_value_usd` is 0, skip the cash flow for S&P scaling (can't divide by zero)
- **No snapshots near cash flow date**: use nearest earlier snapshot; if none exists, use 100% ratio (assume all money went to the slice)
- **Single-asset portfolio**: modes with 0 value show a flat line at 0 — acceptable
- **Stablecoins**: already classified as cash in `aggregate.ts` (subcategory check), so they correctly appear in cash mode, not crypto

---

## Files Modified

1. `src/lib/actions/activity-log.ts` — `AdjustmentDelta` interface + `getAdjustmentDeltas()` query and accumulation
2. `src/components/dashboard/portfolio-chart.tsx` — view mode state, cycle button, slice extraction, per-mode deltas, per-mode S&P scaling, tooltip updates, chart title
3. `src/app/dashboard/page.tsx` — pass `liveSlices` / `liveSlicesUsd` props
4. `src/app/share/[token]/page.tsx` — same props for share page

No migrations. No new API calls. No new dependencies.
