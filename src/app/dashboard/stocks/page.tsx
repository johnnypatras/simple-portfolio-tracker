import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getBrokers } from "@/lib/actions/brokers";
import { getProfile } from "@/lib/actions/profile";
import { getStockPrices } from "@/lib/prices/yahoo";
import { getFXRates } from "@/lib/prices/fx";
import { StockTable } from "@/components/stocks/stock-table";

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

  // Fetch prices + FX rates in parallel
  const uniqueCurrencies = [...new Set(assets.map((a) => a.currency))];
  const [prices, fxRates] = await Promise.all([
    getStockPrices(yahooTickers),
    getFXRates(profile.primary_currency, uniqueCurrencies),
  ]);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Stocks & ETFs</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Manage your stock and ETF positions across brokers
        </p>
      </div>
      <StockTable
        assets={assets}
        brokers={brokers}
        prices={prices}
        primaryCurrency={profile.primary_currency}
        fxRates={fxRates}
      />
    </div>
  );
}
