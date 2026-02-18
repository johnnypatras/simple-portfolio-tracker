import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/actions/profile";
import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getBankAccounts } from "@/lib/actions/bank-accounts";
import { getExchangeDeposits } from "@/lib/actions/exchange-deposits";
import { getPrices } from "@/lib/prices/coingecko";
import { getStockPrices } from "@/lib/prices/yahoo";
import { getFXRates } from "@/lib/prices/fx";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import {
  saveSnapshot,
  getSnapshots,
  getSnapshotAt,
} from "@/lib/actions/snapshots";
import { PortfolioCards } from "@/components/dashboard/portfolio-cards";
import { PortfolioChart } from "@/components/dashboard/portfolio-chart";

export default async function DashboardPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // ── Round 1: Fetch all portfolio data in parallel ─────
  const [profile, cryptoAssets, stockAssets, bankAccounts, exchangeDeposits] =
    await Promise.all([
      getProfile(),
      getCryptoAssetsWithPositions(),
      getStockAssetsWithPositions(),
      getBankAccounts(),
      getExchangeDeposits(),
    ]);

  const primaryCurrency = profile.primary_currency;

  // Build ticker/coin ID lists for price fetching
  const coinIds = cryptoAssets.map((a) => a.coingecko_id);
  const yahooTickers = stockAssets
    .map((a) => a.yahoo_ticker || a.ticker)
    .filter(Boolean);

  // Collect all unique currencies that need FX conversion
  const allCurrencies = [
    ...new Set([
      ...stockAssets.map((a) => a.currency),
      ...bankAccounts.map((a) => a.currency),
      ...exchangeDeposits.map((a) => a.currency),
    ]),
  ];

  // ── Round 2: Fetch prices + FX rates + snapshots in parallel
  const [cryptoPrices, stockPrices, fxRates, chartSnapshots, snap7d, snap30d, snap1y] =
    await Promise.all([
      getPrices(coinIds),
      getStockPrices(yahooTickers),
      getFXRates(primaryCurrency, allCurrencies),
      getSnapshots(365),          // up to 1 year of history for the chart
      getSnapshotAt(7),           // for 7d change
      getSnapshotAt(30),          // for 30d change
      getSnapshotAt(365),         // for 1y change
    ]);

  // ── Aggregate into portfolio summary ──────────────────
  const summary = aggregatePortfolio({
    cryptoAssets,
    cryptoPrices,
    stockAssets,
    stockPrices,
    bankAccounts,
    exchangeDeposits,
    primaryCurrency,
    fxRates,
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
        <h1 className="text-2xl font-semibold text-zinc-100">Dashboard</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Welcome back{user?.email ? `, ${user.email}` : ""}
        </p>
      </div>

      <PortfolioCards summary={summary} pastSnapshots={pastSnapshots} />

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
