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

export interface EnrichChartDataInput {
  points: ChartPoint[];
  viewMode: ChartViewMode;
  primaryCurrency: BaseCurrency;
  sp500History: { date: string; close: number }[];
  cashFlows: CashFlowEvent[];
  /** Snapshot ratios for per-class S&P scaling (null = total mode, no scaling). */
  snapshotRatios: { date: string; ratio: number }[] | null;
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
      cashFlows, snapshotRatios, chartStart,
    );
  }

  return enrichNaiveFallback(
    points, viewMode, primaryCurrency, sp500Map, chartStart,
  );
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
      const seedUsd = seedDisp * fxRatioUsdPerDisp;
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
