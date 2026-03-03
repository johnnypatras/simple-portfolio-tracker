"use client";

import { useState, useRef, useEffect, useCallback } from "react";
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
  Droplet,
  Landmark,
  Zap,
  Flag,
} from "lucide-react";
import type { PortfolioSummary } from "@/lib/portfolio/aggregate";
import type { DashboardInsights } from "@/lib/portfolio/dashboard-insights";
import type { PortfolioSnapshot } from "@/lib/types";
import type { AssetClass, CashFlowEvent } from "@/lib/actions/benchmark";
import { fmtCurrency, fmtCurrencyCompact, fmtPct, fmtPctPlain, changeColorClass } from "@/lib/format";
import { useSharedView } from "@/components/shared-view-context";

// ─── Props ──────────────────────────────────────────────

interface DashboardGridProps {
  summary: PortfolioSummary;
  insights: DashboardInsights;
  pastSnapshots: Record<string, PortfolioSnapshot | null>;
  cashFlows: CashFlowEvent[];
}

// ─── Constants ──────────────────────────────────────────

const CHANGE_PERIODS = ["24h", "7d", "30d", "1y"] as const;
type ChangePeriod = (typeof CHANGE_PERIODS)[number];

const PERIOD_LABELS: Record<ChangePeriod, string> = { "24h": "24h", "7d": "7d", "30d": "30d", "1y": "1y" };

const APY_PERIODS = ["daily", "monthly", "yearly"] as const;
type ApyPeriod = (typeof APY_PERIODS)[number];

// Formatters imported from @/lib/format

const fmtIndex = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

type MarketFormat = "usd" | "index" | "yield" | "plain";

function MarketRow({ icon, label, price, change, format }: {
  icon: React.ReactNode;
  label: string;
  price: number;
  change: number;
  format: MarketFormat;
}) {
  if (price <= 0) return null;

  let priceStr: string;
  switch (format) {
    case "usd":
      priceStr = fmtCurrencyCompact(price, "USD", 1).replace(/\.0$/, "");
      break;
    case "index":
      priceStr = fmtIndex.format(price);
      break;
    case "yield":
      priceStr = `${price.toFixed(2)}%`;
      break;
    case "plain":
      priceStr = price.toFixed(2);
      break;
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5 flex-1">
        {icon}
        <span className="text-sm text-zinc-300">{label}</span>
      </div>
      <span className="text-sm font-medium text-zinc-100 tabular-nums w-[5.5rem] text-right">
        {priceStr}
      </span>
      <span className={`text-xs tabular-nums w-14 text-right ${changeColorClass(change)}`}>
        {fmtPct(change)}
      </span>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────

export function DashboardGrid({ summary, insights, pastSnapshots, cashFlows }: DashboardGridProps) {
  const [changePeriod, setChangePeriod] = useState<ChangePeriod>("24h");
  const [apyPeriod, setApyPeriod] = useState<ApyPeriod>("monthly");
  const [fxFlipped, setFxFlipped] = useState(false);
  const [exposureInBase, setExposureInBase] = useState(false);
  const [openTooltip, setOpenTooltip] = useState<string | null>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const { shareToken } = useSharedView();
  const basePath = shareToken ? `/share/${shareToken}` : "/dashboard";

  const toggleTooltip = useCallback((id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpenTooltip((prev) => (prev === id ? null : id));
  }, []);

  useEffect(() => {
    if (!openTooltip) return;
    const onPointerDown = (e: PointerEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target as Node)) {
        setOpenTooltip(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openTooltip]);

  const {
    totalValue,
    cryptoValue,
    stocksValue,
    cashValue,
    change24hPercent,
    fxChange24hPercent,
    allocation,
    primaryCurrency,
    cryptoValueUsd,
    cryptoValueEur,
    stocksValueUsd,
    stocksValueEur,
    cashValueUsd,
    cashValueEur,
    totalValueUsd,
    totalValueEur,
    totalValueChange24h,
    cryptoValueChange24h,
    stocksValueChange24h,
    fxValueChange24h,
    cryptoFxValueChange24h,
    cryptoFxChange24hPercent,
    stocksFxValueChange24h,
    stocksFxChange24hPercent,
    cashTotalValueChange24h,
    cashTotalFxValueChange24h,
    cashTotalFxChange24hPercent,
  } = summary;

  const cur = primaryCurrency;

  // Change computation for selected period
  const valueKey = cur === "EUR" ? "total_value_eur" : "total_value_usd";
  const otherKey = cur === "EUR" ? "total_value_usd" : "total_value_eur";
  const currentValueOther = cur === "EUR" ? totalValueUsd : totalValueEur;

  function getChangeForPeriod(period: ChangePeriod): {
    percent: number; valueChange: number; available: boolean;
    fxPercent: number; fxValueChange: number;
  } {
    if (period === "24h") {
      return {
        percent: change24hPercent,
        valueChange: totalValueChange24h,
        available: true,
        fxPercent: fxChange24hPercent,
        fxValueChange: fxValueChange24h,
      };
    }
    const snapshot = pastSnapshots[period];
    if (!snapshot) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };
    const pastValue = snapshot[valueKey] ?? 0;
    if (pastValue === 0) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };

    const primaryReturn = ((totalValue - pastValue) / pastValue) * 100;
    // FX impact = difference in returns between primary and other currency
    const pastOther = snapshot[otherKey] ?? 0;
    let fxPct = 0;
    if (pastOther > 0 && currentValueOther > 0) {
      const otherReturn = ((currentValueOther - pastOther) / pastOther) * 100;
      fxPct = primaryReturn - otherReturn;
    }
    const fxAbs = fxPct !== 0
      ? totalValue - totalValue / (1 + fxPct / 100)
      : 0;

    return {
      percent: primaryReturn,
      valueChange: totalValue - pastValue,
      available: true,
      fxPercent: fxPct,
      fxValueChange: fxAbs,
    };
  }

  // Return type for per-class change functions (extended with FX)
  type ClassChange = {
    percent: number; valueChange: number; available: boolean;
    fxPercent: number; fxValueChange: number;
  };

  // Derive per-class FX from snapshot dual-currency data for non-24h periods
  function deriveClassFx(
    currentClassValue: number,
    currentClassUsd: number,
    currentClassEur: number,
    pastClassUsd: number,
    snapshot: PortfolioSnapshot,
  ): { fxPct: number; fxAbs: number } {
    // Estimate past class EUR value using the portfolio's implied EUR/USD rate at snapshot time
    const snapTotalUsd = snapshot.total_value_usd ?? 0;
    const snapTotalEur = snapshot.total_value_eur ?? 0;
    if (snapTotalUsd === 0 || snapTotalEur === 0 || pastClassUsd === 0)
      return { fxPct: 0, fxAbs: 0 };

    const impliedRate = snapTotalEur / snapTotalUsd; // EUR per USD at snapshot time
    const pastClassEur = pastClassUsd * impliedRate;

    const usdReturn = ((currentClassUsd - pastClassUsd) / pastClassUsd) * 100;
    const eurReturn = ((currentClassEur - pastClassEur) / pastClassEur) * 100;

    // FX impact = primary currency return - other currency return
    const primaryReturn = cur === "EUR" ? eurReturn : usdReturn;
    const otherReturn = cur === "EUR" ? usdReturn : eurReturn;
    const fxPct = primaryReturn - otherReturn;
    const fxAbs = fxPct !== 0 ? currentClassValue - currentClassValue / (1 + fxPct / 100) : 0;
    return { fxPct, fxAbs };
  }

  // Per-asset-class change for selected period (uses USD snapshots, derives display-currency delta)
  function getCryptoChangeForPeriod(period: ChangePeriod): ClassChange {
    if (period === "24h") {
      return {
        percent: insights.cryptoChange24h,
        valueChange: cryptoValueChange24h,
        available: true,
        fxPercent: cryptoFxChange24hPercent,
        fxValueChange: cryptoFxValueChange24h,
      };
    }
    const snapshot = pastSnapshots[period];
    if (!snapshot) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };
    const pastUsd = snapshot.crypto_value_usd ?? 0;
    if (pastUsd === 0) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };
    const pct = ((cryptoValueUsd - pastUsd) / pastUsd) * 100;
    const delta = cryptoValue - cryptoValue / (1 + pct / 100);
    const { fxPct, fxAbs } = deriveClassFx(cryptoValue, cryptoValueUsd, cryptoValueEur, pastUsd, snapshot);
    return { percent: pct, valueChange: delta, available: true, fxPercent: fxPct, fxValueChange: fxAbs };
  }

  function getStockChangeForPeriod(period: ChangePeriod): ClassChange {
    if (period === "24h") {
      const pct = stocksValue > 0 ? (stocksValueChange24h / stocksValue) * 100 : 0;
      return {
        percent: pct, valueChange: stocksValueChange24h, available: true,
        fxPercent: stocksFxChange24hPercent, fxValueChange: stocksFxValueChange24h,
      };
    }
    const snapshot = pastSnapshots[period];
    if (!snapshot) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };
    const pastUsd = snapshot.stocks_value_usd ?? 0;
    if (pastUsd === 0) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };
    const pct = ((stocksValueUsd - pastUsd) / pastUsd) * 100;
    const delta = stocksValue - stocksValue / (1 + pct / 100);
    const { fxPct, fxAbs } = deriveClassFx(stocksValue, stocksValueUsd, stocksValueEur, pastUsd, snapshot);
    return { percent: pct, valueChange: delta, available: true, fxPercent: fxPct, fxValueChange: fxAbs };
  }

  function getCashChangeForPeriod(period: ChangePeriod): ClassChange {
    if (period === "24h") {
      const pct = cashValue > 0 ? (cashTotalValueChange24h / cashValue) * 100 : 0;
      return {
        percent: pct, valueChange: cashTotalValueChange24h, available: true,
        fxPercent: cashTotalFxChange24hPercent, fxValueChange: cashTotalFxValueChange24h,
      };
    }
    const snapshot = pastSnapshots[period];
    if (!snapshot) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };
    const pastUsd = snapshot.cash_value_usd ?? 0;
    if (pastUsd === 0) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };
    const pct = ((cashValueUsd - pastUsd) / pastUsd) * 100;
    const delta = cashValue - cashValue / (1 + pct / 100);
    const { fxPct, fxAbs } = deriveClassFx(cashValue, cashValueUsd, cashValueEur, pastUsd, snapshot);
    return { percent: pct, valueChange: delta, available: true, fxPercent: fxPct, fxValueChange: fxAbs };
  }

  // Deposit sums per period from cash flow events, optionally filtered by asset class
  // Returns total + per-entity breakdown for tooltip display
  function getDepositsForPeriod(period: ChangePeriod, filterClass?: AssetClass): {
    total: number;
    breakdown: { name: string; value: number }[];
  } {
    const now = new Date();
    const msMap: Record<ChangePeriod, number> = {
      "24h": 86400000, "7d": 7 * 86400000, "30d": 30 * 86400000, "1y": 365 * 86400000,
    };
    const cutoff = new Date(now.getTime() - msMap[period]);
    const filtered = cashFlows.filter(
      f => new Date(f.date) >= cutoff && (!filterClass || f.asset_class === filterClass)
    );
    const fxMul = cur === "USD" || totalValueUsd === 0 ? 1 : totalValue / totalValueUsd;
    const total = filtered.reduce((s, f) => s + f.amount_usd, 0) * fxMul;
    // Group by entity name
    const byName = new Map<string, number>();
    for (const f of filtered) {
      const name = f.entity_name || "Unknown";
      byName.set(name, (byName.get(name) ?? 0) + f.amount_usd * fxMul);
    }
    const breakdown = [...byName.entries()]
      .map(([name, value]) => ({ name, value }))
      .filter(e => Math.abs(e.value) >= 0.5)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    return { total, breakdown };
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
        <div className="md:col-span-2 bg-zinc-900 border border-zinc-800/50 rounded-xl p-3 sm:p-5">
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
            const dep = getDepositsForPeriod(changePeriod);
            return (
              <div className="flex items-baseline gap-3 mt-1 flex-nowrap">
                <p className="text-3xl sm:text-5xl font-bold text-zinc-100 tabular-nums">
                  {fmtCurrency(totalValue, cur, 0)}
                </p>
                {c.available && (
                  <span
                    ref={openTooltip === "total" ? tooltipRef : undefined}
                    onClick={(e) => toggleTooltip("total", e)}
                    className={`relative group/tip cursor-pointer text-sm font-medium tabular-nums whitespace-nowrap ${changeColorClass(c.percent)}`}
                  >
                    {c.valueChange !== 0 ? (
                      <>
                        {c.valueChange > 0 ? "+" : ""}{fmtCurrencyCompact(c.valueChange, cur)}
                        <span className="ml-1 font-normal">
                          ({fmtPct(c.percent)})
                        </span>
                      </>
                    ) : (
                      fmtPct(c.percent)
                    )}
                    <ChangeTooltip
                      valueChange={c.valueChange}
                      fxValueChange={c.fxValueChange}
                      deposits={dep.total}
                      depositBreakdown={dep.breakdown}
                      startValue={totalValue - c.valueChange}
                      cur={cur}
                      open={openTooltip === "total"}
                    />
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
              <p className="text-[11px] pl-6 sm:pl-[10rem] pb-1">
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
              <p className="text-[11px] pl-6 sm:pl-[10rem] pb-1">
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
              <p className="text-[11px] pl-6 sm:pl-[10rem] pb-1">
                {insights.cashCurrencyBreakdown.map((e, i) => (
                  <span key={e.currency}>
                    {i > 0 && <span className="text-zinc-600"> · </span>}
                    <span className="text-emerald-300">{e.currency} {fmtCurrencyCompact(e.value, cur)}</span>
                  </span>
                ))}
              </p>
            )}
          </div>

          {/* ── Currency exposure bars ── */}
          {insights.currencyExposure.length > 1 && (
            <div className="mt-4 pt-4 border-t border-zinc-800/50 space-y-1">
              <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Currency Exposure</span>
              {insights.currencyExposure.map((e) => {
                const textColor = CURRENCY_TEXT_COLORS[e.currency] ?? "text-zinc-400";
                const showBase = exposureInBase && e.currency !== cur;
                const displayCur = showBase ? cur : e.currency;
                const displayTotal = showBase ? e.value : e.nativeTotal;
                const cryptoVal = showBase ? e.cryptoValueBase : e.cryptoValue;
                const stocksVal = showBase ? e.stocksValueBase : e.stocksValue;
                const cashVal = showBase ? e.cashValueBase : e.cashValue;
                const parts: { label: string; value: number }[] = [];
                if (cryptoVal > 0.5) parts.push({ label: "Crypto", value: cryptoVal });
                if (stocksVal > 0.5) parts.push({ label: "Stocks", value: stocksVal });
                if (cashVal > 0.5) parts.push({ label: "Cash", value: cashVal });
                const altCur = showBase ? e.currency : cur;
                const altTotal = showBase ? e.nativeTotal : e.value;
                return (
                  <div key={e.currency}>
                    <AllocationBar
                      label={e.currency}
                      percent={e.percent}
                      color={CURRENCY_COLORS[e.currency] ?? "bg-zinc-500"}
                      value={displayTotal}
                      currency={displayCur}
                      valueTitle={e.currency !== cur ? fmtCurrencyCompact(altTotal, altCur) : undefined}
                      onValueClick={e.currency !== cur ? () => setExposureInBase((v) => !v) : undefined}
                    />
                    {parts.length > 1 && (
                      <p className="text-[11px] pl-6 sm:pl-[10rem] pb-1">
                        {parts.map((p, i) => (
                          <span key={p.label}>
                            {i > 0 && <span className="text-zinc-600"> · </span>}
                            <span className={textColor}>{p.label} {fmtCurrencyCompact(p.value, displayCur)}</span>
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Market */}
        <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-3 sm:p-5 flex flex-col">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-4 h-4 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
              Market
            </span>
          </div>

          <div className="flex-1 flex flex-col md:justify-between">
            {/* ── Crypto ─────────────────────────────── */}
            <div className="space-y-2 pb-3 md:pb-0">
              <MarketRow icon={<Bitcoin className="w-4 h-4 text-orange-400" />} label="BTC" price={insights.btcPriceUsd} change={insights.btcChange24h} format="usd" />
              <MarketRow icon={<svg className="w-4 h-4 text-indigo-400" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.5 4.5 12 12 16.5 19.5 12Zm0 21L4.5 13.5 12 18l7.5-4.5Z" /></svg>} label="ETH" price={insights.ethPriceUsd} change={insights.ethChange24h} format="usd" />
              <MarketRow icon={<svg className="w-4 h-4 text-purple-400" viewBox="0 0 24 24" fill="currentColor"><path d="M19.3 5H6.5L3.5 8h12.8l3-3Z"/><path d="M4.7 10.5h12.8l3 3H7.7l-3-3Z"/><path d="M19.3 16H6.5l-3 3h12.8l3-3Z"/></svg>} label="SOL" price={insights.solPriceUsd} change={insights.solChange24h} format="usd" />
            </div>

            {/* ── Indices ────────────────────────────── */}
            <div className="space-y-2 border-t border-zinc-800 pt-4 pb-3 md:pt-0 md:pb-0">
              <MarketRow icon={<TrendingUp className="w-4 h-4 text-blue-400" />} label="S&P 500" price={insights.sp500Price} change={insights.sp500Change24h} format="index" />
              <MarketRow icon={<BarChart2 className="w-4 h-4 text-cyan-400" />} label="Nasdaq" price={insights.nasdaqPrice} change={insights.nasdaqChange24h} format="index" />
              <MarketRow icon={<BarChart3 className="w-4 h-4 text-violet-400" />} label="Dow" price={insights.dowPrice} change={insights.dowChange24h} format="index" />
              <MarketRow icon={<Flag className="w-4 h-4 text-sky-400" />} label="Stoxx 50" price={insights.stoxx50Price} change={insights.stoxx50Change24h} format="index" />
            </div>

            {/* ── Commodities ─────────────────────────── */}
            <div className="space-y-2 border-t border-zinc-800 pt-4 pb-3 md:pt-0 md:pb-0">
              <MarketRow icon={<Coins className="w-4 h-4 text-yellow-400" />} label="Gold" price={insights.goldPriceUsd} change={insights.goldChange24h} format="usd" />
              <MarketRow icon={<Coins className="w-4 h-4 text-zinc-300" />} label="Silver" price={insights.silverPriceUsd} change={insights.silverChange24h} format="usd" />
              <MarketRow icon={<Droplet className="w-4 h-4 text-amber-600" />} label="Brent" price={insights.oilPriceUsd} change={insights.oilChange24h} format="usd" />
            </div>

            {/* ── Rates & Vol ─────────────────────────── */}
            <div className="space-y-2 border-t border-zinc-800 pt-4 pb-3 md:pt-0 md:pb-0">
              <MarketRow icon={<Landmark className="w-4 h-4 text-emerald-400" />} label="10Y UST" price={insights.treasury10yYield} change={insights.treasury10yChange24h} format="yield" />
              <MarketRow icon={<Zap className="w-4 h-4 text-red-400" />} label="VIX" price={insights.vixPrice} change={insights.vixChange24h} format="plain" />
            </div>

            {/* ── FX ──────────────────────────────────── */}
            <div className="border-t border-zinc-800 pt-4 md:pt-0">
              {insights.eurUsdRate > 0 && (
                <div
                  className="flex items-center gap-2 cursor-pointer select-none hover:bg-zinc-800/40 -mx-1 px-1 rounded transition-colors"
                  onClick={() => setFxFlipped((f) => !f)}
                >
                  <div className="flex items-center gap-1.5 flex-1">
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
                    <span className={`text-xs tabular-nums w-14 text-right ${changeColorClass(fxFlipped ? -insights.eurUsdChange24h : insights.eurUsdChange24h)}`}>
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

      </div>

      {/* ─── ROW 2: Crypto ────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Crypto Summary */}
        <Link
          href={`${basePath}/crypto`}
          className="block bg-zinc-900 border border-zinc-800/50 rounded-xl p-3 sm:p-5 hover:border-zinc-700 hover:bg-zinc-800/50 transition-colors"
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
          {(() => {
            const c = getCryptoChangeForPeriod(changePeriod);
            return (
              <div className="flex items-start justify-between mt-2">
                <div>
                  <div className="flex items-baseline gap-3">
                    <p className="text-3xl font-semibold text-zinc-100 tabular-nums">
                      {fmtCurrency(cryptoValue, cur, 0)}
                    </p>
                    {c.available ? (
                      <span
                        ref={openTooltip === "crypto" ? tooltipRef : undefined}
                        onClick={(e) => toggleTooltip("crypto", e)}
                        className={`relative group/tip cursor-pointer text-xs tabular-nums ${changeColorClass(c.percent)}`}
                      >
                        {c.valueChange !== 0 ? (
                          <>
                            {c.valueChange > 0 ? "+" : ""}{fmtCurrencyCompact(c.valueChange, cur)}
                            <span className="ml-1">({fmtPct(c.percent)})</span>
                          </>
                        ) : (
                          fmtPct(c.percent)
                        )}
                        {(() => {
                          const dep = getDepositsForPeriod(changePeriod, "crypto");
                          return (
                            <ChangeTooltip
                              valueChange={c.valueChange}
                              fxValueChange={c.fxValueChange}
                              deposits={dep.total}
                              depositBreakdown={dep.breakdown}
                              startValue={cryptoValue - c.valueChange}
                              cur={cur}
                              open={openTooltip === "crypto"}
                            />
                          );
                        })()}
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-600">—</span>
                    )}
                  </div>
                  {summary.stablecoinValue > 0 && (
                    <p className="text-[11px] text-zinc-500 mt-0.5 tabular-nums">
                      excl. {fmtCurrencyCompact(summary.stablecoinValue, cur)} stablecoins
                    </p>
                  )}
                </div>
                <div className="text-xs text-zinc-500 text-right space-y-0.5 shrink-0 ml-3 pt-2">
                  <p>{insights.cryptoAssetCount} asset{insights.cryptoAssetCount !== 1 ? "s" : ""}</p>
                  <p>{insights.cryptoPositionCount} position{insights.cryptoPositionCount !== 1 ? "s" : ""}</p>
                </div>
              </div>
            );
          })()}
        </Link>

        {/* Crypto Breakdown — spans 2 columns for wider bars */}
        <div className="md:col-span-2 bg-zinc-900 border border-zinc-800/50 rounded-xl p-3 sm:p-5">
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
                        <span className="w-14 shrink-0 hidden sm:block" />
                        <span className="w-14 shrink-0 hidden sm:block" />
                        <p className="text-[11px] flex-1 pl-6 sm:pl-0">
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
                        <span className="w-10 shrink-0 hidden sm:block" />
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
          href={`${basePath}/stocks`}
          className="block bg-zinc-900 border border-zinc-800/50 rounded-xl p-3 sm:p-5 hover:border-zinc-700 hover:bg-zinc-800/50 transition-colors"
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
          {(() => {
            const c = getStockChangeForPeriod(changePeriod);
            return (
              <div className="flex items-start justify-between mt-2">
                <div>
                  <div className="flex items-baseline gap-3">
                    <p className="text-3xl font-semibold text-zinc-100 tabular-nums">
                      {fmtCurrency(stocksValue, cur, 0)}
                    </p>
                    {c.available ? (
                      <span
                        ref={openTooltip === "equities" ? tooltipRef : undefined}
                        onClick={(e) => toggleTooltip("equities", e)}
                        className={`relative group/tip cursor-pointer text-xs tabular-nums ${changeColorClass(c.percent)}`}
                      >
                        {c.valueChange !== 0 ? (
                          <>
                            {c.valueChange > 0 ? "+" : ""}{fmtCurrencyCompact(c.valueChange, cur)}
                            <span className="ml-1">({fmtPct(c.percent)})</span>
                          </>
                        ) : (
                          fmtPct(c.percent)
                        )}
                        {(() => {
                          const dep = getDepositsForPeriod(changePeriod, "stocks");
                          return (
                            <ChangeTooltip
                              valueChange={c.valueChange}
                              fxValueChange={c.fxValueChange}
                              deposits={dep.total}
                              depositBreakdown={dep.breakdown}
                              startValue={stocksValue - c.valueChange}
                              cur={cur}
                              open={openTooltip === "equities"}
                            />
                          );
                        })()}
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-600">—</span>
                    )}
                  </div>
                  {insights.stocksWeightedYield > 0 && (() => {
                    const yearly = insights.stocksDividendIncomeYearly;
                    const periodIncome =
                      changePeriod === "24h" ? yearly / 365 :
                      changePeriod === "7d" ? yearly / 365 * 7 :
                      changePeriod === "30d" ? yearly / 12 :
                      yearly;
                    const periodLabel =
                      changePeriod === "24h" ? "/day" :
                      changePeriod === "7d" ? "/7d" :
                      changePeriod === "30d" ? "/mo" :
                      "/yr";
                    return (
                      <p className="text-[11px] text-emerald-400/80 mt-0.5 tabular-nums">
                        ~{insights.stocksWeightedYield.toFixed(2)}% yield{periodIncome > 0 && (
                          <> · +{fmtCurrencyCompact(periodIncome, cur, 2)}{periodLabel}</>
                        )}
                      </p>
                    );
                  })()}
                </div>
                <div className="text-xs text-zinc-500 text-right space-y-0.5 shrink-0 ml-3 pt-2">
                  <p>{insights.stockAssetCount} asset{insights.stockAssetCount !== 1 ? "s" : ""}</p>
                  <p>{insights.stockPositionCount} position{insights.stockPositionCount !== 1 ? "s" : ""}</p>
                </div>
              </div>
            );
          })()}
        </Link>

        {/* Breakdown — spans 2 columns for wider bars */}
        <div className="md:col-span-2 bg-zinc-900 border border-zinc-800/50 rounded-xl p-3 sm:p-5">
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
                        <span className="w-12 shrink-0 hidden sm:block" />
                        <span className="w-14 shrink-0 hidden sm:block" />
                        <p className="text-[11px] flex-1 pl-6 sm:pl-0">
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
                        <span className="w-10 shrink-0 hidden sm:block" />
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
          href={`${basePath}/cash`}
          className="block bg-zinc-900 border border-zinc-800/50 rounded-xl p-3 sm:p-5 hover:border-zinc-700 hover:bg-zinc-800/50 transition-colors"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Banknote className="w-4 h-4 text-zinc-500" />
              <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                Banks & Deposits
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
          {(() => {
            const c = getCashChangeForPeriod(changePeriod);
            return (
              <div className="flex items-start justify-between mt-2">
                <div>
                  <div className="flex items-baseline gap-3">
                    <p className="text-3xl font-semibold text-zinc-100 tabular-nums">
                      {fmtCurrency(cashValue, cur, 0)}
                    </p>
                    {c.available ? (
                      <span
                        ref={openTooltip === "cash" ? tooltipRef : undefined}
                        onClick={(e) => toggleTooltip("cash", e)}
                        className={`relative group/tip cursor-pointer text-xs tabular-nums ${changeColorClass(c.percent)}`}
                      >
                        {c.valueChange !== 0 ? (
                          <>
                            {c.valueChange > 0 ? "+" : ""}{fmtCurrencyCompact(c.valueChange, cur)}
                            <span className="ml-1">({fmtPct(c.percent)})</span>
                          </>
                        ) : (
                          fmtPct(c.percent)
                        )}
                        {(() => {
                          const dep = getDepositsForPeriod(changePeriod, "cash");
                          return (
                            <ChangeTooltip
                              valueChange={c.valueChange}
                              fxValueChange={c.fxValueChange}
                              deposits={dep.total}
                              depositBreakdown={dep.breakdown}
                              startValue={cashValue - c.valueChange}
                              cur={cur}
                              open={openTooltip === "cash"}
                            />
                          );
                        })()}
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-600">—</span>
                    )}
                  </div>
                  {insights.weightedAvgApy > 0 && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="text-xs tabular-nums text-emerald-500">
                        {insights.weightedAvgApy.toFixed(2)}% APY
                      </span>
                      <span className="text-[11px] text-emerald-500/70 tabular-nums">
                        · +{fmtCurrencyCompact(apyIncomeMap[apyPeriod], cur, 2)}/{apyPeriod === "daily" ? "day" : apyPeriod === "monthly" ? "mo" : "yr"}
                      </span>
                      <div className="flex gap-0.5 ml-auto">
                        {APY_PERIODS.map((p) => (
                          <button
                            key={p}
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setApyPeriod(p); }}
                            className={`px-1 py-0.5 text-[9px] rounded transition-colors ${
                              p === apyPeriod
                                ? "bg-emerald-600/30 text-emerald-400"
                                : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800"
                            }`}
                          >
                            {p === "daily" ? "day" : p === "monthly" ? "mo" : "yr"}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {summary.stablecoinValue > 0 && (
                    <p className="text-[11px] text-zinc-500 mt-0.5 tabular-nums">
                      incl. {fmtCurrencyCompact(summary.stablecoinValue, cur)} stablecoins
                    </p>
                  )}
                </div>
                <div className="text-xs text-zinc-500 text-right shrink-0 ml-3 pt-2">
                  <p>{insights.cashAccountCount} account{insights.cashAccountCount !== 1 ? "s" : ""}</p>
                </div>
              </div>
            );
          })()}
        </Link>

        {/* Currency Breakdown — spans 2 columns for wider bars */}
        <div className="md:col-span-2 bg-zinc-900 border border-zinc-800/50 rounded-xl p-3 sm:p-5">
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

// ─── Change Tooltip ─────────────────────────────────────

/** Single row inside the 3-column grid: label | value | pct */
function TooltipRow({
  label, value, cur, colored, bold, pct, indent,
}: {
  label: string; value: number; cur: string; colored?: boolean; bold?: boolean;
  pct?: number; indent?: boolean;
}) {
  const formatted = `${value > 0 ? "+" : ""}${fmtCurrencyCompact(value, cur)}`;
  const colorCls = colored ? changeColorClass(value) : indent ? "text-zinc-500" : "text-zinc-300";
  const hasPct = pct != null && isFinite(pct) && Math.abs(pct) >= 0.05;
  return (
    <>
      <span className={`${indent ? "pl-3 text-zinc-500" : "text-zinc-400"} ${bold ? "font-medium" : ""} whitespace-nowrap`}>{label}</span>
      <span className={`${colorCls} ${bold ? "font-medium" : ""} tabular-nums whitespace-nowrap text-right`}>{formatted}</span>
      <span className={`text-zinc-500 tabular-nums whitespace-nowrap ${bold ? "font-medium" : ""}`}>
        {hasPct ? `(${fmtPct(pct!)})` : ""}
      </span>
    </>
  );
}

function ChangeTooltip({
  valueChange, fxValueChange, deposits, depositBreakdown, startValue, cur, open,
}: {
  valueChange: number; fxValueChange: number; deposits: number;
  depositBreakdown?: { name: string; value: number }[];
  startValue?: number; cur: string; open?: boolean;
}) {
  const hasFx = Math.abs(fxValueChange) >= 0.5;
  const hasDeposits = Math.abs(deposits) >= 0.5;

  // Nothing to decompose — suppress tooltip
  if (!hasFx && !hasDeposits) return null;

  const assetPrices = valueChange - fxValueChange - deposits;
  const marketChange = valueChange - deposits; // prices + FX combined
  const fxLabel = cur === "EUR" ? "EUR/USD" : "USD/EUR";
  const base = startValue && startValue > 0 ? startValue : undefined;

  return (
    <div className={`absolute right-0 sm:right-auto sm:left-0 top-full mt-1 z-50 ${open ? "block" : "hidden group-hover/tip:block"}`}>
      <div className="bg-zinc-800/95 backdrop-blur border border-zinc-700 rounded-lg shadow-xl px-2.5 py-2 text-[10px] tabular-nums grid grid-cols-[auto_auto_auto] gap-x-2.5 gap-y-0.5 w-max max-w-[min(320px,calc(100vw-3rem))]">
        {/* Market row: price + FX performance, excluding deposits — only when deposits exist */}
        {hasDeposits && (
          <>
            <TooltipRow label="Market" value={marketChange} cur={cur} colored bold pct={base ? (marketChange / base) * 100 : undefined} />
            <div className="col-span-3 border-t border-zinc-700 mt-1 pt-1" />
          </>
        )}
        {/* Prices + FX decomposition — show Prices only when FX exists (otherwise Market = Prices) */}
        {(hasFx || !hasDeposits) && <TooltipRow label="Prices" value={assetPrices} cur={cur} colored pct={base ? (assetPrices / base) * 100 : undefined} />}
        {hasFx && <TooltipRow label={fxLabel} value={fxValueChange} cur={cur} colored pct={base ? (fxValueChange / base) * 100 : undefined} />}
        {hasDeposits && (
          <>
            <TooltipRow label={deposits > 0 ? "Deposits" : "Withdrawals"} value={deposits} cur={cur} pct={base ? (deposits / base) * 100 : undefined} />
            {depositBreakdown && depositBreakdown.length > 1 && depositBreakdown.map((e) => (
              <TooltipRow key={e.name} label={e.name} value={e.value} cur={cur} indent />
            ))}
          </>
        )}
        {/* Separator + Total row */}
        <div className="col-span-3 border-t border-zinc-700 mt-1 pt-1" />
        <TooltipRow label="Total" value={valueChange} cur={cur} colored bold pct={base ? (valueChange / base) * 100 : undefined} />
      </div>
    </div>
  );
}

// ─── Allocation bar ─────────────────────────────────────

function AllocationBar({
  label,
  percent,
  color,
  value,
  currency,
  valueTitle,
  onValueClick,
}: {
  label: string;
  percent: number;
  color: string;
  value?: number;
  currency?: string;
  valueTitle?: string;
  onValueClick?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-400 w-20 shrink-0 truncate">{label}</span>
      {value != null && currency && (
        <span
          className={`relative group/val text-xs text-zinc-300 tabular-nums w-16 text-right shrink-0 ${onValueClick ? "cursor-pointer select-none" : ""}`}
          onClick={onValueClick}
        >
          {fmtCurrencyCompact(value, currency)}
          {valueTitle && (
            <span className="absolute right-0 top-full mt-1 px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-[10px] text-zinc-300 whitespace-nowrap opacity-0 pointer-events-none group-hover/val:opacity-100 transition-opacity z-50">
              {valueTitle}
            </span>
          )}
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
