import { notFound } from "next/navigation";
import { getSharedPortfolio } from "@/lib/actions/shared-portfolio";
import { getPrices } from "@/lib/prices/coingecko";
import { getStockPrices, fetchSinglePrice, getDividendYields } from "@/lib/prices/yahoo";
import { getFXRates } from "@/lib/prices/fx";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { computeDashboardInsights } from "@/lib/portfolio/dashboard-insights";
import { DashboardGrid } from "@/components/dashboard/dashboard-grid";
import { PortfolioChart } from "@/components/dashboard/portfolio-chart";

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

  // Fetch prices + market data
  const [
    cryptoPrices, stockPrices, fxRates, dividends,
    sp500Data, goldData, nasdaqData, dowData, eurUsdData,
  ] = await Promise.all([
    getPrices(coinIds),
    getStockPrices(yahooTickers),
    getFXRates(primaryCurrency, allCurrencies),
    getDividendYields(yahooTickers),
    fetchSinglePrice("^GSPC"),
    fetchSinglePrice("GC=F"),
    fetchSinglePrice("^IXIC"),
    fetchSinglePrice("^DJI"),
    fetchSinglePrice("EURUSD=X"),
  ]);

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
      <DashboardGrid
        summary={summary}
        insights={insights}
        pastSnapshots={pastSnapshots}
      />
      <div className="mt-6">
        <PortfolioChart
          snapshots={snapshots}
          liveValue={summary.totalValue}
          primaryCurrency={primaryCurrency}
        />
      </div>
    </div>
  );
}
