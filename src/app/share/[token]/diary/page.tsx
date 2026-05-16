import { requireScope } from "../scope-gate";
import { createAdminClient } from "@/lib/supabase/admin";
import { TradeTable } from "@/components/diary/trade-table";
import type { TradeEntry } from "@/lib/types";

export default async function SharedDiaryPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const share = await requireScope(token, "full_with_history");

  const admin = createAdminClient();

  const { data } = await admin
    .from("trade_entries")
    .select("*")
    .eq("user_id", share.owner_id)
    .is("deleted_at", null)
    .order("trade_date", { ascending: false });

  // DB stores action/asset_type as free text constrained by validation; narrow to domain enums
  const trades: TradeEntry[] = (data ?? []).map((row) => ({
    ...row,
    action: row.action as TradeEntry["action"],
    asset_type: row.asset_type as TradeEntry["asset_type"],
  }));

  // Asset options are only used by the add-entry form, which is hidden in read-only mode
  const assetOptions = { crypto: [], stock: [], cash: [] };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Trade Diary</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Log your significant buys and sells
        </p>
      </div>
      <TradeTable trades={trades} assetOptions={assetOptions} />
    </div>
  );
}
