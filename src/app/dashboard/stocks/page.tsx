import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getBrokers } from "@/lib/actions/brokers";
import { StockTable } from "@/components/stocks/stock-table";

export default async function StocksPage() {
  const [assets, brokers] = await Promise.all([
    getStockAssetsWithPositions(),
    getBrokers(),
  ]);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Stocks & ETFs</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Manage your stock and ETF positions across brokers
        </p>
      </div>
      <StockTable assets={assets} brokers={brokers} />
    </div>
  );
}
