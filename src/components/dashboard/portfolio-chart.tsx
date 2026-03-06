"use client";

import { useState, useMemo } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Layers, TrendingUp, Info, BarChart3, Percent } from "lucide-react";
import type { PortfolioSnapshot } from "@/lib/types";
import type { CashFlowEvent } from "@/lib/actions/benchmark";
import type { AdjustmentDelta } from "@/lib/actions/activity-log";
import { fmtCurrencyCompact } from "@/lib/format";

interface PortfolioChartProps {
  snapshots: PortfolioSnapshot[];
  liveValue: number;
  liveValueUsd?: number;
  primaryCurrency: string;
  sp500History?: { date: string; close: number }[];
  cashFlows?: CashFlowEvent[];
  adjustmentDeltas?: AdjustmentDelta[];
  liveSlicesUsd?: { crypto: number; stocks: number; cash: number };
  /** When true, chart defaults to cumulative % return mode */
  defaultReturnMode?: boolean;
}

// Module-level constant: today's date string (stable for the lifetime of the page)
const TODAY = new Date().toISOString().split("T")[0];
const TODAY_MS = new Date(TODAY + "T00:00:00").getTime();

const PERIODS = [
  { label: "24H", days: 1 },
  { label: "3D", days: 3 },
  { label: "7D", days: 7 },
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
  { label: "1Y", days: 365 },
  { label: "All", days: Infinity },
] as const;

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

const VIEW_MODE_COLORS: Record<ChartViewMode, string> = {
  total: "var(--chart-stroke)",
  investments: "#8b5cf6",
  crypto: "#f97316",
  stocks: "#06b6d4",
  cash: "#10b981",
};

const VIEW_MODE_BUTTON_CLASSES: Record<ChartViewMode, string> = {
  total: "",
  investments: "bg-violet-500/20 text-violet-400",
  crypto: "bg-orange-500/20 text-orange-400",
  stocks: "bg-cyan-500/20 text-cyan-400",
  cash: "bg-emerald-500/20 text-emerald-400",
};

const VIEW_MODE_GRADIENTS: Record<ChartViewMode, string> = {
  total: "url(#areaGradient)",
  investments: "url(#investmentsModeGrad)",
  crypto: "url(#cryptoModeGrad)",
  stocks: "url(#stocksModeGrad)",
  cash: "url(#cashModeGrad)",
};

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function PortfolioChart({
  snapshots,
  liveValue,
  liveValueUsd = 0,
  primaryCurrency,
  sp500History = [],
  cashFlows = [],
  adjustmentDeltas = [],
  liveSlicesUsd,
  defaultReturnMode = false,
}: PortfolioChartProps) {
  const [periodIdx, setPeriodIdx] = useState(3); // default to 30D
  const [showAllocation, setShowAllocation] = useState(false);
  const [showBenchmark, setShowBenchmark] = useState(true);
  const [viewMode, setViewMode] = useState<ChartViewMode>("total");
  const [returnMode, setReturnMode] = useState(defaultReturnMode);
  const period = PERIODS[periodIdx];

  const hasDeltas = adjustmentDeltas.length > 0;

  const valueKey =
    primaryCurrency === "EUR" ? "total_value_eur" : "total_value_usd";

  // Filter snapshots to selected period + append today's live value
  const data = useMemo(() => {
    const cutoff =
      period.days === Infinity
        ? null
        : new Date(TODAY_MS - period.days * 86_400_000)
            .toISOString()
            .split("T")[0];

    const filtered = cutoff
      ? snapshots.filter((s) => s.snapshot_date >= cutoff)
      : snapshots;

    const points = filtered.map((s) => {
      const totalUsd = s.total_value_usd || 1;
      return {
        date: s.snapshot_date,
        value: s[valueKey] ?? 0,
        valueUsd: s.total_value_usd ?? 0,
        cryptoPct: (s.crypto_value_usd / totalUsd) * 100,
        stocksPct: (s.stocks_value_usd / totalUsd) * 100,
        cashPct: (s.cash_value_usd / totalUsd) * 100,
        cryptoUsd: s.crypto_value_usd ?? 0,
        stocksUsd: s.stocks_value_usd ?? 0,
        cashUsd: s.cash_value_usd ?? 0,
      };
    });

    // Append today's live value as the last point
    const lastDate = points[points.length - 1]?.date;
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

    // ── Slice value extraction per view mode ──
    const getSliceValueUsd = (p: typeof points[number]): number => {
      if (viewMode === "total") return p.valueUsd;
      if (viewMode === "investments") return p.cryptoUsd + p.stocksUsd;
      if (viewMode === "crypto") return p.cryptoUsd;
      if (viewMode === "stocks") return p.stocksUsd;
      return p.cashUsd;
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

    // ── Snapshot ratio lookup for S&P scaling ──
    const snapshotRatios = viewMode === "total"
      ? null
      : filtered.map((s) => {
          const totalUsd = s.total_value_usd ?? 0;
          let sliceUsd: number;
          if (viewMode === "investments") sliceUsd = (s.crypto_value_usd ?? 0) + (s.stocks_value_usd ?? 0);
          else if (viewMode === "crypto") sliceUsd = s.crypto_value_usd ?? 0;
          else if (viewMode === "stocks") sliceUsd = s.stocks_value_usd ?? 0;
          else sliceUsd = s.cash_value_usd ?? 0;
          return { date: s.snapshot_date, ratio: totalUsd > 0 ? sliceUsd / totalUsd : 0 };
        });

    const getSliceRatio = (date: string): number => {
      if (!snapshotRatios || snapshotRatios.length === 0) return 1;
      let ratio = snapshotRatios[0].ratio;
      for (const sr of snapshotRatios) {
        if (sr.date <= date) ratio = sr.ratio;
        else break;
      }
      return ratio;
    };

    // ── Cash-flow-adjusted S&P 500 benchmark ──
    const sp500Map = new Map(sp500History.map((p) => [p.date, p.close]));

    // Helper: get S&P price for a date, falling back to nearest earlier date
    const getSp500Price = (date: string): number | undefined => {
      const exact = sp500Map.get(date);
      if (exact != null) return exact;
      for (let i = sp500History.length - 1; i >= 0; i--) {
        if (sp500History[i].date <= date && sp500History[i].close > 0)
          return sp500History[i].close;
      }
      return undefined;
    };

    const hasCashFlows = cashFlows.length > 0;
    const chartStart = points[0]?.date ?? "";

    // Helper: convert a USD amount to display currency using the snapshot's
    // implicit FX rate. When primaryCurrency is USD, this is a no-op.
    const toDisplayCurrency = (usdAmount: number, point: { value: number; valueUsd: number }): number | undefined => {
      if (primaryCurrency === "USD") return usdAmount;
      if (point.valueUsd === 0) return undefined; // can't derive FX rate
      return usdAmount * (point.value / point.valueUsd);
    };

    type ChartPoint = typeof points[number] & {
      sp500Value?: number;
      adjustedValue?: number;
      rawValue?: number;
    };

    let enriched: ChartPoint[];

    if (hasCashFlows) {
      // ── Cash-flow-adjusted mode ──
      let sp500Units = 0;
      let preChartUnits = 0;
      const unitsByDate = new Map<string, number>();

      for (const cf of cashFlows) {
        const price = getSp500Price(cf.date);
        if (price && price > 0) {
          const scaledAmount = cf.amount_usd * getSliceRatio(cf.date);
          sp500Units += scaledAmount / price;
        }
        if (cf.date < chartStart) {
          preChartUnits = sp500Units;
        } else {
          unitsByDate.set(cf.date, sp500Units);
        }
      }

      // Seed S&P units so the benchmark starts at the adjusted portfolio value.
      // Import entries excluded from cashFlows (is_adjustment=true) still represent
      // real invested capital. Without seeding, the S&P line starts too low.
      const firstPoint = points[0];
      if (firstPoint) {
        const sp500StartPrice = getSp500Price(firstPoint.date);
        if (sp500StartPrice && sp500StartPrice > 0) {
          const firstDelta = getCumulativeDelta(firstPoint.date);
          const firstSliceVal = getSliceValue(firstPoint);
          const firstSliceUsd = getSliceValueUsd(firstPoint);
          const firstDeltaDisp =
            primaryCurrency === "EUR" ? firstDelta.eur : firstDelta.usd;
          const finalDeltaDisp =
            primaryCurrency === "EUR"
              ? finalCumDelta.cumEur
              : finalCumDelta.cumUsd;
          const adjustedFirstDisp =
            firstSliceVal + (finalDeltaDisp - firstDeltaDisp);
          const adjustedFirstUsd =
            firstSliceUsd > 0 && firstSliceVal > 0
              ? adjustedFirstDisp * (firstSliceUsd / firstSliceVal)
              : adjustedFirstDisp;
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
      }

      let currentUnits = preChartUnits;
      enriched = points.map((p) => {
        if (unitsByDate.has(p.date)) {
          currentUnits = unitsByDate.get(p.date)!;
        }
        const price = getSp500Price(p.date);
        const sp500ValueUsd = price != null ? currentUnits * price : undefined;
        const sp500Value = sp500ValueUsd != null
          ? toDisplayCurrency(sp500ValueUsd, p)
          : undefined;

        const sliceVal = getSliceValue(p);
        const delta = getCumulativeDelta(p.date);
        const deltaDisplay =
          primaryCurrency === "EUR" ? delta.eur : delta.usd;
        const finalDeltaDisplay =
          primaryCurrency === "EUR" ? finalCumDelta.cumEur : finalCumDelta.cumUsd;
        const adjustedValue = sliceVal + (finalDeltaDisplay - deltaDisplay);

        return { ...p, value: sliceVal, sp500Value, adjustedValue, rawValue: sliceVal };
      });
    } else {
      // ── Fallback: naive normalization ──
      // Use adjusted start value so S&P matches portfolio after adjustment compensation
      const firstSliceVal = points[0] ? getSliceValue(points[0]) : 0;
      const firstDeltaFb = getCumulativeDelta(chartStart);
      const finalDeltaFb =
        primaryCurrency === "EUR" ? finalCumDelta.cumEur : finalCumDelta.cumUsd;
      const firstDeltaFbDisplay =
        primaryCurrency === "EUR" ? firstDeltaFb.eur : firstDeltaFb.usd;
      const portfolioStart = firstSliceVal + (finalDeltaFb - firstDeltaFbDisplay);
      const sp500Start = getSp500Price(chartStart);

      enriched = points.map((p) => {
        const sliceVal = getSliceValue(p);
        let sp500Value: number | undefined;
        if (sp500Start && portfolioStart > 0) {
          const close = getSp500Price(p.date);
          if (close != null) {
            sp500Value = (portfolioStart / sp500Start) * close;
          }
        }

        const delta = getCumulativeDelta(p.date);
        const deltaDisplay =
          primaryCurrency === "EUR" ? delta.eur : delta.usd;
        const finalDeltaDisplay =
          primaryCurrency === "EUR" ? finalCumDelta.cumEur : finalCumDelta.cumUsd;
        const adjustedValue = sliceVal + (finalDeltaDisplay - deltaDisplay);

        return { ...p, value: sliceVal, sp500Value, adjustedValue, rawValue: sliceVal };
      });
    }

    return enriched;
  }, [snapshots, liveValue, liveValueUsd, liveSlicesUsd, valueKey, primaryCurrency, period.days, sp500History, cashFlows, adjustmentDeltas, viewMode]);

  // Use the active dataKey for y-axis domain
  const yDomain = useMemo(() => {
    if (data.length === 0) return [0, 100] as const;
    const key = hasDeltas ? "adjustedValue" : "value";
    const allValues = data.flatMap((d) => {
      const v = (d as Record<string, unknown>)[key] as number ?? d.value;
      return showBenchmark && d.sp500Value != null ? [v, d.sp500Value] : [v];
    });
    const minValue = Math.min(...allValues);
    const maxValue = Math.max(...allValues);
    return [Math.floor(minValue * 0.99), Math.ceil(maxValue * 1.01)] as const;
  }, [data, hasDeltas, showBenchmark]);

  // Compute allocation area fields relative to yDomain baseline.
  // Uses overlapping (non-stacked) areas: each fills from yDomain[0] to its value.
  // Render order: crypto (behind) → stocks → cash (front) creates visual bands.
  const chartData = useMemo(() => {
    const base = yDomain[0];
    return data.map((p) => {
      const dv = hasDeltas ? (p.adjustedValue ?? p.value) : p.value;
      const range = Math.max(dv - base, 0);
      return {
        ...p,
        allocCrypto: dv,
        allocStocks: base + range * (p.cashPct + p.stocksPct) / 100,
        allocCash: base + range * p.cashPct / 100,
      };
    });
  }, [data, yDomain, hasDeltas]);

  // ── % Return mode transformation ──
  // Converts absolute values to cumulative % return from the first visible point.
  // Both portfolio and S&P start at 0% and diverge, making comparison instant.
  const { finalData, finalYDomain } = useMemo(() => {
    if (!returnMode) return { finalData: chartData, finalYDomain: yDomain };

    const first = chartData[0];
    if (!first) return { finalData: chartData, finalYDomain: yDomain };

    const baseVal = hasDeltas ? (first.adjustedValue ?? first.value) : first.value;
    const baseSp500 = first.sp500Value;

    const toPct = (v: number, base: number) =>
      base > 0 ? ((v - base) / base) * 100 : 0;

    const transformed = chartData.map((p) => {
      const val = hasDeltas ? (p.adjustedValue ?? p.value) : p.value;
      const pctReturn = toPct(val, baseVal);
      const sp500Pct =
        baseSp500 != null && baseSp500 > 0 && p.sp500Value != null
          ? toPct(p.sp500Value, baseSp500)
          : undefined;

      return {
        ...p,
        value: pctReturn,
        adjustedValue: pctReturn,
        rawValue:
          p.rawValue != null && baseVal > 0
            ? toPct(p.rawValue, baseVal)
            : undefined,
        sp500Value: sp500Pct,
        // Allocation areas not meaningful as percentages
        allocCrypto: 0,
        allocStocks: 0,
        allocCash: 0,
      };
    });

    const allVals = transformed.flatMap((d) => {
      const v = d.value;
      return showBenchmark && d.sp500Value != null ? [v, d.sp500Value] : [v];
    });
    const minVal = Math.min(...allVals);
    const maxVal = Math.max(...allVals);
    // Add padding: at least ±1% so the 0% line isn't at the edge
    return {
      finalData: transformed,
      finalYDomain: [
        Math.floor(Math.min(minVal - 1, -1)),
        Math.ceil(Math.max(maxVal + 1, 1)),
      ] as const,
    };
  }, [chartData, yDomain, returnMode, hasDeltas, showBenchmark]);

  // Are we showing stacked allocation areas? Only in total view with allocation ON, not in % return mode
  const showStackedAlloc = showAllocation && viewMode === "total" && !returnMode;

  // Early return for insufficient data — placed after all hooks to satisfy rules-of-hooks
  if (data.length < 2) {
    return (
      <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-3 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
          <h3 className="text-sm font-medium text-zinc-400">{CHART_TITLES[viewMode]}</h3>
          <PeriodSelector
            periods={PERIODS}
            activeIdx={periodIdx}
            onChange={setPeriodIdx}
          />
        </div>
        <div className="h-48 flex items-center justify-center">
          <p className="text-sm text-zinc-600">
            Chart will appear after a few days of data
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-3 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
          <h3 className="text-sm font-medium text-zinc-400 sm:min-w-[9rem]">
            {returnMode ? `${VIEW_MODE_LABELS[viewMode]} Return` : CHART_TITLES[viewMode]}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const nextIdx = (VIEW_MODES.indexOf(viewMode) + 1) % VIEW_MODES.length;
                setViewMode(VIEW_MODES[nextIdx]);
              }}
              className={`flex items-center justify-center gap-1 px-2 py-0.5 text-[10px] rounded-md transition-colors ${
                viewMode !== "total"
                  ? VIEW_MODE_BUTTON_CLASSES[viewMode]
                  : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800"
              }`}
              title="Cycle view: Total → Investments → Crypto → Stocks → Cash"
            >
              <BarChart3 className="w-3 h-3 shrink-0" />
              <span>{VIEW_MODE_LABELS[viewMode]}</span>
            </button>
            <button
              onClick={() => setShowAllocation(!showAllocation)}
              disabled={returnMode}
              className={`flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md transition-colors ${
                returnMode
                  ? "text-zinc-700 cursor-not-allowed"
                  : showAllocation
                    ? "bg-zinc-700 text-zinc-200"
                    : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800"
              }`}
              title={returnMode ? "Allocation overlay not available in % return mode" : "Toggle allocation overlay"}
            >
              <Layers className="w-3 h-3" />
              <span>Allocation</span>
            </button>
            {sp500History.length > 0 && (
              <button
                onClick={() => setShowBenchmark(!showBenchmark)}
                className={`flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md transition-colors ${
                  showBenchmark
                    ? "bg-zinc-700 text-zinc-200"
                    : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800"
                }`}
                title={cashFlows.length > 0
                  ? "S&P 500 TR benchmark (adjusted for cash flows from activity history)"
                  : "S&P 500 TR benchmark (naive — no activity history available)"}
              >
                <TrendingUp className="w-3 h-3" />
                <span>S&P 500</span>
              </button>
            )}
            <button
              onClick={() => setReturnMode(!returnMode)}
              className={`flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md transition-colors ${
                returnMode
                  ? "bg-zinc-700 text-zinc-200"
                  : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800"
              }`}
              title="Toggle cumulative % return view"
            >
              <Percent className="w-3 h-3" />
              <span>Return</span>
            </button>
          </div>
        </div>
        <PeriodSelector
          periods={PERIODS}
          activeIdx={periodIdx}
          onChange={setPeriodIdx}
        />
      </div>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={finalData}>
            <defs>
              <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-stroke)" stopOpacity={0.3} />
                <stop offset="100%" stopColor="var(--chart-stroke)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="investmentsModeGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="cryptoModeGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f97316" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#f97316" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="stocksModeGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#06b6d4" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="cashModeGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date"
              tickFormatter={formatDate}
              tick={{ fill: "var(--chart-tick)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              yAxisId="value"
              domain={finalYDomain}
              tickFormatter={(v: number) =>
                returnMode
                  ? `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`
                  : fmtCurrencyCompact(v, primaryCurrency)
              }
              tick={{ fill: "var(--chart-tick)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={70}
            />
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
                  hasDeltas
                    ? (point.adjustedValue ?? point.value)
                    : point.value;
                const fmtVal = (v: number) =>
                  returnMode
                    ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`
                    : fmtCurrencyCompact(v, primaryCurrency);
                return (
                  <div className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 shadow-lg">
                    <p className="text-xs text-zinc-400">
                      {formatDate(point.date)}
                    </p>
                    <p className="text-sm font-medium text-zinc-100">
                      {viewMode !== "total" && (
                        <span className="text-zinc-500 mr-1">{VIEW_MODE_LABELS[viewMode]}</span>
                      )}
                      {fmtVal(displayValue)}
                      {showBenchmark && point.sp500Value != null && point.sp500Value !== 0 && (() => {
                        const diff = returnMode
                          ? displayValue - point.sp500Value
                          : ((displayValue - point.sp500Value) / point.sp500Value) * 100;
                        return (
                          <span className={`ml-1.5 text-[10px] font-medium ${diff >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            ({diff >= 0 ? "+" : ""}{diff.toFixed(1)}{returnMode ? "pp" : "%"} <span className="text-zinc-500 font-normal">vs S&P</span>)
                          </span>
                        );
                      })()}
                    </p>
                    {!returnMode && hasDeltas && point.rawValue != null && Math.abs(point.rawValue - displayValue) > 0.5 && (
                      <p className="text-[10px] text-zinc-600 mt-0.5">
                        Raw: {fmtCurrencyCompact(point.rawValue, primaryCurrency)}
                      </p>
                    )}
                    {showBenchmark && point.sp500Value != null && (
                      <p className="text-xs text-zinc-500 mt-0.5">
                        S&P 500 TR {fmtVal(point.sp500Value)}
                      </p>
                    )}
                    {showAllocation && (
                      <div className="flex gap-3 mt-1 text-[10px]">
                        <span className="text-orange-400">
                          Crypto {point.cryptoPct.toFixed(0)}%
                        </span>
                        <span className="text-cyan-400">
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
            {showStackedAlloc && (
              <>
                {/* Overlapping allocation areas: crypto (behind) → stocks → cash (front) */}
                {/* Each fills from yDomain[0] baseline to its computed Y position */}
                <Area
                  yAxisId="value"
                  type="monotone"
                  dataKey="allocCrypto"
                  fill="#f97316"
                  fillOpacity={0.15}
                  stroke="none"
                  baseValue={yDomain[0]}
                  isAnimationActive={false}
                />
                <Area
                  yAxisId="value"
                  type="monotone"
                  dataKey="allocStocks"
                  fill="#06b6d4"
                  fillOpacity={0.15}
                  stroke="none"
                  baseValue={yDomain[0]}
                  isAnimationActive={false}
                />
                <Area
                  yAxisId="value"
                  type="monotone"
                  dataKey="allocCash"
                  fill="#10b981"
                  fillOpacity={0.15}
                  stroke="none"
                  baseValue={yDomain[0]}
                  isAnimationActive={false}
                />
              </>
            )}
            {returnMode && (
              <ReferenceLine
                yAxisId="value"
                y={0}
                stroke="#52525b"
                strokeDasharray="4 4"
                strokeWidth={1}
              />
            )}
            <Area
              yAxisId="value"
              type="monotone"
              dataKey={hasDeltas ? "adjustedValue" : "value"}
              stroke={VIEW_MODE_COLORS[viewMode]}
              strokeWidth={2}
              fill={showStackedAlloc ? "none" : VIEW_MODE_GRADIENTS[viewMode]}
            />
            {showBenchmark && (
              <Line
                yAxisId="value"
                type="monotone"
                dataKey="sp500Value"
                stroke="#71717a"
                strokeWidth={1.5}
                strokeDasharray="6 3"
                dot={false}
                connectNulls
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {(showAllocation || showBenchmark) && (
        <div className="flex items-center justify-center gap-4 mt-2">
          {showBenchmark && (
            <>
              <LegendItem color="bg-zinc-500" label="S&P 500 TR" dashed />
              <span className="text-[9px] text-zinc-600">
                {cashFlows.length > 0 ? "adjusted" : "naive"}
              </span>
              <span className="relative group">
                <Info className="w-3 h-3 text-zinc-600 cursor-help" />
                <span className="absolute bottom-full right-0 sm:right-auto sm:left-1/2 sm:-translate-x-1/2 mb-1.5 w-56 max-w-[calc(100vw-3rem)] px-2.5 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-[10px] leading-relaxed text-zinc-300 shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-50">
                  {cashFlows.length > 0
                    ? "\"What if I\u2019d put every dollar into the S&P 500 instead?\" Each deposit, purchase, and withdrawal is replayed at the S&P price on that day. Accuracy improves over time as more changes are tracked."
                    : "Simple comparison \u2014 both lines start at the same value. Does not account for the timing of deposits or withdrawals, so differences may be misleading."
                  }
                </span>
              </span>
            </>
          )}
          {showAllocation && viewMode === "total" && (
            <>
              <LegendItem color="bg-orange-500" label="Crypto" />
              <LegendItem color="bg-cyan-500" label="Stocks" />
              <LegendItem color="bg-emerald-500" label="Cash" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Period selector button group ────────────────────────

function PeriodSelector({
  periods,
  activeIdx,
  onChange,
}: {
  periods: readonly { label: string; days: number }[];
  activeIdx: number;
  onChange: (idx: number) => void;
}) {
  return (
    <div className="flex gap-1">
      {periods.map((p, i) => (
        <button
          key={p.label}
          onClick={() => onChange(i)}
          className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
            i === activeIdx
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
          }`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

// ── Legend item ──────────────────────────────────────────

function LegendItem({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      {dashed ? (
        <div className="flex gap-[2px]">
          <div className={`w-1 h-0.5 rounded-full ${color}`} />
          <div className={`w-1 h-0.5 rounded-full ${color}`} />
        </div>
      ) : (
        <div className={`w-2.5 h-0.5 rounded-full ${color}`} />
      )}
      <span className="text-[10px] text-zinc-500">{label}</span>
    </div>
  );
}
