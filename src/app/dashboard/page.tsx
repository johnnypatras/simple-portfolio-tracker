import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/actions/profile";
import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getBankAccounts } from "@/lib/actions/bank-accounts";
import { getExchangeDeposits } from "@/lib/actions/exchange-deposits";
import { getBrokerDeposits } from "@/lib/actions/broker-deposits";
import { getPrices } from "@/lib/prices/coingecko";
import { getStockPrices, fetchSinglePrice, getDividendYields } from "@/lib/prices/yahoo";
import { getFXRates } from "@/lib/prices/fx";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { computeDashboardInsights } from "@/lib/portfolio/dashboard-insights";
import {
  saveSnapshot,
  getSnapshots,
  getSnapshotAt,
} from "@/lib/actions/snapshots";
import { DashboardGrid } from "@/components/dashboard/dashboard-grid";
import { PortfolioChart } from "@/components/dashboard/portfolio-chart";
import { MobileMenuButton } from "@/components/sidebar";

export default async function DashboardPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // ── Round 1: Portfolio data + independent fetches in parallel ──
  // Market indices and snapshots don't depend on asset data,
  // so they run alongside DB queries instead of waiting for Round 2.
  const [
    profile, cryptoAssets, stockAssets, bankAccounts, exchangeDeposits, brokerDeposits,
    chartSnapshots, snap7d, snap30d, snap1y,
    sp500Data, goldData, nasdaqData, dowData, eurUsdData,
  ] = await Promise.all([
    getProfile(),
    getCryptoAssetsWithPositions(),
    getStockAssetsWithPositions(),
    getBankAccounts(),
    getExchangeDeposits(),
    getBrokerDeposits(),
    getSnapshots(365),           // up to 1 year of history for the chart
    getSnapshotAt(7),            // for 7d change
    getSnapshotAt(30),           // for 30d change
    getSnapshotAt(365),          // for 1y change
    fetchSinglePrice("^GSPC"),   // S&P 500 index
    fetchSinglePrice("GC=F"),    // Gold futures
    fetchSinglePrice("^IXIC"),   // Nasdaq Composite
    fetchSinglePrice("^DJI"),    // Dow Jones Industrial
    fetchSinglePrice("EURUSD=X"),// EUR/USD cross rate (for 24h change)
  ]);

  const primaryCurrency = profile.primary_currency;

  // Build ticker/coin ID lists for price fetching
  // Always include "bitcoin" for BTC market price on dashboard
  const coinIds = [
    ...new Set(["bitcoin", "ethereum", ...cryptoAssets.map((a) => a.coingecko_id)]),
  ];
  const yahooTickers = stockAssets
    .map((a) => a.yahoo_ticker || a.ticker)
    .filter(Boolean);

  // Collect all unique currencies that need FX conversion
  const allCurrencies = [
    ...new Set([
      "EUR", "USD", // always include for EUR/USD cross rate in market panel
      ...stockAssets.map((a) => a.currency),
      ...bankAccounts.map((a) => a.currency),
      ...exchangeDeposits.map((a) => a.currency),
      ...brokerDeposits.map((a) => a.currency),
    ]),
  ];

  // ── Round 2: Only fetches that depend on Round 1 data ───
  const [cryptoPrices, stockPrices, fxRates, dividends] =
    await Promise.all([
      getPrices(coinIds),
      getStockPrices(yahooTickers),
      getFXRates(primaryCurrency, allCurrencies),
      getDividendYields(yahooTickers), // trailing 12-month yields (6h cache)
    ]);

  // ── Aggregate into portfolio summary ──────────────────
  const summary = aggregatePortfolio({
    cryptoAssets,
    cryptoPrices,
    stockAssets,
    stockPrices,
    bankAccounts,
    exchangeDeposits,
    brokerDeposits,
    primaryCurrency,
    fxRates,
    eurUsdChange24h: eurUsdData?.change24h ?? 0,
  });

  // ── Compute dashboard insights ────────────────────────
  const insights = computeDashboardInsights({
    cryptoAssets,
    cryptoPrices,
    stockAssets,
    stockPrices,
    bankAccounts,
    exchangeDeposits,
    brokerDeposits,
    primaryCurrency,
    fxRates,
    summary,
    sp500Price: sp500Data?.price ?? 0,
    sp500Change24h: sp500Data?.change24h ?? 0,
    goldPrice: goldData?.price ?? 0,
    goldChange24h: goldData?.change24h ?? 0,
    nasdaqPrice: nasdaqData?.price ?? 0,
    nasdaqChange24h: nasdaqData?.change24h ?? 0,
    dowPrice: dowData?.price ?? 0,
    dowChange24h: dowData?.change24h ?? 0,
    eurUsdChange24h: eurUsdData?.change24h ?? 0,
    dividends,
  });

  // ── Save today's snapshot (fire-and-forget) ───────────
  // Don't await — this shouldn't block rendering
  saveSnapshot({
    totalValueUsd: summary.totalValueUsd,
    totalValueEur: summary.totalValueEur,
    cryptoValueUsd: summary.cryptoValueUsd,
    stocksValueUsd: summary.stocksValueUsd,
    cashValueUsd: summary.cashValueUsd,
  }).catch(() => {}); // silently ignore errors

  // Build past-snapshot map for the change card
  const pastSnapshots = {
    "24h": null,  // 24h uses real-time API data, not snapshots
    "7d": snap7d,
    "30d": snap30d,
    "1y": snap1y,
  };

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <h1 className="text-2xl font-semibold text-zinc-100">Dashboard</h1>
        </div>
        <p className="text-sm text-zinc-500 mt-1">
          Welcome back{user?.email ? `, ${user.email}` : ""}
        </p>
      </div>

      <DashboardGrid
        summary={summary}
        insights={insights}
        pastSnapshots={pastSnapshots}
      />

      <div className="mt-6">
        <PortfolioChart
          snapshots={chartSnapshots}
          liveValue={summary.totalValue}
          primaryCurrency={primaryCurrency}
        />
      </div>
    </div>
  );
}
