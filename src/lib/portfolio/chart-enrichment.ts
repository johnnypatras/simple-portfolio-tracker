/**
 * Chart enrichment — pure computation, no React.
 *
 * Extracts the benchmark / adjustment enrichment logic from
 * portfolio-chart.tsx so it can be tested without a render context.
 */

import type { AdjustmentDelta, CashFlowEvent, BaseCurrency } from "@/lib/types";

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
  primaryCurrency: BaseCurrency;
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
  deltaMap: Map<string, { usd: number; eur: number }>,
): { usd: number; eur: number } {
  return deltaMap.get(date) ?? { usd: 0, eur: 0 };
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

  // Pre-compute delta lookup sorted by date
  const deltaLookup = adjustmentDeltas.map((d) => ({
    date: d.date,
    ...getDeltaPair(d, viewMode),
  }));

  const finalCumDelta =
    deltaLookup.length > 0
      ? deltaLookup[deltaLookup.length - 1]
      : { cumUsd: 0, cumEur: 0 };

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

  // Build deltaMap keyed by every chart date so getCumulativeDelta is O(1)
  const deltaMap = new Map<string, { usd: number; eur: number }>();
  if (points.length > 0) {
    let lastDelta = { usd: 0, eur: 0 };
    let di = 0;
    for (const p of points) {
      while (di < deltaLookup.length && deltaLookup[di].date <= p.date) {
        lastDelta = { usd: deltaLookup[di].cumUsd, eur: deltaLookup[di].cumEur };
        di++;
      }
      deltaMap.set(p.date, lastDelta);
    }
  }

  const hasCashFlows = cashFlows.length > 0;
  const chartStart = points[0].date;

  // Shorthand for display-currency delta
  const deltaDisp = (d: { usd: number; eur: number }) =>
    primaryCurrency === "EUR" ? d.eur : d.usd;

  const finalDeltaDisplay =
    primaryCurrency === "EUR" ? finalCumDelta.cumEur : finalCumDelta.cumUsd;

  if (hasCashFlows) {
    return enrichCashFlowAdjusted(
      points, viewMode, primaryCurrency, sp500Map,
      cashFlows, deltaMap, finalDeltaDisplay, deltaDisp,
      snapshotRatios, chartStart,
    );
  }

  return enrichNaiveFallback(
    points, viewMode, primaryCurrency, sp500Map,
    deltaMap, finalDeltaDisplay, deltaDisp, chartStart,
  );
}

// ── Cash-flow-adjusted path ────────────────────────────────

function enrichCashFlowAdjusted(
  points: ChartPoint[],
  viewMode: ChartViewMode,
  primaryCurrency: BaseCurrency,
  sp500Map: Map<string, number>,
  cashFlows: CashFlowEvent[],
  deltaMap: Map<string, { usd: number; eur: number }>,
  finalDeltaDisplay: number,
  deltaDisp: (d: { usd: number; eur: number }) => number,
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

  // Seed S&P units so benchmark starts at the adjusted portfolio value.
  const firstPoint = points[0];
  const sp500StartPrice = getSp500Price(firstPoint.date, sp500Map);
  if (sp500StartPrice && sp500StartPrice > 0) {
    const firstDelta = getCumulativeDelta(firstPoint.date, deltaMap);
    const firstSliceVal = getSliceValue(firstPoint, viewMode, primaryCurrency);
    const firstSliceUsd = getSliceValueUsd(firstPoint, viewMode);
    const adjustedFirstDisp = firstSliceVal + (finalDeltaDisplay - deltaDisp(firstDelta));

    // Convert adjusted display value → USD for unit calculation.
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
      const adjustedFirstUsd = adjustedFirstDisp * fxRatioUsdPerDisp;
      const neededUnits = adjustedFirstUsd / sp500StartPrice;
      if (neededUnits !== preChartUnits) {
        const seedDelta = neededUnits - preChartUnits;
        sp500Units += seedDelta;
        preChartUnits = neededUnits;
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
    const delta = getCumulativeDelta(p.date, deltaMap);
    const adjustedValue = sliceVal + (finalDeltaDisplay - deltaDisp(delta));

    return { ...p, value: sliceVal, sp500Value, adjustedValue, rawValue: sliceVal };
  });
}

// ── Naive fallback path ────────────────────────────────────

function enrichNaiveFallback(
  points: ChartPoint[],
  viewMode: ChartViewMode,
  primaryCurrency: BaseCurrency,
  sp500Map: Map<string, number>,
  deltaMap: Map<string, { usd: number; eur: number }>,
  finalDeltaDisplay: number,
  deltaDisp: (d: { usd: number; eur: number }) => number,
  chartStart: string,
): EnrichedChartPoint[] {
  const firstSliceVal = getSliceValue(points[0], viewMode, primaryCurrency);
  const firstDeltaFb = getCumulativeDelta(chartStart, deltaMap);
  const portfolioStart = firstSliceVal + (finalDeltaDisplay - deltaDisp(firstDeltaFb));
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

    const delta = getCumulativeDelta(p.date, deltaMap);
    const adjustedValue = sliceVal + (finalDeltaDisplay - deltaDisp(delta));

    return { ...p, value: sliceVal, sp500Value, adjustedValue, rawValue: sliceVal };
  });
}
