import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getBrokers } from "@/lib/actions/brokers";
import { getProfile } from "@/lib/actions/profile";
import { getStockPrices, getDividendYields, fetchSinglePrice } from "@/lib/prices/yahoo";
import { getFXRates } from "@/lib/prices/fx";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { StockTable } from "@/components/stocks/stock-table";
import { MobileMenuButton } from "@/components/sidebar";

export default async function StocksPage() {
  const [assets, brokers, profile] = await Promise.all([
    getStockAssetsWithPositions(),
    getBrokers(),
    getProfile(),
  ]);

  // Build Yahoo ticker list: use yahoo_ticker if set, otherwise fall back to ticker
  const yahooTickers = assets
    .map((a) => a.yahoo_ticker || a.ticker)
    .filter(Boolean);

  // Fetch prices + FX rates + EUR/USD change in parallel
  const cur = profile.primary_currency;
  const uniqueCurrencies = [...new Set(["USD", "EUR", ...assets.map((a) => a.currency)])];
  const [prices, fxRates, eurUsdData, dividends] = await Promise.all([
    getStockPrices(yahooTickers),
    getFXRates(cur, uniqueCurrencies),
    fetchSinglePrice("EURUSD=X"),
    getDividendYields(yahooTickers),
  ]);

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
        fxChangePercent={summary.stocksFxChange24hPercent}
        fxChangeValue={summary.stocksFxValueChange24h}
        dividends={dividends}
      />
    </div>
  );
}
