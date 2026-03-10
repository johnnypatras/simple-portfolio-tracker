/**
 * Chart enrichment — pure computation, no React.
 *
 * Extracts the benchmark / adjustment enrichment logic from
 * portfolio-chart.tsx so it can be tested without a render context.
 */

import type { AdjustmentDelta } from "@/lib/actions/activity-log";
import type { CashFlowEvent } from "@/lib/actions/benchmark";

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

/** Chart data point after enrichment with S&P benchmark and adjustment values. */
export interface EnrichedChartPoint extends ChartPoint {
  sp500Value?: number;
  adjustedValue?: number;
  rawValue?: number;
}

export interface EnrichChartDataInput {
  points: ChartPoint[];
  viewMode: ChartViewMode;
  primaryCurrency: string;
  sp500History: { date: string; close: number }[];
  cashFlows: CashFlowEvent[];
  adjustmentDeltas: AdjustmentDelta[];
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
  primaryCurrency: string,
): number {
  if (primaryCurrency === "USD") return usd;
  if (p.valueUsd === 0) return usd;
  return usd * (p.value / p.valueUsd);
}

function getSliceValue(p: ChartPoint, viewMode: ChartViewMode, primaryCurrency: string): number {
  if (viewMode === "total") return p.value;
  return toDisplayFromUsd(getSliceValueUsd(p, viewMode), p, primaryCurrency);
}

function getDeltaPair(
  d: AdjustmentDelta,
  viewMode: ChartViewMode,
): { cumUsd: number; cumEur: number } {
  if (viewMode === "total") return { cumUsd: d.cumulative_usd, cumEur: d.cumulative_eur };
  if (viewMode === "investments") return {
    cumUsd: d.crypto_cumulative_usd + d.stocks_cumulative_usd,
    cumEur: d.crypto_cumulative_eur + d.stocks_cumulative_eur,
  };
  if (viewMode === "crypto") return { cumUsd: d.crypto_cumulative_usd, cumEur: d.crypto_cumulative_eur };
  if (viewMode === "stocks") return { cumUsd: d.stocks_cumulative_usd, cumEur: d.stocks_cumulative_eur };
  return { cumUsd: d.cash_cumulative_usd, cumEur: d.cash_cumulative_eur };
}

function getCumulativeDelta(
  date: string,
  deltaLookup: { date: string; cumUsd: number; cumEur: number }[],
): { usd: number; eur: number } {
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
  sp500History: { date: string; close: number }[],
): number | undefined {
  const exact = sp500Map.get(date);
  if (exact != null) return exact;
  for (let i = sp500History.length - 1; i >= 0; i--) {
    if (sp500History[i].date <= date && sp500History[i].close > 0)
      return sp500History[i].close;
  }
  return undefined;
}

function toDisplayCurrency(
  usdAmount: number,
  point: { value: number; valueUsd: number },
  primaryCurrency: string,
): number | undefined {
  if (primaryCurrency === "USD") return usdAmount;
  if (point.valueUsd === 0) return undefined;
  return usdAmount * (point.value / point.valueUsd);
}

// ── Main function ──────────────────────────────────────────

/**
 * Enrich chart data points with S&P 500 benchmark values and adjustment
 * compensation. Pure function — no React, no I/O.
 */
export function enrichChartData(input: EnrichChartDataInput): EnrichedChartPoint[] {
  const {
    points,
    viewMode,
    primaryCurrency,
    sp500History,
    cashFlows,
    adjustmentDeltas,
    snapshotRatios,
  } = input;

  if (points.length === 0) return [];

  // Pre-compute delta lookup and final cumulative delta
  const deltaLookup = adjustmentDeltas.map((d) => ({
    date: d.date,
    ...getDeltaPair(d, viewMode),
  }));

  const finalCumDelta =
    deltaLookup.length > 0
      ? deltaLookup[deltaLookup.length - 1]
      : { cumUsd: 0, cumEur: 0 };

  const sp500Map = new Map(sp500History.map((p) => [p.date, p.close]));

  const hasCashFlows = cashFlows.length > 0;
  const chartStart = points[0].date;

  // Shorthand for display-currency delta
  const deltaDisp = (d: { usd: number; eur: number }) =>
    primaryCurrency === "EUR" ? d.eur : d.usd;

  const finalDeltaDisplay =
    primaryCurrency === "EUR" ? finalCumDelta.cumEur : finalCumDelta.cumUsd;

  if (hasCashFlows) {
    return enrichCashFlowAdjusted(
      points, viewMode, primaryCurrency, sp500History, sp500Map,
      cashFlows, deltaLookup, finalCumDelta, finalDeltaDisplay, deltaDisp,
      snapshotRatios, chartStart,
    );
  }

  return enrichNaiveFallback(
    points, viewMode, primaryCurrency, sp500Map, sp500History,
    deltaLookup, finalCumDelta, finalDeltaDisplay, deltaDisp, chartStart,
  );
}

// ── Cash-flow-adjusted path ────────────────────────────────

function enrichCashFlowAdjusted(
  points: ChartPoint[],
  viewMode: ChartViewMode,
  primaryCurrency: string,
  sp500History: { date: string; close: number }[],
  sp500Map: Map<string, number>,
  cashFlows: CashFlowEvent[],
  deltaLookup: { date: string; cumUsd: number; cumEur: number }[],
  finalCumDelta: { cumUsd: number; cumEur: number },
  finalDeltaDisplay: number,
  deltaDisp: (d: { usd: number; eur: number }) => number,
  snapshotRatios: { date: string; ratio: number }[] | null,
  chartStart: string,
): EnrichedChartPoint[] {
  let sp500Units = 0;
  let preChartUnits = 0;
  const unitsByDate = new Map<string, number>();

  for (const cf of cashFlows) {
    const price = getSp500Price(cf.date, sp500Map, sp500History);
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

  // Seed S&P units so benchmark starts at the adjusted portfolio value.
  const firstPoint = points[0];
  const sp500StartPrice = getSp500Price(firstPoint.date, sp500Map, sp500History);
  if (sp500StartPrice && sp500StartPrice > 0) {
    const firstDelta = getCumulativeDelta(firstPoint.date, deltaLookup);
    const firstSliceVal = getSliceValue(firstPoint, viewMode, primaryCurrency);
    const firstSliceUsd = getSliceValueUsd(firstPoint, viewMode);
    const adjustedFirstDisp = firstSliceVal + (finalDeltaDisplay - deltaDisp(firstDelta));

    // Convert adjusted display value → USD for unit calculation.
    // Three-tier FX ratio: per-class → portfolio-wide → identity (all zero).
    const fxRatioUsdPerDisp =
      firstSliceUsd > 0 && firstSliceVal > 0
        ? firstSliceUsd / firstSliceVal
        : firstPoint.value > 0
          ? firstPoint.valueUsd / firstPoint.value
          : 1;
    const adjustedFirstUsd = adjustedFirstDisp * fxRatioUsdPerDisp;

    const neededUnits = adjustedFirstUsd / sp500StartPrice;
    if (neededUnits > preChartUnits) {
      const seedDelta = neededUnits - preChartUnits;
      sp500Units += seedDelta;
      preChartUnits = neededUnits;
      for (const [date, units] of unitsByDate) {
        unitsByDate.set(date, units + seedDelta);
      }
    }
  }

  let currentUnits = preChartUnits;
  return points.map((p) => {
    if (unitsByDate.has(p.date)) {
      currentUnits = unitsByDate.get(p.date)!;
    }
    const price = getSp500Price(p.date, sp500Map, sp500History);
    const sp500ValueUsd = price != null ? currentUnits * price : undefined;
    const sp500Value = sp500ValueUsd != null
      ? toDisplayCurrency(sp500ValueUsd, p, primaryCurrency)
      : undefined;

    const sliceVal = getSliceValue(p, viewMode, primaryCurrency);
    const delta = getCumulativeDelta(p.date, deltaLookup);
    const adjustedValue = sliceVal + (finalDeltaDisplay - deltaDisp(delta));

    return { ...p, value: sliceVal, sp500Value, adjustedValue, rawValue: sliceVal };
  });
}

// ── Naive fallback path ────────────────────────────────────

function enrichNaiveFallback(
  points: ChartPoint[],
  viewMode: ChartViewMode,
  primaryCurrency: string,
  sp500Map: Map<string, number>,
  sp500History: { date: string; close: number }[],
  deltaLookup: { date: string; cumUsd: number; cumEur: number }[],
  finalCumDelta: { cumUsd: number; cumEur: number },
  finalDeltaDisplay: number,
  deltaDisp: (d: { usd: number; eur: number }) => number,
  chartStart: string,
): EnrichedChartPoint[] {
  const firstSliceVal = getSliceValue(points[0], viewMode, primaryCurrency);
  const firstDeltaFb = getCumulativeDelta(chartStart, deltaLookup);
  const portfolioStart = firstSliceVal + (finalDeltaDisplay - deltaDisp(firstDeltaFb));
  const sp500Start = getSp500Price(chartStart, sp500Map, sp500History);

  return points.map((p) => {
    const sliceVal = getSliceValue(p, viewMode, primaryCurrency);
    let sp500Value: number | undefined;
    if (sp500Start && portfolioStart > 0) {
      const close = getSp500Price(p.date, sp500Map, sp500History);
      if (close != null) {
        sp500Value = (portfolioStart / sp500Start) * close;
      }
    }

    const delta = getCumulativeDelta(p.date, deltaLookup);
    const adjustedValue = sliceVal + (finalDeltaDisplay - deltaDisp(delta));

    return { ...p, value: sliceVal, sp500Value, adjustedValue, rawValue: sliceVal };
  });
}
