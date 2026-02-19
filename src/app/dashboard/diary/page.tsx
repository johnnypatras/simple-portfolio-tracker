import { getTradeEntries, getAssetOptions } from "@/lib/actions/trades";
import { TradeTable } from "@/components/diary/trade-table";
import { MobileMenuButton } from "@/components/sidebar";

export default async function DiaryPage() {
  const [trades, assetOptions] = await Promise.all([
    getTradeEntries(),
    getAssetOptions(),
  ]);

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <h1 className="text-2xl font-semibold text-zinc-100">Trade Diary</h1>
        </div>
        <p className="text-sm text-zinc-500 mt-1">
          Log your significant buys and sells
        </p>
      </div>
      <TradeTable trades={trades} assetOptions={assetOptions} />
    </div>
  );
}
