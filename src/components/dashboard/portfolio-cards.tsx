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
} from "lucide-react";
import { PERIOD_LABELS } from "@/lib/constants";
import type { PortfolioSummary } from "@/lib/portfolio/aggregate";
import type { PortfolioSnapshot } from "@/lib/types";

interface PortfolioCardsProps {
  summary: PortfolioSummary;
  pastSnapshots: Record<string, PortfolioSnapshot | null>;
  // keyed by period label, e.g. { "24h": snapshot, "7d": snapshot, ... }
}

const CHANGE_PERIODS = ["24h", "7d", "30d", "1y"] as const;
type ChangePeriod = (typeof CHANGE_PERIODS)[number];

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export function PortfolioCards({ summary, pastSnapshots }: PortfolioCardsProps) {
  const [changePeriod, setChangePeriod] = useState<ChangePeriod>("24h");

  const {
    totalValue,
    cryptoValue,
    stocksValue,
    cashValue,
    stablecoinValue,
    change24hPercent,
    allocation,
    primaryCurrency,
  } = summary;

  // Compute change % based on selected period
  const valueKey =
    primaryCurrency === "EUR" ? "total_value_eur" : "total_value_usd";

  function getChangeForPeriod(period: ChangePeriod): {
    percent: number;
    available: boolean;
  } {
    // For 24h, use the real-time API-based change (more accurate than daily snapshots)
    if (period === "24h") {
      return { percent: change24hPercent, available: true };
    }

    const snapshot = pastSnapshots[period];
    if (!snapshot) return { percent: 0, available: false };

    const pastValue = snapshot[valueKey] ?? 0;
    if (pastValue === 0) return { percent: 0, available: false };

    const percent = ((totalValue - pastValue) / pastValue) * 100;
    return { percent, available: true };
  }

  const change = getChangeForPeriod(changePeriod);
  const changeColor =
    !change.available ? undefined : change.percent >= 0 ? "green" : "red";
  const changeSign =
    !change.available ? "" : change.percent >= 0 ? "+" : "";
  const changeValue = change.available
    ? `${changeSign}${change.percent.toFixed(2)}%`
    : "—";

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {/* Total Portfolio */}
      <StatCard
        label="Total Portfolio"
        value={formatCurrency(totalValue, primaryCurrency)}
        sub={primaryCurrency}
        icon={<Wallet className="w-4 h-4" />}
      />

      {/* Crypto */}
      <StatCard
        label="Crypto"
        value={formatCurrency(cryptoValue, primaryCurrency)}
        sub={stablecoinValue > 0
          ? `excl. ${formatCurrency(stablecoinValue, primaryCurrency)} stablecoins`
          : "across all wallets"}
        icon={<Bitcoin className="w-4 h-4" />}
        href="/dashboard/crypto"
      />

      {/* Equities */}
      <StatCard
        label="Equities"
        value={formatCurrency(stocksValue, primaryCurrency)}
        sub="across all brokers"
        icon={<BarChart3 className="w-4 h-4" />}
        href="/dashboard/stocks"
      />

      {/* Banks & Deposits */}
      <StatCard
        label="Banks & Deposits"
        value={formatCurrency(cashValue, primaryCurrency)}
        sub={stablecoinValue > 0
          ? `incl. ${formatCurrency(stablecoinValue, primaryCurrency)} stablecoins`
          : "banks + exchanges"}
        icon={<Banknote className="w-4 h-4" />}
        href="/dashboard/cash"
      />

      {/* Change — with period selector */}
      <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-5">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-zinc-500">
              <TrendingUp className="w-4 h-4" />
            </span>
            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
              Change
            </p>
          </div>
          <div className="flex gap-0.5">
            {CHANGE_PERIODS.map((p) => (
              <button
                key={p}
                onClick={() => setChangePeriod(p)}
                className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                  p === changePeriod
                    ? "bg-blue-600 text-white"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        <p
          className={`text-2xl font-semibold mt-2 tabular-nums ${
            changeColor === "green"
              ? "text-emerald-400"
              : changeColor === "red"
                ? "text-red-400"
                : "text-zinc-100"
          }`}
        >
          {changeValue}
        </p>
        <p className="text-xs text-zinc-600 mt-1">
          {PERIOD_LABELS[changePeriod]}
        </p>
      </div>

      {/* Allocation */}
      <StatCard
        label="Allocation"
        value={`${allocation.crypto.toFixed(0)}% / ${allocation.stocks.toFixed(0)}% / ${allocation.cash.toFixed(0)}%`}
        sub="crypto / stocks / cash"
        icon={<PieChart className="w-4 h-4" />}
      />
    </div>
  );
}

// ── Reusable stat card ──────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  icon,
  highlight,
  href,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  highlight?: "green" | "red";
  href?: string;
}) {
  const content = (
    <>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-zinc-500">{icon}</span>
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
          {label}
        </p>
      </div>
      <p
        className={`text-2xl font-semibold mt-2 tabular-nums ${
          highlight === "green"
            ? "text-emerald-400"
            : highlight === "red"
              ? "text-red-400"
              : "text-zinc-100"
        }`}
      >
        {value}
      </p>
      <p className="text-xs text-zinc-600 mt-1">{sub}</p>
    </>
  );

  const className =
    "bg-zinc-900 border border-zinc-800/50 rounded-xl p-5" +
    (href ? " hover:border-zinc-700 hover:bg-zinc-800/50 transition-colors" : "");

  if (href) {
    return (
      <Link href={href} className={`block ${className}`}>
        {content}
      </Link>
    );
  }

  return <div className={className}>{content}</div>;
}
