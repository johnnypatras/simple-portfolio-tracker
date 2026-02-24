"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Wallet,
  TrendingUp,
  Bitcoin,
  BarChart3,
  Banknote,
  PieChart,
  Activity,
  Layers,
  Coins,
  BarChart2,
} from "lucide-react";
import type { PortfolioSummary } from "@/lib/portfolio/aggregate";
import type { DashboardInsights, BreakdownEntry } from "@/lib/portfolio/dashboard-insights";
import type { PortfolioSnapshot } from "@/lib/types";

// ─── Props ──────────────────────────────────────────────

interface DashboardGridProps {
  summary: PortfolioSummary;
  insights: DashboardInsights;
  pastSnapshots: Record<string, PortfolioSnapshot | null>;
}

// ─── Constants ──────────────────────────────────────────

const CHANGE_PERIODS = ["24h", "7d", "30d", "1y"] as const;
type ChangePeriod = (typeof CHANGE_PERIODS)[number];

const PERIOD_LABELS: Record<ChangePeriod, string> = { "24h": "24h", "7d": "7d", "30d": "30d", "1y": "1y" };

const APY_PERIODS = ["daily", "monthly", "yearly"] as const;
type ApyPeriod = (typeof APY_PERIODS)[number];

// ─── Formatters ─────────────────────────────────────────

function fmtCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function fmtCurrencyCompact(value: number, currency: string): string {
  if (Math.abs(value) >= 1_000_000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: "compact",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
  }
  return fmtCurrency(value, currency);
}

function fmtPct(value: number, decimals = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}%`;
}

function fmtPctPlain(value: number, decimals = 0): string {
  return `${value.toFixed(decimals)}%`;
}

function changeColor(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-red-400";
  return "text-zinc-400";
}

// ─── Component ──────────────────────────────────────────

export function DashboardGrid({ summary, insights, pastSnapshots }: DashboardGridProps) {
  const [changePeriod, setChangePeriod] = useState<ChangePeriod>("24h");
  const [apyPeriod, setApyPeriod] = useState<ApyPeriod>("monthly");
  const [fxFlipped, setFxFlipped] = useState(false);

  const {
    totalValue,
    cryptoValue,
    stocksValue,
    cashValue,
    change24hPercent,
    allocation,
    primaryCurrency,
    cryptoValueUsd,
    stocksValueUsd,
  } = summary;

  const cur = primaryCurrency;

  // Change computation for selected period
  const valueKey = cur === "EUR" ? "total_value_eur" : "total_value_usd";

  function getChangeForPeriod(period: ChangePeriod): { percent: number; valueChange: number; available: boolean } {
    if (period === "24h") {
      const past = change24hPercent !== 0 ? totalValue / (1 + change24hPercent / 100) : totalValue;
      return { percent: change24hPercent, valueChange: totalValue - past, available: true };
    }
    const snapshot = pastSnapshots[period];
    if (!snapshot) return { percent: 0, valueChange: 0, available: false };
    const pastValue = snapshot[valueKey] ?? 0;
    if (pastValue === 0) return { percent: 0, valueChange: 0, available: false };
    return {
      percent: ((totalValue - pastValue) / pastValue) * 100,
      valueChange: totalValue - pastValue,
      available: true,
    };
  }

  // Per-asset-class change for selected period (uses USD snapshots, derives display-currency delta)
  function getCryptoChangeForPeriod(period: ChangePeriod): { percent: number; valueChange: number; available: boolean } {
    if (period === "24h") {
      if (insights.cryptoChange24h === 0) return { percent: 0, valueChange: 0, available: true };
      const delta = cryptoValue - cryptoValue / (1 + insights.cryptoChange24h / 100);
      return { percent: insights.cryptoChange24h, valueChange: delta, available: true };
    }
    const snapshot = pastSnapshots[period];
    if (!snapshot) return { percent: 0, valueChange: 0, available: false };
    const pastUsd = snapshot.crypto_value_usd ?? 0;
    if (pastUsd === 0) return { percent: 0, valueChange: 0, available: false };
    const pct = ((cryptoValueUsd - pastUsd) / pastUsd) * 100;
    const delta = cryptoValue - cryptoValue / (1 + pct / 100);
    return { percent: pct, valueChange: delta, available: true };
  }

  function getStockChangeForPeriod(period: ChangePeriod): { percent: number; valueChange: number; available: boolean } {
    if (period === "24h") {
      if (insights.stockChange24h === 0) return { percent: 0, valueChange: 0, available: true };
      const delta = stocksValue - stocksValue / (1 + insights.stockChange24h / 100);
      return { percent: insights.stockChange24h, valueChange: delta, available: true };
    }
    const snapshot = pastSnapshots[period];
    if (!snapshot) return { percent: 0, valueChange: 0, available: false };
    const pastUsd = snapshot.stocks_value_usd ?? 0;
    if (pastUsd === 0) return { percent: 0, valueChange: 0, available: false };
    const pct = ((stocksValueUsd - pastUsd) / pastUsd) * 100;
    const delta = stocksValue - stocksValue / (1 + pct / 100);
    return { percent: pct, valueChange: delta, available: true };
  }

  // APY income for selected period
  const apyIncomeMap = {
    daily: insights.apyIncomeDaily,
    monthly: insights.apyIncomeMonthly,
    yearly: insights.apyIncomeYearly,
  };

  return (
    <div className="space-y-4">
      {/* ─── ROW 1: Overview ──────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Portfolio Overview (merged Total + Allocation) */}
        <div className="md:col-span-2 bg-zinc-900 border border-zinc-800/50 rounded-xl p-5">
          {/* ── Header row: title + period toggle ── */}
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Wallet className="w-4 h-4 text-zinc-500" />
              <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                Portfolio
              </span>
            </div>
            <div className="flex gap-0.5">
              {CHANGE_PERIODS.map((p) => (
                <button
                  key={p}
                  onClick={() => setChangePeriod(p)}
                  className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                    p === changePeriod
                      ? "bg-zinc-700 text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                  }`}
                >
                  {PERIOD_LABELS[p]}
                </button>
              ))}
            </div>
          </div>

          {/* ── Total value + change ── */}
          {(() => {
            const c = getChangeForPeriod(changePeriod);
            return (
              <div className="flex items-baseline gap-3 mt-1">
                <p className="text-4xl font-bold text-zinc-100 tabular-nums">
                  {fmtCurrency(totalValue, cur)}
                </p>
                {c.available && (
                  <span className={`text-sm font-medium tabular-nums ${changeColor(c.percent)}`}>
                    {fmtPct(c.percent)}
                    {c.valueChange !== 0 && (
                      <span className="ml-1 font-normal">
                        ({c.valueChange > 0 ? "+" : ""}{fmtCurrencyCompact(c.valueChange, cur)})
                      </span>
                    )}
                  </span>
                )}
                {!c.available && (
                  <span className="text-sm text-zinc-600">—</span>
                )}
              </div>
            );
          })()}

          {/* ── Allocation bars ── */}
          <div className="mt-4 pt-4 border-t border-zinc-800/50 space-y-1">
            {/* Crypto */}
            <AllocationBar label="Crypto" percent={allocation.crypto} color="bg-orange-500" value={cryptoValue} currency={cur} />
            {cryptoValue > 0 && (
              <p className="text-[11px] pl-[10rem] pb-1">
                <span className="text-orange-300">BTC {fmtCurrencyCompact(insights.btcValueInBase, cur)}</span>
                {cryptoValue - insights.btcValueInBase > 0 && (
                  <>
                    <span className="text-zinc-600"> · </span>
                    <span className="text-amber-300">Alts {fmtCurrencyCompact(cryptoValue - insights.btcValueInBase, cur)}</span>
                  </>
                )}
              </p>
            )}

            {/* Stocks */}
            <AllocationBar label="Stocks" percent={allocation.stocks} color="bg-blue-500" value={stocksValue} currency={cur} />
            {stocksValue > 0 && insights.equitiesBreakdown.length > 0 && (
              <p className="text-[11px] pl-[10rem] pb-1">
                {insights.equitiesBreakdown.map((e, i) => (
                  <span key={e.label}>
                    {i > 0 && <span className="text-zinc-600"> · </span>}
                    <span className="text-blue-300">{e.label} {fmtCurrencyCompact(e.value, cur)}</span>
                  </span>
                ))}
              </p>
            )}

            {/* Cash */}
            <AllocationBar label="Cash" percent={allocation.cash} color="bg-emerald-500" value={cashValue} currency={cur} />
            {cashValue > 0 && insights.cashCurrencyBreakdown.length > 0 && (
              <p className="text-[11px] pl-[10rem] pb-1">
                {insights.cashCurrencyBreakdown.map((e, i) => (
                  <span key={e.currency}>
                    {i > 0 && <span className="text-zinc-600"> · </span>}
                    <span className="text-emerald-300">{e.currency} {fmtCurrencyCompact(e.value, cur)}</span>
                  </span>
                ))}
              </p>
            )}
          </div>
        </div>

        {/* Market Indices */}
        <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-4 h-4 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
              Market
            </span>
          </div>
          <div className="space-y-2.5 mt-2">
            {/* BTC */}
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-2 flex-1">
                <Bitcoin className="w-4 h-4 text-orange-400" />
                <span className="text-sm text-zinc-300">BTC</span>
              </div>
              <span className="text-sm font-medium text-zinc-100 tabular-nums w-[5.5rem] text-right">
                {fmtCurrencyCompact(insights.btcPriceUsd, "USD")}
              </span>
              <span className={`text-xs tabular-nums w-14 text-right ${changeColor(insights.btcChange24h)}`}>
                {fmtPct(insights.btcChange24h)}
              </span>
            </div>
            {/* ETH */}
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-2 flex-1">
                <svg className="w-4 h-4 text-indigo-400" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 1.5 4.5 12 12 16.5 19.5 12Zm0 21L4.5 13.5 12 18l7.5-4.5Z" />
                </svg>
                <span className="text-sm text-zinc-300">ETH</span>
              </div>
              <span className="text-sm font-medium text-zinc-100 tabular-nums w-[5.5rem] text-right">
                {fmtCurrencyCompact(insights.ethPriceUsd, "USD")}
              </span>
              <span className={`text-xs tabular-nums w-14 text-right ${changeColor(insights.ethChange24h)}`}>
                {fmtPct(insights.ethChange24h)}
              </span>
            </div>
            {/* Gold */}
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-2 flex-1">
                <Coins className="w-4 h-4 text-yellow-400" />
                <span className="text-sm text-zinc-300">Gold</span>
              </div>
              <span className="text-sm font-medium text-zinc-100 tabular-nums w-[5.5rem] text-right">
                {insights.goldPriceUsd > 0 ? fmtCurrencyCompact(insights.goldPriceUsd, "USD") : "—"}
              </span>
              <span className={`text-xs tabular-nums w-14 text-right ${insights.goldPriceUsd > 0 ? changeColor(insights.goldChange24h) : ""}`}>
                {insights.goldPriceUsd > 0 ? fmtPct(insights.goldChange24h) : ""}
              </span>
            </div>
            {/* S&P 500 */}
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-2 flex-1">
                <TrendingUp className="w-4 h-4 text-blue-400" />
                <span className="text-sm text-zinc-300">S&P 500</span>
              </div>
              <span className="text-sm font-medium text-zinc-100 tabular-nums w-[5.5rem] text-right">
                {insights.sp500Price > 0
                  ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(insights.sp500Price)
                  : "—"}
              </span>
              <span className={`text-xs tabular-nums w-14 text-right ${insights.sp500Price > 0 ? changeColor(insights.sp500Change24h) : ""}`}>
                {insights.sp500Price > 0 ? fmtPct(insights.sp500Change24h) : ""}
              </span>
            </div>
            {/* Nasdaq */}
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-2 flex-1">
                <BarChart2 className="w-4 h-4 text-cyan-400" />
                <span className="text-sm text-zinc-300">Nasdaq</span>
              </div>
              <span className="text-sm font-medium text-zinc-100 tabular-nums w-[5.5rem] text-right">
                {insights.nasdaqPrice > 0
                  ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(insights.nasdaqPrice)
                  : "—"}
              </span>
              <span className={`text-xs tabular-nums w-14 text-right ${insights.nasdaqPrice > 0 ? changeColor(insights.nasdaqChange24h) : ""}`}>
                {insights.nasdaqPrice > 0 ? fmtPct(insights.nasdaqChange24h) : ""}
              </span>
            </div>
            {/* Dow Jones */}
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-2 flex-1">
                <BarChart3 className="w-4 h-4 text-violet-400" />
                <span className="text-sm text-zinc-300">Dow</span>
              </div>
              <span className="text-sm font-medium text-zinc-100 tabular-nums w-[5.5rem] text-right">
                {insights.dowPrice > 0
                  ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(insights.dowPrice)
                  : "—"}
              </span>
              <span className={`text-xs tabular-nums w-14 text-right ${insights.dowPrice > 0 ? changeColor(insights.dowChange24h) : ""}`}>
                {insights.dowPrice > 0 ? fmtPct(insights.dowChange24h) : ""}
              </span>
            </div>
            {/* EUR/USD — click to flip */}
            {insights.eurUsdRate > 0 && (
              <div
                className="flex items-center gap-1.5 cursor-pointer select-none hover:bg-zinc-800/40 -mx-1 px-1 rounded transition-colors"
                onClick={() => setFxFlipped((f) => !f)}
              >
                <div className="flex items-center gap-2 flex-1">
                  <Banknote className="w-4 h-4 text-emerald-400" />
                  <span className="text-sm text-zinc-300">
                    {fxFlipped ? "USD/EUR" : "EUR/USD"}
                  </span>
                </div>
                <span className="text-sm font-medium text-zinc-100 tabular-nums w-[5.5rem] text-right">
                  {fxFlipped
                    ? (1 / insights.eurUsdRate).toFixed(4)
                    : insights.eurUsdRate.toFixed(4)}
                </span>
                {insights.eurUsdChange24h !== 0 ? (
                  <span className={`text-xs tabular-nums w-14 text-right ${changeColor(fxFlipped ? -insights.eurUsdChange24h : insights.eurUsdChange24h)}`}>
                    {fmtPct(fxFlipped ? -insights.eurUsdChange24h : insights.eurUsdChange24h)}
                  </span>
                ) : (
                  <span className="w-14" />
                )}
              </div>
            )}
          </div>
        </div>

      </div>

      {/* ─── ROW 2: Crypto ────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Crypto Summary */}
        <Link
          href="/dashboard/crypto"
          className="block bg-zinc-900 border border-zinc-800/50 rounded-xl p-5 hover:border-zinc-700 hover:bg-zinc-800/50 transition-colors"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Bitcoin className="w-4 h-4 text-zinc-500" />
              <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                Crypto
              </span>
            </div>
            <div className="flex gap-0.5">
              {CHANGE_PERIODS.map((p) => (
                <button
                  key={p}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setChangePeriod(p); }}
                  className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                    p === changePeriod
                      ? "bg-zinc-700 text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                  }`}
                >
                  {PERIOD_LABELS[p]}
                </button>
              ))}
            </div>
          </div>
          <p className="text-2xl font-semibold text-zinc-100 tabular-nums mt-2">
            {fmtCurrency(cryptoValue, cur)}
          </p>
          {(() => {
            const c = getCryptoChangeForPeriod(changePeriod);
            return (
              <div className="flex items-center gap-2 mt-1">
                {c.available ? (
                  <>
                    <span className={`text-xs tabular-nums ${changeColor(c.percent)}`}>
                      {fmtPct(c.percent)}
                    </span>
                    {c.valueChange !== 0 && (
                      <span className={`text-xs tabular-nums ${changeColor(c.percent)}`}>
                        ({c.valueChange > 0 ? "+" : ""}{fmtCurrencyCompact(c.valueChange, cur)})
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-xs text-zinc-600">—</span>
                )}
                <span className="text-xs text-zinc-600">
                  {PERIOD_LABELS[changePeriod]} · {insights.cryptoAssetCount} asset{insights.cryptoAssetCount !== 1 ? "s" : ""}
                </span>
              </div>
            );
          })()}
          <p className="text-xs text-zinc-600 mt-1">
            {insights.btcDominancePercent > 0 && (
              <span>BTC dom. {fmtPctPlain(insights.btcDominancePercent, 1)}</span>
            )}
            {insights.btcDominancePercent > 0 && insights.minedStakedPercent > 0 && (
              <span> · </span>
            )}
            {insights.minedStakedPercent > 0 && (
              <span>{fmtPctPlain(insights.minedStakedPercent, 1)} mined/staked</span>
            )}
          </p>
          {summary.stablecoinValue > 0 && (
            <p className="text-xs text-zinc-600 mt-0.5">
              excl. {fmtCurrencyCompact(summary.stablecoinValue, cur)} stablecoins
            </p>
          )}
        </Link>

        {/* Crypto Breakdown — spans 2 columns for wider bars */}
        <div className="md:col-span-2 bg-zinc-900 border border-zinc-800/50 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <PieChart className="w-4 h-4 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
              Crypto Breakdown
            </span>
          </div>
          <div className="space-y-3 mt-3">
            {insights.cryptoBreakdown.length > 0 ? (
              insights.cryptoBreakdown.map((entry) => {
                const hasSegments = entry.subtypes && entry.subtypes.length > 1;
                const segments = hasSegments ? entry.subtypes! : null;
                return (
                  <div key={entry.label}>
                    {/* Label + bar + percent */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-400 w-14 shrink-0 truncate">
                        {entry.label}
                      </span>
                      <span className="text-xs text-zinc-300 tabular-nums w-14 text-right shrink-0">
                        {fmtCurrencyCompact(entry.value, cur)}
                      </span>
                      <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden flex">
                        {segments ? (
                          segments.map((seg, i) => {
                            const segPct = entry.value > 0 ? (seg.value / entry.value) * 100 : 0;
                            return (
                              <div
                                key={seg.label}
                                className={`h-full ${segmentColor(entry.color, i)}`}
                                style={{ width: `${Math.max(segPct, 0.5)}%` }}
                              />
                            );
                          })
                        ) : (
                          <div
                            className={`h-full ${entry.color}`}
                            style={{ width: "100%" }}
                          />
                        )}
                      </div>
                      <span className="text-xs text-zinc-400 tabular-nums w-10 text-right">
                        {fmtPctPlain(entry.percent)}
                      </span>
                    </div>
                    {/* Sub-line: individual alts with colored labels */}
                    {segments && (
                      <div className="flex gap-2 mt-0.5">
                        <span className="w-14 shrink-0" />
                        <span className="w-14 shrink-0" />
                        <p className="text-[11px] flex-1">
                          {segments.map((s, i) => {
                            const pctWithin = entry.value > 0 ? (s.value / entry.value) * 100 : 0;
                            return (
                              <span key={s.label}>
                                {i > 0 && <span className="text-zinc-600"> · </span>}
                                <span className={`whitespace-nowrap ${barTextColor(segmentColor(entry.color, i))}`}>
                                  {s.label} {fmtCurrencyCompact(s.value, cur)} ({Math.round(pctWithin)}%)
                                </span>
                              </span>
                            );
                          })}
                        </p>
                        <span className="w-10 shrink-0" />
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <p className="text-xs text-zinc-600">No crypto holdings yet</p>
            )}
          </div>
        </div>
      </div>

      {/* ─── ROW 3: Equities ──────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Equities Summary */}
        <Link
          href="/dashboard/stocks"
          className="block bg-zinc-900 border border-zinc-800/50 rounded-xl p-5 hover:border-zinc-700 hover:bg-zinc-800/50 transition-colors"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-zinc-500" />
              <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                Equities
              </span>
            </div>
            <div className="flex gap-0.5">
              {CHANGE_PERIODS.map((p) => (
                <button
                  key={p}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setChangePeriod(p); }}
                  className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                    p === changePeriod
                      ? "bg-zinc-700 text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                  }`}
                >
                  {PERIOD_LABELS[p]}
                </button>
              ))}
            </div>
          </div>
          <p className="text-2xl font-semibold text-zinc-100 tabular-nums mt-2">
            {fmtCurrency(stocksValue, cur)}
          </p>
          {(() => {
            const c = getStockChangeForPeriod(changePeriod);
            return (
              <div className="flex items-center gap-2 mt-1">
                {c.available ? (
                  <>
                    <span className={`text-xs tabular-nums ${changeColor(c.percent)}`}>
                      {fmtPct(c.percent)}
                    </span>
                    {c.valueChange !== 0 && (
                      <span className={`text-xs tabular-nums ${changeColor(c.percent)}`}>
                        ({c.valueChange > 0 ? "+" : ""}{fmtCurrencyCompact(c.valueChange, cur)})
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-xs text-zinc-600">—</span>
                )}
                <span className="text-xs text-zinc-600">
                  {PERIOD_LABELS[changePeriod]} · {insights.stockPositionCount} position{insights.stockPositionCount !== 1 ? "s" : ""}
                </span>
              </div>
            );
          })()}
        </Link>

        {/* Breakdown — spans 2 columns for wider bars */}
        <div className="md:col-span-2 bg-zinc-900 border border-zinc-800/50 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <Layers className="w-4 h-4 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
              Breakdown
            </span>
          </div>
          <div className="space-y-3 mt-3">
            {insights.equitiesBreakdown.length > 0 ? (
              insights.equitiesBreakdown.map((entry) => {
                const hasSubtypeSegments = entry.subtypes && entry.subtypes.length > 1;
                const hasTagSegments = !hasSubtypeSegments && entry.tagBreakdown && entry.tagBreakdown.length > 1;
                // Pick whichever provides a useful segment split for the bar
                const segments: { label: string; value: number }[] | null =
                  hasSubtypeSegments ? entry.subtypes! :
                  hasTagSegments ? entry.tagBreakdown! :
                  null;
                return (
                  <div key={entry.label}>
                    {/* Label + full-width bar + percent of all equities */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-400 w-12 shrink-0 truncate">
                        {entry.label}
                      </span>
                      <span className="text-xs text-zinc-300 tabular-nums w-14 text-right shrink-0">
                        {fmtCurrencyCompact(entry.value, cur)}
                      </span>
                      <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden flex">
                        {segments ? (
                          segments.map((seg, i) => {
                            const segPct = entry.value > 0 ? (seg.value / entry.value) * 100 : 0;
                            return (
                              <div
                                key={seg.label}
                                className={`h-full ${segmentColor(entry.color, i)}`}
                                style={{ width: `${Math.max(segPct, 0.5)}%` }}
                              />
                            );
                          })
                        ) : (
                          <div
                            className={`h-full ${entry.color}`}
                            style={{ width: "100%" }}
                          />
                        )}
                      </div>
                      <span className="text-xs text-zinc-400 tabular-nums w-10 text-right">
                        {fmtPctPlain(entry.percent)}
                      </span>
                    </div>
                    {/* Sub-line: colored labels matching bar segments, aligned with bar start */}
                    {segments && (
                      <div className="flex gap-2 mt-0.5">
                        <span className="w-12 shrink-0" />
                        <span className="w-14 shrink-0" />
                        <p className="text-[11px] flex-1">
                          {segments.map((s, i) => {
                            const pctWithin = entry.value > 0 ? (s.value / entry.value) * 100 : 0;
                            return (
                              <span key={s.label}>
                                {i > 0 && <span className="text-zinc-600"> · </span>}
                                <span className={`whitespace-nowrap ${barTextColor(segmentColor(entry.color, i))}`}>
                                  {s.label} {fmtCurrencyCompact(s.value, cur)} ({Math.round(pctWithin)}%)
                                </span>
                              </span>
                            );
                          })}
                        </p>
                        <span className="w-10 shrink-0" />
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <>
                <AllocationBar label="ETFs" percent={0} color="bg-blue-500" />
                <AllocationBar label="Stocks" percent={0} color="bg-violet-500" />
                <AllocationBar label="Bonds" percent={0} color="bg-amber-500" />
              </>
            )}
          </div>
        </div>

      </div>

      {/* ─── ROW 4: Cash ──────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Cash Summary (with APY income integrated) */}
        <Link
          href="/dashboard/cash"
          className="block bg-zinc-900 border border-zinc-800/50 rounded-xl p-5 hover:border-zinc-700 hover:bg-zinc-800/50 transition-colors"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Banknote className="w-4 h-4 text-zinc-500" />
              <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                Banks & Deposits
              </span>
            </div>
            {insights.weightedAvgApy > 0 && (
              <div className="flex gap-0.5">
                {APY_PERIODS.map((p) => (
                  <button
                    key={p}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setApyPeriod(p); }}
                    className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                      p === apyPeriod
                        ? "bg-emerald-600 text-white"
                        : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                    }`}
                  >
                    {p === "daily" ? "day" : p === "monthly" ? "mo" : "yr"}
                  </button>
                ))}
              </div>
            )}
          </div>
          <p className="text-2xl font-semibold text-zinc-100 tabular-nums mt-2">
            {fmtCurrency(cashValue, cur)}
          </p>
          <div className="flex items-center gap-2 mt-1">
            {insights.weightedAvgApy > 0 && (
              <span className="text-xs tabular-nums text-emerald-500">
                {insights.weightedAvgApy.toFixed(2)}% APY
              </span>
            )}
            <span className="text-xs text-zinc-600">
              {insights.cashAccountCount} account{insights.cashAccountCount !== 1 ? "s" : ""}
            </span>
          </div>
          {insights.weightedAvgApy > 0 && (
            <p className="text-xs text-emerald-500/80 mt-1 tabular-nums">
              +{fmtCurrencyCompact(apyIncomeMap[apyPeriod], cur)}/{apyPeriod === "daily" ? "day" : apyPeriod === "monthly" ? "mo" : "yr"} projected
            </p>
          )}
          {summary.stablecoinValue > 0 && (
            <p className="text-xs text-zinc-600 mt-0.5">
              incl. {fmtCurrencyCompact(summary.stablecoinValue, cur)} stablecoins
            </p>
          )}
        </Link>

        {/* Currency Breakdown — spans 2 columns for wider bars */}
        <div className="md:col-span-2 bg-zinc-900 border border-zinc-800/50 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <PieChart className="w-4 h-4 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
              Cash Currencies
            </span>
          </div>
          <div className="mt-3 space-y-3">
            {insights.cashCurrencyBreakdown.map((entry) => {
              const fiatPct = entry.value > 0 ? (entry.fiatValue / entry.value) * 100 : 100;
              const stablePct = entry.value > 0 ? (entry.stablecoinValue / entry.value) * 100 : 0;
              return (
                <div key={entry.currency}>
                  {/* Label + segmented bar + percent */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-400 w-10 shrink-0">
                      {entry.currency}
                    </span>
                    <span className="text-xs text-zinc-300 tabular-nums w-14 text-right shrink-0">
                      {fmtCurrencyCompact(entry.value, cur)}
                    </span>
                    <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden flex">
                      {entry.fiatValue > 0 && (
                        <div
                          className={`h-full ${currencyColor(entry.currency)}`}
                          style={{ width: `${Math.max(fiatPct, 0.5)}%` }}
                        />
                      )}
                      {entry.stablecoinValue > 0 && (
                        <div
                          className="h-full bg-emerald-500"
                          style={{ width: `${Math.max(stablePct, 0.5)}%` }}
                        />
                      )}
                    </div>
                    <span className="text-xs text-zinc-400 tabular-nums w-10 text-right">
                      {fmtPctPlain(entry.percent)}
                    </span>
                  </div>
                  {/* Sub-line: FIAT value (%) · Stablecoins value (%), aligned with bar start */}
                  <div className="flex gap-2 mt-0.5">
                    <span className="w-10 shrink-0" />
                    <span className="w-14 shrink-0" />
                    <p className="text-[11px] flex-1">
                      {entry.fiatValue > 0 && (
                        <span className={`whitespace-nowrap ${currencyTextColor(entry.currency)}`}>
                          FIAT {fmtCurrencyCompact(entry.fiatValue, cur)} ({Math.round(fiatPct)}%)
                        </span>
                      )}
                      {entry.fiatValue > 0 && entry.stablecoinValue > 0 && (
                        <span className="text-zinc-600"> · </span>
                      )}
                      {entry.stablecoinValue > 0 && (
                        <span className="whitespace-nowrap text-emerald-400">
                          Stablecoins {fmtCurrencyCompact(entry.stablecoinValue, cur)} ({Math.round(stablePct)}%)
                        </span>
                      )}
                    </p>
                    <span className="w-10 shrink-0" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>

    </div>
  );
}

// ─── Currency color mapping ─────────────────────────────

const CURRENCY_COLORS: Record<string, string> = {
  USD: "bg-blue-500",
  EUR: "bg-amber-500",
  GBP: "bg-violet-500",
  CHF: "bg-red-500",
  Stablecoins: "bg-emerald-500",
};

const CURRENCY_TEXT_COLORS: Record<string, string> = {
  USD: "text-blue-400",
  EUR: "text-amber-400",
  GBP: "text-violet-400",
  CHF: "text-red-400",
  Stablecoins: "text-emerald-400",
};

function currencyColor(currency: string): string {
  return CURRENCY_COLORS[currency] ?? "bg-zinc-500";
}

function currencyTextColor(currency: string): string {
  return CURRENCY_TEXT_COLORS[currency] ?? "text-zinc-400";
}

/** Convert a bg-* bar color to a readable text-* for sub-labels */
const BG_TO_TEXT: Record<string, string> = {
  "bg-blue-500": "text-blue-400",
  "bg-emerald-400": "text-emerald-300",
  "bg-amber-400": "text-amber-300",
  "bg-rose-400": "text-rose-300",
  "bg-violet-500": "text-violet-400",
  "bg-teal-400": "text-teal-300",
  "bg-orange-400": "text-orange-300",
  "bg-sky-400": "text-sky-300",
  "bg-amber-500": "text-amber-400",
  "bg-blue-400": "text-blue-300",
  "bg-zinc-500": "text-zinc-400",
  "bg-zinc-400": "text-zinc-300",
  "bg-emerald-500": "text-emerald-400",
  "bg-orange-500": "text-orange-400",
  "bg-red-500": "text-red-400",
  "bg-indigo-500": "text-indigo-400",
  "bg-cyan-400": "text-cyan-300",
  "bg-pink-400": "text-pink-300",
  "bg-lime-400": "text-lime-300",
};

function barTextColor(bgColor: string): string {
  return BG_TO_TEXT[bgColor] ?? "text-zinc-400";
}

/**
 * Segment palettes — each segment is a COMPLETELY DIFFERENT color family
 * for clear visual separation (like cash: blue FIAT vs green Stablecoins).
 */
const SEGMENT_SHADES: Record<string, string[]> = {
  "bg-blue-500":   ["bg-blue-500", "bg-emerald-400", "bg-amber-400", "bg-rose-400"],
  "bg-violet-500": ["bg-violet-500", "bg-teal-400", "bg-orange-400", "bg-sky-400"],
  "bg-amber-500":  ["bg-amber-500", "bg-blue-400", "bg-emerald-400"],
  "bg-zinc-500":   ["bg-zinc-500", "bg-zinc-400"],
  "bg-indigo-500": ["bg-indigo-500", "bg-cyan-400", "bg-pink-400", "bg-lime-400", "bg-amber-400", "bg-sky-400"],
};

function segmentColor(parentColor: string, index: number): string {
  const shades = SEGMENT_SHADES[parentColor] ?? [parentColor];
  return shades[index % shades.length];
}

// ─── Allocation bar ─────────────────────────────────────

function AllocationBar({
  label,
  percent,
  color,
  value,
  currency,
}: {
  label: string;
  percent: number;
  color: string;
  value?: number;
  currency?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-400 w-20 shrink-0 truncate">{label}</span>
      {value != null && currency && (
        <span className="text-xs text-zinc-300 tabular-nums w-16 text-right shrink-0">
          {fmtCurrencyCompact(value, currency)}
        </span>
      )}
      <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${Math.max(percent, 0.5)}%` }}
        />
      </div>
      <span className="text-xs text-zinc-400 tabular-nums w-10 text-right">
        {fmtPctPlain(percent)}
      </span>
    </div>
  );
}
