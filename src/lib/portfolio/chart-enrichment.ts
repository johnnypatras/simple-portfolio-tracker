/**
 * Chart enrichment — pure computation, no React.
 *
 * Adds the S&P 500 benchmark line to a sequence of chart points by replaying
 * cash flows into hypothetical S&P units. The portfolio line is the literal
 * historical truth from snapshots (after augmentation); the benchmark line
 * answers "what if every dollar had been put into the S&P 500 instead?".
 */

import type { CashFlowEvent, BaseCurrency } from "@/lib/types";

// ── Types ──────────────────────────────────────────────────

export type ChartViewMode = "total" | "investments" | "crypto" | "stocks" | "cash";

/** A single chart data point before enrichment. */
export interface ChartPoint {
  date: string;
  value: number;       // display currency (EUR or USD)
  valueUsd: number;    // always USD
  cryptoUsd: number;
  stocksUsd: number;
  cashUsd: number;
  cryptoPct: number;
  stocksPct: number;
  cashPct: number;
}

/** Chart data point after enrichment with S&P benchmark value. */
export interface EnrichedChartPoint extends ChartPoint {
  sp500Value?: number;
}

/**
 * One point on the portfolio-wide cost-basis series, narrowed to the columns
 * the seed re-anchor reads. This is a CLIENT-SAFE structural subset of the
 * server-side `CostBasisSeriesPoint` (in `historical-prices-augmentation.ts`,
 * which carries the full cost + EUR-gap columns and pulls in server-only
 * imports). The wider server type is structurally assignable to this one, so
 * the pages thread their `costBasisSeries` through with no cast.
 *
 * Only the USD per-class GAP columns are consumed here (GAP = Σ market−userCost
 * over user-costed, non-yield lots at `date`). The EUR gaps are reserved for the
 * Phase-5 overlay and intentionally absent from this view.
 */
export interface CostBasisSeriesPoint {
  date: string; // YYYY-MM-DD
  cryptoGapUsd: number;
  stocksGapUsd: number;
  cashGapUsd: number;
}

export interface EnrichChartDataInput {
  points: ChartPoint[];
  viewMode: ChartViewMode;
  primaryCurrency: BaseCurrency;
  sp500History: { date: string; close: number }[];
  cashFlows: CashFlowEvent[];
  /** Snapshot ratios for per-class S&P scaling (null = total mode, no scaling). */
  snapshotRatios: { date: string; ratio: number }[] | null;
  /**
   * Portfolio-wide running cost-basis series (Task 3.4c). When present, the S&P
   * benchmark seed is re-anchored to the user's COST (not market) at chartStart
   * by subtracting the view-mode's pre-computed GAP. Absent/empty → behavior is
   * byte-identical to before (the seed is a pure delta from `firstSliceUsd`).
   */
  costBasisSeries?: CostBasisSeriesPoint[];
}

// ── Helpers ────────────────────────────────────────────────

function getSliceValueUsd(p: ChartPoint, viewMode: ChartViewMode): number {
  if (viewMode === "total") return p.valueUsd;
  if (viewMode === "investments") return p.cryptoUsd + p.stocksUsd;
  if (viewMode === "crypto") return p.cryptoUsd;
  if (viewMode === "stocks") return p.stocksUsd;
  return p.cashUsd;
}

function toDisplayFromUsd(
  usd: number,
  p: { value: number; valueUsd: number },
  primaryCurrency: BaseCurrency,
): number {
  if (primaryCurrency === "USD") return usd;
  if (p.valueUsd === 0) return 0;
  return usd * (p.value / p.valueUsd);
}

function getSliceValue(p: ChartPoint, viewMode: ChartViewMode, primaryCurrency: BaseCurrency): number {
  if (viewMode === "total") return p.value;
  return toDisplayFromUsd(getSliceValueUsd(p, viewMode), p, primaryCurrency);
}

/**
 * Sum the view-mode's pre-computed USD GAP columns from the LATEST cost-basis
 * series point with `date <= chartStartDate`. The gap (Σ market−userCost over
 * user-costed, non-yield lots) is READ verbatim from the series — NEVER
 * recomputed from cost totals here (audit-r5 F1: the series is the single source
 * of truth for the gap; reconstructing it would risk drift).
 *
 * View-mode mapping mirrors `getSliceValueUsd`:
 *   crypto → cryptoGapUsd · stocks → stocksGapUsd · cash → cashGapUsd
 *   investments → crypto + stocks · total → crypto + stocks + cash
 *
 * Returns 0 when the series is empty, has no point at-or-before chartStartDate,
 * or no lot is user-costed (all gaps 0) — the seed then stays at market truth.
 */
export function lookupCostAtOrBefore(
  series: CostBasisSeriesPoint[],
  chartStartDate: string,
  viewMode: ChartViewMode,
): number {
  let chosen: CostBasisSeriesPoint | null = null;
  for (const point of series) {
    if (point.date <= chartStartDate) chosen = point;
    else break;
  }
  if (chosen === null) return 0;

  switch (viewMode) {
    case "crypto":
      return chosen.cryptoGapUsd;
    case "stocks":
      return chosen.stocksGapUsd;
    case "cash":
      return chosen.cashGapUsd;
    case "investments":
      return chosen.cryptoGapUsd + chosen.stocksGapUsd;
    case "total":
      return chosen.cryptoGapUsd + chosen.stocksGapUsd + chosen.cashGapUsd;
  }
}

function getSliceRatio(
  date: string,
  snapshotRatios: { date: string; ratio: number }[] | null,
): number {
  if (!snapshotRatios || snapshotRatios.length === 0) return 1;
  let ratio = snapshotRatios[0].ratio;
  for (const sr of snapshotRatios) {
    if (sr.date <= date) ratio = sr.ratio;
    else break;
  }
  return ratio;
}

function getSp500Price(
  date: string,
  sp500Map: Map<string, number>,
): number | undefined {
  return sp500Map.get(date);
}

function toDisplayCurrency(
  usdAmount: number,
  point: { value: number; valueUsd: number },
  primaryCurrency: BaseCurrency,
): number | undefined {
  if (primaryCurrency === "USD") return usdAmount;
  if (point.valueUsd === 0) return undefined;
  return usdAmount * (point.value / point.valueUsd);
}

// ── Main function ──────────────────────────────────────────

/**
 * Enrich chart data points with S&P 500 benchmark values. Pure function —
 * no React, no I/O.
 *
 * The portfolio `value` is the literal truth (already augmented for backdated
 * lots via historical-price + manual-NAV augmentation upstream). The S&P
 * benchmark is seeded against that same value at chartStart and then evolves
 * by replaying subsequent cash flows.
 */
export function enrichChartData(input: EnrichChartDataInput): EnrichedChartPoint[] {
  const {
    points,
    viewMode,
    primaryCurrency,
    sp500History,
    cashFlows,
    snapshotRatios,
    costBasisSeries,
  } = input;

  if (points.length === 0) return [];

  // Build sp500Map with forward-fill for weekends/holidays so getSp500Price is O(1)
  const sp500Map = new Map(sp500History.map((p) => [p.date, p.close]));
  if (points.length > 0 && sp500History.length > 0) {
    const startDate = points[0].date;
    const endDate = points[points.length - 1].date;

    // Seed lastPrice from the most recent trading day BEFORE chartStart.
    // Without this, a chart starting on a weekend has no S&P price for
    // the first date, which breaks the seeding logic (sp500StartPrice
    // is undefined → S&P benchmark uses only tiny actual cash flows).
    let lastPrice: number | undefined;
    for (const p of sp500History) {
      if (p.date >= startDate) break;
      lastPrice = p.close;
    }

    const cursor = new Date(startDate);
    const end = new Date(endDate);
    while (cursor <= end) {
      const ds = cursor.toISOString().slice(0, 10);
      const known = sp500Map.get(ds);
      if (known != null && known > 0) {
        lastPrice = known;
      } else if (lastPrice != null) {
        sp500Map.set(ds, lastPrice);
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  const hasCashFlows = cashFlows.length > 0;
  const chartStart = points[0].date;

  if (hasCashFlows) {
    return enrichWithSp500Benchmark(
      points, viewMode, primaryCurrency, sp500Map,
      cashFlows, snapshotRatios, chartStart, costBasisSeries,
    );
  }

  // The naive scaling fallback is legitimate for a brand-new user with no
  // recorded activity (empty cashFlows AND empty portfolio). But if the
  // portfolio has real value while cashFlows is empty, that points to a
  // deriveCashFlows regression — the cash-flow-replay benchmark is silently
  // degraded to a naive line. Leave a breadcrumb (not a captureMessage, to
  // avoid alert noise) so any later Sentry event carries the signal. Guarded
  // on a non-zero portfolio so legitimately-empty new accounts stay quiet.
  if (points.some((p) => p.value > 0)) {
    recordNaiveFallbackBreadcrumb(points.length);
  }

  return enrichNaiveFallback(
    points, viewMode, primaryCurrency, sp500Map, chartStart,
  );
}

/**
 * Fire-and-forget Sentry breadcrumb for the suspicious naive-fallback case.
 *
 * This module is pure and bundled into the client portfolio chart, so it
 * avoids a top-level `@sentry/nextjs` import. The dynamic import keeps the
 * enrichment functions synchronous (the `.catch` swallows any failure so a
 * missing/unconfigured Sentry never throws into the render path). `addBreadcrumb`
 * is a no-op when no Sentry client is active, which is the case in unit tests.
 */
function recordNaiveFallbackBreadcrumb(pointCount: number): void {
  void import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.addBreadcrumb({
        category: "chart-enrichment",
        message: "S&P naive fallback: no cashflows despite non-zero portfolio",
        level: "warning",
        data: { pointCount },
      });
    })
    .catch(() => {
      // Sentry unavailable (e.g. test env or import failure) — non-fatal.
    });
}

// ── Cash-flow-driven S&P benchmark path ────────────────────

function enrichWithSp500Benchmark(
  points: ChartPoint[],
  viewMode: ChartViewMode,
  primaryCurrency: BaseCurrency,
  sp500Map: Map<string, number>,
  cashFlows: CashFlowEvent[],
  snapshotRatios: { date: string; ratio: number }[] | null,
  chartStart: string,
  costBasisSeries?: CostBasisSeriesPoint[],
): EnrichedChartPoint[] {
  let sp500Units = 0;
  let preChartUnits = 0;
  const unitsByDate = new Map<string, number>();

  for (const cf of cashFlows) {
    const price = getSp500Price(cf.date, sp500Map);
    if (price && price > 0) {
      const scaledAmount = cf.amount_usd * getSliceRatio(cf.date, snapshotRatios);
      sp500Units += scaledAmount / price;
    }
    if (cf.date < chartStart) {
      preChartUnits = sp500Units;
    } else {
      unitsByDate.set(cf.date, sp500Units);
    }
  }

  // Seed S&P units so the benchmark starts at the same value as the portfolio
  // line at chartStart. The portfolio value is the literal truth (already
  // augmented upstream by historical-price + manual-NAV); the benchmark must
  // match that anchor so both lines diverge from a common starting point.
  const firstPoint = points[0];
  const sp500StartPrice = getSp500Price(firstPoint.date, sp500Map);
  if (sp500StartPrice && sp500StartPrice > 0) {
    const firstSliceVal = getSliceValue(firstPoint, viewMode, primaryCurrency);
    const firstSliceUsd = getSliceValueUsd(firstPoint, viewMode);
    // Seed against the raw portfolio value at chartStart — NOT against a
    // back-filled projection. This is the Phase 4 contract: the chart shows
    // literal historical truth, so the S&P benchmark must seed off that truth.
    const seedDisp = firstSliceVal;

    // Convert seed display value → USD for unit calculation.
    // Four-tier FX ratio (audit R1 Phase 5): per-class → portfolio-wide →
    // forward-scan → skip. Identity-rate fallback corrupted S&P seeding by
    // ~15-18% for EUR-primary users whose first chart point was empty (e.g.
    // all-adjustment imports backdated before any positions existed). Now:
    // tier 3 scans forward for the first non-zero point's portfolio-wide
    // ratio; tier 4 (no non-zero point anywhere) skips seeding entirely.
    let fxRatioUsdPerDisp: number | null = null;
    if (firstSliceUsd > 0 && firstSliceVal > 0) {
      fxRatioUsdPerDisp = firstSliceUsd / firstSliceVal;
    } else if (firstPoint.value > 0) {
      fxRatioUsdPerDisp = firstPoint.valueUsd / firstPoint.value;
    } else {
      for (const p of points) {
        if (p.value > 0 && p.valueUsd > 0) {
          fxRatioUsdPerDisp = p.valueUsd / p.value;
          break;
        }
      }
    }

    if (fxRatioUsdPerDisp !== null && fxRatioUsdPerDisp > 0) {
      // Cost-basis re-anchor (Task 3.4f): subtract the view-mode's pre-computed
      // USD GAP so the S&P seeds off the user's COST, not market. The seed is a
      // pure DELTA from the market-USD seed — gap=0 (or no series) → byte-
      // identical to before via the SAME arithmetic. Gated on firstSliceUsd > 0
      // (tier-1 only, where `seedDisp * fxRatioUsdPerDisp === firstSliceUsd`):
      // the tier-2/3/4 empty-slice fallback MUST keep today's skip-seeding even
      // when a gap exists — never seed off a 0 slice (audit-derived constraint).
      const gapUsd = firstSliceUsd > 0 && costBasisSeries
        ? lookupCostAtOrBefore(costBasisSeries, chartStart, viewMode)
        : 0;
      const seedUsd = seedDisp * fxRatioUsdPerDisp - gapUsd;
      const neededUnits = seedUsd / sp500StartPrice;
      // Baseline against the units actually present at chartStart. A cash flow
      // dated exactly at chartStart lands in unitsByDate (the partition uses
      // cf.date < chartStart for preChartUnits), so the chartStart flow's units
      // are NOT in preChartUnits. Seeding against preChartUnits alone would then
      // ADD a duplicate seedDelta on top of that flow (double-counting the
      // benchmark at chartStart — the Phase 2 back-extension case, where the
      // earliest synthetic flow sits on chartStart). Comparing to the actual
      // chartStart units makes seedDelta 0 when the flow already provides them.
      const unitsAtChartStart = unitsByDate.has(chartStart)
        ? unitsByDate.get(chartStart)!
        : preChartUnits;
      if (neededUnits !== unitsAtChartStart) {
        const seedDelta = neededUnits - unitsAtChartStart;
        sp500Units += seedDelta;
        preChartUnits += seedDelta;
        for (const [date, units] of unitsByDate) {
          unitsByDate.set(date, units + seedDelta);
        }
      }
    }
  }

  let currentUnits = preChartUnits;
  return points.map((p) => {
    if (unitsByDate.has(p.date)) {
      currentUnits = unitsByDate.get(p.date)!;
    }
    const price = getSp500Price(p.date, sp500Map);
    const sp500ValueUsd = price != null ? currentUnits * price : undefined;
    const sp500Value = sp500ValueUsd != null
      ? toDisplayCurrency(sp500ValueUsd, p, primaryCurrency)
      : undefined;

    const sliceVal = getSliceValue(p, viewMode, primaryCurrency);
    return { ...p, value: sliceVal, sp500Value };
  });
}

// ── Naive fallback path ────────────────────────────────────

function enrichNaiveFallback(
  points: ChartPoint[],
  viewMode: ChartViewMode,
  primaryCurrency: BaseCurrency,
  sp500Map: Map<string, number>,
  chartStart: string,
): EnrichedChartPoint[] {
  const portfolioStart = getSliceValue(points[0], viewMode, primaryCurrency);
  const sp500Start = getSp500Price(chartStart, sp500Map);

  return points.map((p) => {
    const sliceVal = getSliceValue(p, viewMode, primaryCurrency);
    let sp500Value: number | undefined;
    if (sp500Start && portfolioStart > 0) {
      const close = getSp500Price(p.date, sp500Map);
      if (close != null) {
        sp500Value = (portfolioStart / sp500Start) * close;
      }
    }

    return { ...p, value: sliceVal, sp500Value };
  });
}
