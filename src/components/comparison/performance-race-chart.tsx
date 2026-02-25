"use client";

import { useState, useMemo } from "react";
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Percent } from "lucide-react";
import type { PortfolioSnapshot } from "@/lib/types";
import { fmtCurrencyCompact, fmtPct } from "@/lib/format";

interface PerformanceRaceChartProps {
  viewerSnapshots: PortfolioSnapshot[];
  ownerSnapshots: PortfolioSnapshot[];
  viewerLiveValue: number;
  ownerLiveValue: number;
  viewerName: string;
  ownerName: string;
  currency: string;
}

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

interface MergedPoint {
  date: string;
  viewerValue: number | null;
  ownerValue: number | null;
  viewerPct: number | null;
  ownerPct: number | null;
}

export function PerformanceRaceChart({
  viewerSnapshots,
  ownerSnapshots,
  viewerLiveValue,
  ownerLiveValue,
  viewerName,
  ownerName,
  currency,
}: PerformanceRaceChartProps) {
  const [periodIdx, setPeriodIdx] = useState(1); // default 30D
  const [normalized, setNormalized] = useState(false);
  const period = PERIODS[periodIdx];

  const valueKey =
    currency === "EUR" ? "total_value_eur" : "total_value_usd";

  const data = useMemo(() => {
    const cutoff =
      period.days === Infinity
        ? null
        : new Date(TODAY_MS - period.days * 86_400_000)
            .toISOString()
            .split("T")[0];

    // Filter by period
    const vSnaps = cutoff
      ? viewerSnapshots.filter((s) => s.snapshot_date >= cutoff)
      : viewerSnapshots;
    const oSnaps = cutoff
      ? ownerSnapshots.filter((s) => s.snapshot_date >= cutoff)
      : ownerSnapshots;

    // Build maps by date
    const vMap = new Map(vSnaps.map((s) => [s.snapshot_date, s[valueKey] ?? 0]));
    const oMap = new Map(oSnaps.map((s) => [s.snapshot_date, s[valueKey] ?? 0]));

    // Union of all dates, sorted
    const allDates = [...new Set([...vMap.keys(), ...oMap.keys()])].sort();

    // Baseline values for percentage normalization (first available value in period)
    const vBaseline = vSnaps.length > 0 ? (vSnaps[0][valueKey] ?? 0) : 0;
    const oBaseline = oSnaps.length > 0 ? (oSnaps[0][valueKey] ?? 0) : 0;

    const points: MergedPoint[] = allDates.map((date) => {
      const vv = vMap.get(date) ?? null;
      const ov = oMap.get(date) ?? null;
      return {
        date,
        viewerValue: vv,
        ownerValue: ov,
        viewerPct: vv !== null && vBaseline > 0 ? ((vv - vBaseline) / vBaseline) * 100 : null,
        ownerPct: ov !== null && oBaseline > 0 ? ((ov - oBaseline) / oBaseline) * 100 : null,
      };
    });

    // Append today's live values
    const lastDate = points[points.length - 1]?.date;
    if (lastDate !== TODAY) {
      points.push({
        date: TODAY,
        viewerValue: viewerLiveValue,
        ownerValue: ownerLiveValue,
        viewerPct: vBaseline > 0 ? ((viewerLiveValue - vBaseline) / vBaseline) * 100 : null,
        ownerPct: oBaseline > 0 ? ((ownerLiveValue - oBaseline) / oBaseline) * 100 : null,
      });
    } else {
      // Update today with live values
      const last = points[points.length - 1];
      last.viewerValue = viewerLiveValue;
      last.ownerValue = ownerLiveValue;
      last.viewerPct = vBaseline > 0 ? ((viewerLiveValue - vBaseline) / vBaseline) * 100 : null;
      last.ownerPct = oBaseline > 0 ? ((ownerLiveValue - oBaseline) / oBaseline) * 100 : null;
    }

    return points;
  }, [viewerSnapshots, ownerSnapshots, viewerLiveValue, ownerLiveValue, valueKey, period.days]);

  if (data.length < 2) {
    return (
      <div className="bg-zinc-900 border border-zinc-800/50 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
            Performance
          </h2>
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

  // Y-axis domain
  const viewerKey = normalized ? "viewerPct" : "viewerValue";
  const ownerKey = normalized ? "ownerPct" : "ownerValue";

  const allValues = data
    .flatMap((d) => [d[viewerKey], d[ownerKey]])
    .filter((v): v is number => v !== null);
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const padding = (maxVal - minVal) * 0.05 || 1;
  const yDomain = [
    Math.floor(minVal - padding),
    Math.ceil(maxVal + padding),
  ];

  return (
    <div className="bg-zinc-900 border border-zinc-800/50 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
            Performance
          </h2>
          <button
            onClick={() => setNormalized(!normalized)}
            className={`flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md transition-colors ${
              normalized
                ? "bg-zinc-700 text-zinc-200"
                : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800"
            }`}
            title="Toggle percentage change view"
          >
            <Percent className="w-3 h-3" />
            <span>Normalize</span>
          </button>
        </div>
        <PeriodSelector
          periods={PERIODS}
          activeIdx={periodIdx}
          onChange={setPeriodIdx}
        />
      </div>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data}>
            <XAxis
              dataKey="date"
              tickFormatter={formatDate}
              tick={{ fill: "#52525b", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              domain={yDomain}
              tickFormatter={(v: number) =>
                normalized
                  ? `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`
                  : fmtCurrencyCompact(v, currency)
              }
              tick={{ fill: "#52525b", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={70}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const point = payload[0].payload as MergedPoint;
                return (
                  <div className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 shadow-lg">
                    <p className="text-xs text-zinc-400 mb-1.5">
                      {formatDate(point.date)}
                    </p>
                    {point.viewerValue !== null && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                        <span className="text-zinc-400">{viewerName}</span>
                        <span className="font-medium text-zinc-100 ml-auto">
                          {normalized && point.viewerPct !== null
                            ? fmtPct(point.viewerPct)
                            : fmtCurrencyCompact(point.viewerValue, currency)}
                        </span>
                      </div>
                    )}
                    {point.ownerValue !== null && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="w-2 h-2 rounded-full bg-orange-500 shrink-0" />
                        <span className="text-zinc-400">{ownerName}</span>
                        <span className="font-medium text-zinc-100 ml-auto">
                          {normalized && point.ownerPct !== null
                            ? fmtPct(point.ownerPct)
                            : fmtCurrencyCompact(point.ownerValue, currency)}
                        </span>
                      </div>
                    )}
                  </div>
                );
              }}
            />
            <Line
              type="monotone"
              dataKey={viewerKey}
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey={ownerKey}
              stroke="#f97316"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {/* Legend */}
      <div className="flex items-center justify-center gap-4 mt-2">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-0.5 rounded-full bg-blue-500" />
          <span className="text-[10px] text-zinc-500">{viewerName}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-0.5 rounded-full bg-orange-500" />
          <span className="text-[10px] text-zinc-500">{ownerName}</span>
        </div>
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
