"use client";

import {
  Wallet,
  TrendingUp,
  Bitcoin,
  BarChart3,
  Banknote,
  PieChart,
} from "lucide-react";
import type { PortfolioSummary } from "@/lib/portfolio/aggregate";

interface PortfolioCardsProps {
  summary: PortfolioSummary;
}

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

interface CardDef {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  highlight?: "green" | "red";
}

export function PortfolioCards({ summary }: PortfolioCardsProps) {
  const {
    totalValue,
    cryptoValue,
    stocksValue,
    cashValue,
    change24hPercent,
    allocation,
    primaryCurrency,
  } = summary;

  const changeColor = change24hPercent >= 0 ? "green" : "red";
  const changeSign = change24hPercent >= 0 ? "+" : "";

  const cards: CardDef[] = [
    {
      label: "Total Portfolio",
      value: formatCurrency(totalValue, primaryCurrency),
      sub: primaryCurrency,
      icon: <Wallet className="w-4 h-4" />,
    },
    {
      label: "Crypto",
      value: formatCurrency(cryptoValue, primaryCurrency),
      sub: "across all wallets",
      icon: <Bitcoin className="w-4 h-4" />,
    },
    {
      label: "Stocks & ETFs",
      value: formatCurrency(stocksValue, primaryCurrency),
      sub: "across all brokers",
      icon: <BarChart3 className="w-4 h-4" />,
    },
    {
      label: "Cash",
      value: formatCurrency(cashValue, primaryCurrency),
      sub: "banks + exchanges",
      icon: <Banknote className="w-4 h-4" />,
    },
    {
      label: "24h Change",
      value: `${changeSign}${change24hPercent.toFixed(2)}%`,
      sub: "vs yesterday",
      icon: <TrendingUp className="w-4 h-4" />,
      highlight: changeColor,
    },
    {
      label: "Allocation",
      value: `${allocation.crypto.toFixed(0)}% / ${allocation.stocks.toFixed(0)}% / ${allocation.cash.toFixed(0)}%`,
      sub: "crypto / stocks / cash",
      icon: <PieChart className="w-4 h-4" />,
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-5"
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="text-zinc-500">{card.icon}</span>
            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
              {card.label}
            </p>
          </div>
          <p
            className={`text-2xl font-semibold mt-2 tabular-nums ${
              card.highlight === "green"
                ? "text-emerald-400"
                : card.highlight === "red"
                  ? "text-red-400"
                  : "text-zinc-100"
            }`}
          >
            {card.value}
          </p>
          <p className="text-xs text-zinc-600 mt-1">{card.sub}</p>
        </div>
      ))}
    </div>
  );
}
