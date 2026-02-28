import { notFound } from "next/navigation";
import { getSharedPortfolio } from "@/lib/actions/shared-portfolio";
import { getPrices } from "@/lib/prices/coingecko";
import { getStockAndIndexPrices, getDividendYields, fetchIndexHistory } from "@/lib/prices/yahoo";
import { getFXRates } from "@/lib/prices/fx";
import { deriveCashFlows } from "@/lib/actions/benchmark";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { computeDashboardInsights } from "@/lib/portfolio/dashboard-insights";
import { DashboardGrid } from "@/components/dashboard/dashboard-grid";
import dynamic from "next/dynamic";

const PortfolioChart = dynamic(
  () => import("@/components/dashboard/portfolio-chart").then((m) => m.PortfolioChart),
  { loading: () => <div className="h-64 rounded-xl bg-zinc-900 animate-pulse" /> }
);

export default async function SharedOverviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const data = await getSharedPortfolio(token);
  if (!data) notFound();

  const {
    profile, cryptoAssets, stockAssets, bankAccounts,
    exchangeDeposits, brokerDeposits, snapshots,
    snap7d, snap30d, snap1y,
  } = data;
  const primaryCurrency = profile.primary_currency;

  // Build ticker/coin ID lists for price fetching
  const coinIds = [
    ...new Set(["bitcoin", "ethereum", ...cryptoAssets.map((a) => a.coingecko_id)]),
  ];
  const yahooTickers = stockAssets
    .map((a) => a.yahoo_ticker || a.ticker)
    .filter(Boolean);

  const allCurrencies = [
    ...new Set([
      "EUR", "USD",
      ...stockAssets.map((a) => a.currency),
      ...bankAccounts.map((a) => a.currency),
      ...exchangeDeposits.map((a) => a.currency),
      ...brokerDeposits.map((a) => a.currency),
    ]),
  ];

  // Fetch prices + market data + benchmark (stocks + indices in one batch)
  const [
    cryptoPrices, { stockPrices, indexPrices }, fxRates, dividends,
    sp500TRHistory, cashFlows,
  ] = await Promise.all([
    getPrices(coinIds),
    getStockAndIndexPrices(yahooTickers),
    getFXRates(primaryCurrency, allCurrencies),
    getDividendYields(yahooTickers),
    fetchIndexHistory("^SP500TR", 365),
    deriveCashFlows(data.share.owner_id),
  ]);

  const sp500Data = indexPrices["^GSPC"] ?? null;
  const goldData = indexPrices["GC=F"] ?? null;
  const nasdaqData = indexPrices["^IXIC"] ?? null;
  const dowData = indexPrices["^DJI"] ?? null;
  const eurUsdData = indexPrices["EURUSD=X"] ?? null;

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

  const insights = computeDashboardInsights({
    cryptoAssets, cryptoPrices, stockAssets, stockPrices,
    bankAccounts, exchangeDeposits, brokerDeposits,
    primaryCurrency, fxRates, summary,
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

  // NOTE: No saveSnapshot() call — shared views should not write data
  const pastSnapshots = {
    "24h": null,
    "7d": snap7d,
    "30d": snap30d,
    "1y": snap1y,
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Dashboard</h1>
      </div>
      <DashboardGrid
        summary={summary}
        insights={insights}
        pastSnapshots={pastSnapshots}
      />
      <div className="mt-6">
        <PortfolioChart
          snapshots={snapshots}
          liveValue={summary.totalValue}
          liveValueUsd={summary.totalValueUsd}
          primaryCurrency={primaryCurrency}
          sp500History={sp500TRHistory}
          cashFlows={cashFlows}
        />
      </div>
    </div>
  );
}
