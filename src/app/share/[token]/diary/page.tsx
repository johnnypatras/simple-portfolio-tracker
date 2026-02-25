import { notFound } from "next/navigation";
import { requireScope } from "../scope-gate";
import { validateShareToken } from "@/lib/actions/shares";
import { createAdminClient } from "@/lib/supabase/admin";
import { TradeTable } from "@/components/diary/trade-table";
import type { TradeEntry } from "@/lib/types";

export default async function SharedDiaryPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  await requireScope(token, "full_with_history");

  const validated = await validateShareToken(token);
  if (!validated) notFound();

  const admin = createAdminClient();
  const userId = validated.owner_id;

  // Fetch trades + asset options for the dropdown (read-only, won't be used)
  const [tradesRes, cryptoRes, stockRes, bankRes] = await Promise.all([
    admin.from("trade_entries").select("*").eq("user_id", userId)
      .is("deleted_at", null).order("trade_date", { ascending: false }),
    admin.from("crypto_assets").select("ticker, name").eq("user_id", userId)
      .is("deleted_at", null).order("ticker"),
    admin.from("stock_assets").select("ticker, name, currency").eq("user_id", userId)
      .is("deleted_at", null).order("ticker"),
    admin.from("bank_accounts").select("currency").eq("user_id", userId)
      .is("deleted_at", null),
  ]);

  const trades = (tradesRes.data ?? []) as TradeEntry[];

  const cashCurrencies = [
    ...new Set((bankRes.data ?? []).map((b) => b.currency as string)),
  ].sort();

  const assetOptions = {
    crypto: cryptoRes.data ?? [],
    stock: stockRes.data ?? [],
    cash: cashCurrencies,
  };

  return <TradeTable trades={trades} assetOptions={assetOptions} />;
}
