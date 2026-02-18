import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getBrokers } from "@/lib/actions/brokers";
import { getStockPrices } from "@/lib/prices/yahoo";
import { StockTable } from "@/components/stocks/stock-table";

export default async function StocksPage() {
  const [assets, brokers] = await Promise.all([
    getStockAssetsWithPositions(),
    getBrokers(),
  ]);

  // Build Yahoo ticker list: use yahoo_ticker if set, otherwise fall back to ticker
  const yahooTickers = assets
    .map((a) => a.yahoo_ticker || a.ticker)
    .filter(Boolean);

  const prices = await getStockPrices(yahooTickers);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Stocks & ETFs</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Manage your stock and ETF positions across brokers
        </p>
      </div>
      <StockTable assets={assets} brokers={brokers} prices={prices} />
    </div>
  );
}
