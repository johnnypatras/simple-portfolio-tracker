import { getTradeEntries } from "@/lib/actions/trades";
import { TradeTable } from "@/components/diary/trade-table";

export default async function DiaryPage() {
  const trades = await getTradeEntries();

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Trade Diary</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Log your significant buys and sells
        </p>
      </div>
      <TradeTable trades={trades} />
    </div>
  );
}
