import { notFound } from "next/navigation";
import { getSharedPortfolio } from "@/lib/actions/shared-portfolio";
import { getPrices } from "@/lib/prices/coingecko";
import { getStockAndIndexPrices, getDividendYields, fetchIndexHistory } from "@/lib/prices/yahoo";
import { getFXRatesSafe } from "@/lib/prices/fx";
import { deriveCashFlows } from "@/lib/actions/benchmark";
import { getAdjustmentDeltas } from "@/lib/actions/activity-log";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { computeDashboardInsights } from "@/lib/portfolio/dashboard-insights";
import { DashboardGrid } from "@/components/dashboard/dashboard-grid";
import { RegisterHoldings } from "@/components/ui/command-palette-provider";
import type { HoldingItem } from "@/lib/types";
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
    ...new Set(["bitcoin", "ethereum", "solana", ...cryptoAssets.map((a) => a.coingecko_id)]),
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
    cryptoPrices, { stockPrices, indexPrices }, fxRates, fxRatesUsd, fxRatesEur,
    dividends, sp500TRHistory, cashFlows, adjustmentDeltas,
  ] = await Promise.all([
    getPrices(coinIds),
    getStockAndIndexPrices(yahooTickers),
    getFXRatesSafe(primaryCurrency, allCurrencies),
    getFXRatesSafe("USD", allCurrencies.filter((c) => c !== "USD")),
    getFXRatesSafe("EUR", allCurrencies.filter((c) => c !== "EUR")),
    getDividendYields(yahooTickers),
    fetchIndexHistory("^SP500TR", 365),
    deriveCashFlows(data.share.owner_id),
    getAdjustmentDeltas(data.share.owner_id),
  ]);

  const sp500Data = indexPrices["^GSPC"] ?? null;
  const goldData = indexPrices["GC=F"] ?? null;
  const nasdaqData = indexPrices["^IXIC"] ?? null;
  const dowData = indexPrices["^DJI"] ?? null;
  const eurUsdData = indexPrices["EURUSD=X"] ?? null;
  const stoxx50Data = indexPrices["^STOXX50E"] ?? null;
  const silverData = indexPrices["SI=F"] ?? null;
  const oilData = indexPrices["BZ=F"] ?? null;
  const treasury10yData = indexPrices["^TNX"] ?? null;
  const vixData = indexPrices["^VIX"] ?? null;

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
    fxRatesUsd,
    fxRatesEur,
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
    solPriceUsd: cryptoPrices["solana"]?.usd ?? 0,
    solChange24h: cryptoPrices["solana"]?.usd_24h_change ?? 0,
    stoxx50Price: stoxx50Data?.price ?? 0,
    stoxx50Change24h: stoxx50Data?.change24h ?? 0,
    silverPrice: silverData?.price ?? 0,
    silverChange24h: silverData?.change24h ?? 0,
    oilPrice: oilData?.price ?? 0,
    oilChange24h: oilData?.change24h ?? 0,
    treasury10yPrice: treasury10yData?.price ?? 0,
    treasury10yChange24h: treasury10yData?.change24h ?? 0,
    vixPrice: vixData?.price ?? 0,
    vixChange24h: vixData?.change24h ?? 0,
    dividends,
  });

  // NOTE: No saveSnapshot() call — shared views should not write data
  const pastSnapshots = {
    "24h": null,
    "7d": snap7d,
    "30d": snap30d,
    "1y": snap1y,
  };

  // ── Build flat holdings for command palette search ─────
  const paletteHoldings: HoldingItem[] = [
    ...cryptoAssets.map((a) => {
      const price = cryptoPrices[a.coingecko_id];
      const totalQty = a.positions.reduce((s, p) => s + p.quantity, 0);
      const valueUsd = (price?.usd ?? 0) * totalQty;
      return {
        id: a.id,
        type: "crypto" as const,
        name: a.name,
        ticker: a.ticker.toUpperCase(),
        value: valueUsd * (fxRates["USD"] ?? 1),
        change24h: price?.usd_24h_change,
        icon: a.image_url,
        detailPath: `/share/${token}/crypto`,
      };
    }),
    ...stockAssets.map((a) => {
      const tick = a.yahoo_ticker || a.ticker;
      const price = stockPrices[tick];
      const totalQty = a.positions.reduce((s, p) => s + p.quantity, 0);
      const valueNative = (price?.price ?? 0) * totalQty;
      return {
        id: a.id,
        type: "stock" as const,
        name: a.name,
        ticker: a.ticker,
        value: valueNative * (fxRates[price?.currency ?? a.currency] ?? 1),
        change24h: price?.change24h,
        detailPath: `/share/${token}/stocks`,
      };
    }),
    ...bankAccounts.map((a) => ({
      id: a.id,
      type: "bank" as const,
      name: `${a.name} (${a.currency})`,
      value: a.balance * (fxRates[a.currency] ?? 1),
      detailPath: `/share/${token}/cash`,
    })),
    ...exchangeDeposits.map((d) => ({
      id: d.id,
      type: "exchange_deposit" as const,
      name: `${d.wallet_name} ${d.currency}`,
      value: d.amount * (fxRates[d.currency] ?? 1),
      detailPath: `/share/${token}/cash`,
    })),
    ...brokerDeposits.map((d) => ({
      id: d.id,
      type: "broker_deposit" as const,
      name: `${d.broker_name} ${d.currency}`,
      value: d.amount * (fxRates[d.currency] ?? 1),
      detailPath: `/share/${token}/cash`,
    })),
  ];

  return (
    <div>
      <RegisterHoldings holdings={paletteHoldings} />
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Dashboard</h1>
      </div>
      <DashboardGrid
        summary={summary}
        insights={insights}
        pastSnapshots={pastSnapshots}
        cashFlows={cashFlows}
      />
      <div className="mt-6">
        <PortfolioChart
          snapshots={snapshots}
          liveValue={summary.totalValue}
          liveValueUsd={summary.totalValueUsd}
          primaryCurrency={primaryCurrency}
          sp500History={sp500TRHistory}
          cashFlows={cashFlows}
          adjustmentDeltas={adjustmentDeltas}
          liveSlices={{
            crypto: summary.cryptoValue,
            stocks: summary.stocksValue,
            cash: summary.cashValue,
          }}
          liveSlicesUsd={{
            crypto: summary.cryptoValueUsd,
            stocks: summary.stocksValueUsd,
            cash: summary.cashValueUsd,
          }}
          defaultReturnMode
        />
      </div>
    </div>
  );
}
