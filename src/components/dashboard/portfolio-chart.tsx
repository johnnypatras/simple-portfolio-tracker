"use client";

import { useState, useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { PortfolioSnapshot } from "@/lib/types";

interface PortfolioChartProps {
  snapshots: PortfolioSnapshot[];
  liveValue: number;
  primaryCurrency: string;
}

const PERIODS = [
  { label: "7D", days: 7 },
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
  { label: "1Y", days: 365 },
  { label: "All", days: Infinity },
] as const;

function formatCurrencyShort(value: number, currency: string): string {
  if (value >= 1_000_000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
      notation: "compact",
    }).format(value);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

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
  const period = PERIODS[periodIdx];

  const valueKey =
    primaryCurrency === "EUR" ? "total_value_eur" : "total_value_usd";

  // Filter snapshots to selected period + append today's live value
  const data = useMemo(() => {
    const cutoff =
      period.days === Infinity
        ? null
        : new Date(Date.now() - period.days * 86_400_000)
            .toISOString()
            .split("T")[0];

    const filtered = cutoff
      ? snapshots.filter((s) => s.snapshot_date >= cutoff)
      : snapshots;

    const points = filtered.map((s) => ({
      date: s.snapshot_date,
      value: s[valueKey] ?? 0,
    }));

    // Append today's live value as the last point
    const today = new Date().toISOString().split("T")[0];
    const lastDate = points[points.length - 1]?.date;
    if (lastDate !== today) {
      points.push({ date: today, value: liveValue });
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
        <h3 className="text-sm font-medium text-zinc-400">Portfolio Value</h3>
        <PeriodSelector
          periods={PERIODS}
          activeIdx={periodIdx}
          onChange={setPeriodIdx}
        />
      </div>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date"
              tickFormatter={formatDate}
              tick={{ fill: "#71717a", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              domain={yDomain}
              tickFormatter={(v: number) =>
                formatCurrencyShort(v, primaryCurrency)
              }
              tick={{ fill: "#71717a", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={70}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.[0]) return null;
                const point = payload[0].payload as { date: string; value: number };
                return (
                  <div className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 shadow-lg">
                    <p className="text-xs text-zinc-400">
                      {formatDate(point.date)}
                    </p>
                    <p className="text-sm font-medium text-zinc-100">
                      {formatCurrencyShort(point.value, primaryCurrency)}
                    </p>
                  </div>
                );
              }}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke="#3b82f6"
              strokeWidth={2}
              fill="url(#areaGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
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
