import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getBrokers } from "@/lib/actions/brokers";
import { getProfile } from "@/lib/actions/profile";
import { deriveCashFlows } from "@/lib/actions/benchmark";
import { getStockAndIndexPrices } from "@/lib/prices/yahoo";
import { getFXRatesSafe } from "@/lib/prices/fx";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { computeDeposits } from "@/lib/portfolio/dashboard-changes";
import { StockTable } from "@/components/stocks/stock-table";
import { MobileMenuButton } from "@/components/sidebar";

export default async function StocksPage() {
  const [assets, brokers, profile, cashFlowResult] = await Promise.all([
    getStockAssetsWithPositions(),
    getBrokers(),
    getProfile(),
    deriveCashFlows(),
  ]);

  const cashFlows = cashFlowResult.events;

  // Build Yahoo ticker list: use yahoo_ticker if set, otherwise fall back to ticker
  const yahooTickers = assets
    .map((a) => a.yahoo_ticker || a.ticker)
    .filter(Boolean);

  // Fetch prices + FX rates in parallel (EURUSD=X folded into stock batch)
  const cur = profile.primary_currency;
  const uniqueCurrencies = [...new Set(["USD", "EUR", ...assets.map((a) => a.currency)])];
  const [{ stockPrices: prices, indexPrices, dividends }, fxRates] = await Promise.all([
    getStockAndIndexPrices(yahooTickers),
    getFXRatesSafe(cur, uniqueCurrencies),
  ]);
  const eurUsdData = indexPrices["EURUSD=X"] ?? null;

  // Compute stocks-only aggregate for summary header enrichment
  const summary = aggregatePortfolio({
    cryptoAssets: [],
    cryptoPrices: {},
    stockAssets: assets,
    stockPrices: prices,
    bankAccounts: [],
    exchangeDeposits: [],
    brokerDeposits: [],
    primaryCurrency: cur,
    fxRates,
    eurUsdChange24h: eurUsdData?.change24h ?? 0,
  });

  const fxMul = cur === "USD" || summary.totalValueUsd === 0 ? 1 : summary.totalValue / summary.totalValueUsd;
  const dep = computeDeposits("24h", cashFlows, cur, fxMul, "stocks");

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <h1 className="text-2xl font-semibold text-zinc-100">Equities</h1>
        </div>
      </div>
      <StockTable
        assets={assets}
        brokers={brokers}
        prices={prices}
        primaryCurrency={cur}
        fxRates={fxRates}
        dividends={dividends}
        fxValueChange24h={summary.stocksFxValueChange24h}
        deposits={dep.total}
        depositBreakdown={dep.breakdown}
      />
    </div>
  );
}
