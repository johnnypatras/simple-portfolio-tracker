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
} from "recharts";
import { Layers, TrendingUp, Info } from "lucide-react";
import type { PortfolioSnapshot } from "@/lib/types";
import type { CashFlowEvent } from "@/lib/actions/benchmark";
import { fmtCurrencyCompact } from "@/lib/format";

interface PortfolioChartProps {
  snapshots: PortfolioSnapshot[];
  liveValue: number;
  liveValueUsd?: number;
  primaryCurrency: string;
  sp500History?: { date: string; close: number }[];
  cashFlows?: CashFlowEvent[];
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
}: PortfolioChartProps) {
  const [periodIdx, setPeriodIdx] = useState(3); // default to 30D
  const [showAllocation, setShowAllocation] = useState(false);
  const [showBenchmark, setShowBenchmark] = useState(false);
  const period = PERIODS[periodIdx];

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
      // Allocation % from snapshot data (always USD-based for consistency)
      const totalUsd = s.total_value_usd || 1; // avoid division by zero
      return {
        date: s.snapshot_date,
        value: s[valueKey] ?? 0,
        valueUsd: s.total_value_usd ?? 0, // always track USD for S&P benchmark FX conversion
        cryptoPct: (s.crypto_value_usd / totalUsd) * 100,
        stocksPct: (s.stocks_value_usd / totalUsd) * 100,
        cashPct: (s.cash_value_usd / totalUsd) * 100,
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
      });
    } else {
      // Update today's point with live value (fresher than snapshot)
      points[points.length - 1].value = liveValue;
      points[points.length - 1].valueUsd = liveValueUsd;
    }

    // ── Cash-flow-adjusted S&P 500 benchmark ──
    // Instead of naive normalization, we simulate: "What if every dollar
    // deposited/withdrawn had gone into the S&P 500 instead?"
    //
    // Algorithm: track hypothetical S&P 500 "units" purchased with each
    // cash flow. On any day, hypothetical value = units × S&P price.
    //
    // If no cash flow data exists, fall back to naive normalization
    // (both lines start at the same value on day 1).
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

    let enriched: (typeof points[number] & { sp500Value?: number })[];

    // Helper: convert a USD amount to display currency using the snapshot's
    // implicit FX rate. When primaryCurrency is USD, this is a no-op.
    const toDisplayCurrency = (usdAmount: number, point: { value: number; valueUsd: number }): number | undefined => {
      if (primaryCurrency === "USD") return usdAmount;
      if (point.valueUsd === 0) return undefined; // can't derive FX rate
      return usdAmount * (point.value / point.valueUsd);
    };

    if (hasCashFlows) {
      // ── Cash-flow-adjusted mode ──
      // Don't use the first snapshot value as "initial investment" — the
      // activity log already captures all deposits/positions as cash flows.
      // Using both would double-count.
      // Instead, start with 0 units and let cash flows alone determine
      // how many hypothetical S&P 500 units the user would hold.
      let sp500Units = 0;

      // Track pre-chart units separately, and in-chart flows by date
      let preChartUnits = 0;
      const unitsByDate = new Map<string, number>();

      // Replay cash flows in chronological order
      for (const cf of cashFlows) {
        const price = getSp500Price(cf.date);
        if (price && price > 0) {
          sp500Units += cf.amount_usd / price;
        }
        if (cf.date < chartStart) {
          preChartUnits = sp500Units;
        } else {
          unitsByDate.set(cf.date, sp500Units);
        }
      }

      // Compute hypothetical value for each chart point
      let currentUnits = preChartUnits;
      enriched = points.map((p) => {
        // Update units if a cash flow happened on this date
        if (unitsByDate.has(p.date)) {
          currentUnits = unitsByDate.get(p.date)!;
        }
        const price = getSp500Price(p.date);
        // sp500 price × units = USD value → convert to display currency
        const sp500ValueUsd = price != null ? currentUnits * price : undefined;
        const sp500Value = sp500ValueUsd != null
          ? toDisplayCurrency(sp500ValueUsd, p)
          : undefined;
        return { ...p, sp500Value };
      });
    } else {
      // ── Fallback: naive normalization ──
      // Both lines start at the same dollar value on day 1.
      const portfolioStart = points[0]?.value ?? 0;
      const sp500Start = getSp500Price(chartStart);

      enriched = points.map((p) => {
        let sp500Value: number | undefined;
        if (sp500Start && portfolioStart > 0) {
          const close = getSp500Price(p.date);
          if (close != null) {
            sp500Value = (portfolioStart / sp500Start) * close;
          }
        }
        return { ...p, sp500Value };
      });
    }

    return enriched;
  }, [snapshots, liveValue, liveValueUsd, valueKey, primaryCurrency, period.days, sp500History, cashFlows]);

  if (data.length < 2) {
    return (
      <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-3 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
          <h3 className="text-sm font-medium text-zinc-400">Portfolio Value</h3>
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

  const allValues = data.flatMap((d) =>
    showBenchmark && d.sp500Value != null ? [d.value, d.sp500Value] : [d.value]
  );
  const minValue = Math.min(...allValues);
  const maxValue = Math.max(...allValues);
  const yDomain = [
    Math.floor(minValue * 0.95),
    Math.ceil(maxValue * 1.05),
  ];

  return (
    <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-3 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-zinc-400">Portfolio Value</h3>
          <button
            onClick={() => setShowAllocation(!showAllocation)}
            className={`flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md transition-colors ${
              showAllocation
                ? "bg-zinc-700 text-zinc-200"
                : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800"
            }`}
            title="Toggle allocation overlay"
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
        </div>
        <PeriodSelector
          periods={PERIODS}
          activeIdx={periodIdx}
          onChange={setPeriodIdx}
        />
      </div>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data}>
            <defs>
              <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-stroke)" stopOpacity={0.3} />
                <stop offset="100%" stopColor="var(--chart-stroke)" stopOpacity={0} />
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
              domain={yDomain}
              tickFormatter={(v: number) =>
                fmtCurrencyCompact(v, primaryCurrency)
              }
              tick={{ fill: "var(--chart-tick)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={70}
            />
            {showAllocation && (
              <YAxis
                yAxisId="pct"
                orientation="right"
                domain={[0, 100]}
                tickFormatter={(v: number) => `${v}%`}
                tick={{ fill: "var(--chart-tick)", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={40}
              />
            )}
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.[0]) return null;
                const point = payload[0].payload as {
                  date: string;
                  value: number;
                  sp500Value?: number;
                  cryptoPct: number;
                  stocksPct: number;
                  cashPct: number;
                };
                return (
                  <div className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 shadow-lg">
                    <p className="text-xs text-zinc-400">
                      {formatDate(point.date)}
                    </p>
                    <p className="text-sm font-medium text-zinc-100">
                      {fmtCurrencyCompact(point.value, primaryCurrency)}
                    </p>
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
            <Area
              yAxisId="value"
              type="monotone"
              dataKey="value"
              stroke="var(--chart-stroke)"
              strokeWidth={2}
              fill="url(#areaGradient)"
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
            {showAllocation && (
              <>
                <Line
                  yAxisId="pct"
                  type="monotone"
                  dataKey="cryptoPct"
                  stroke="#f97316"
                  strokeWidth={1.5}
                  dot={false}
                  strokeDasharray="4 2"
                />
                <Line
                  yAxisId="pct"
                  type="monotone"
                  dataKey="stocksPct"
                  stroke="#3b82f6"
                  strokeWidth={1.5}
                  dot={false}
                  strokeDasharray="4 2"
                />
                <Line
                  yAxisId="pct"
                  type="monotone"
                  dataKey="cashPct"
                  stroke="#10b981"
                  strokeWidth={1.5}
                  dot={false}
                  strokeDasharray="4 2"
                />
              </>
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
                <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-56 px-2.5 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-[10px] leading-relaxed text-zinc-300 shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-50">
                  {cashFlows.length > 0
                    ? "\"What if I\u2019d put every dollar into the S&P 500 instead?\" Each deposit, purchase, and withdrawal is replayed at the S&P price on that day. Accuracy improves over time as more changes are tracked."
                    : "Simple comparison \u2014 both lines start at the same value. Does not account for the timing of deposits or withdrawals, so differences may be misleading."
                  }
                </span>
              </span>
            </>
          )}
          {showAllocation && (
            <>
              <LegendItem color="bg-orange-500" label="Crypto %" />
              <LegendItem color="bg-blue-500" label="Stocks %" />
              <LegendItem color="bg-emerald-500" label="Cash %" />
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
