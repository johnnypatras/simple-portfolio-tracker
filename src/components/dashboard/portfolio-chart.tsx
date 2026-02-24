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
import { Layers } from "lucide-react";
import type { PortfolioSnapshot } from "@/lib/types";
import { fmtCurrencyCompact } from "@/lib/format";

interface PortfolioChartProps {
  snapshots: PortfolioSnapshot[];
  liveValue: number;
  primaryCurrency: string;
}

// Module-level constant: today's date string (stable for the lifetime of the page)
const TODAY = new Date().toISOString().split("T")[0];
const TODAY_MS = new Date(TODAY + "T00:00:00").getTime();

const PERIODS = [
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
  primaryCurrency,
}: PortfolioChartProps) {
  const [periodIdx, setPeriodIdx] = useState(1); // default to 30D
  const [showAllocation, setShowAllocation] = useState(false);
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
        cryptoPct: lastPoint?.cryptoPct ?? 0,
        stocksPct: lastPoint?.stocksPct ?? 0,
        cashPct: lastPoint?.cashPct ?? 0,
      });
    } else {
      // Update today's point with live value (fresher than snapshot)
      points[points.length - 1].value = liveValue;
    }

    return points;
  }, [snapshots, liveValue, valueKey, period.days]);

  if (data.length < 2) {
    return (
      <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
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

  const minValue = Math.min(...data.map((d) => d.value));
  const maxValue = Math.max(...data.map((d) => d.value));
  const yDomain = [
    Math.floor(minValue * 0.95),
    Math.ceil(maxValue * 1.05),
  ];

  return (
    <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
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
      {showAllocation && (
        <div className="flex items-center justify-center gap-4 mt-2">
          <LegendItem color="bg-orange-500" label="Crypto %" />
          <LegendItem color="bg-blue-500" label="Stocks %" />
          <LegendItem color="bg-emerald-500" label="Cash %" />
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
          className={`px-2 py-0.5 text-xs rounded-md transition-colors ${
            i === activeIdx
              ? "bg-blue-600 text-white"
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

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-2.5 h-0.5 rounded-full ${color}`} />
      <span className="text-[10px] text-zinc-500">{label}</span>
    </div>
  );
}
