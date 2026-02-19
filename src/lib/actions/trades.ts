"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { TradeEntry, TradeEntryInput } from "@/lib/types";

/** Lightweight asset name lists for the trade diary dropdown */
export async function getAssetOptions(): Promise<{
  crypto: { ticker: string; name: string }[];
  stock: { ticker: string; name: string; currency: string }[];
  cash: string[];
}> {
  const supabase = await createServerSupabaseClient();

  const [cryptoRes, stockRes, bankRes] = await Promise.all([
    supabase
      .from("crypto_assets")
      .select("ticker, name")
      .order("ticker"),
    supabase
      .from("stock_assets")
      .select("ticker, name, currency")
      .order("ticker"),
    supabase
      .from("bank_accounts")
      .select("currency"),
  ]);

  // Deduplicate bank currencies into a sorted list
  const cashCurrencies = [
    ...new Set((bankRes.data ?? []).map((b) => b.currency as string)),
  ].sort();

  return {
    crypto: cryptoRes.data ?? [],
    stock: stockRes.data ?? [],
    cash: cashCurrencies,
  };
}

export async function getTradeEntries(): Promise<TradeEntry[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("trade_entries")
    .select("*")
    .order("trade_date", { ascending: false });

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createTradeEntry(input: TradeEntryInput) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const totalValue = input.quantity * input.price;

  const { error } = await supabase.from("trade_entries").insert({
    user_id: user.id,
    trade_date: input.trade_date,
    asset_type: input.asset_type,
    asset_name: input.asset_name.trim(),
    action: input.action,
    quantity: input.quantity,
    price: input.price,
    currency: input.currency ?? "USD",
    total_value: Math.round(totalValue * 100) / 100,
    notes: input.notes?.trim() || null,
  });

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/diary");
}

export async function updateTradeEntry(id: string, input: TradeEntryInput) {
  const supabase = await createServerSupabaseClient();
  const totalValue = input.quantity * input.price;

  const { error } = await supabase
    .from("trade_entries")
    .update({
      trade_date: input.trade_date,
      asset_type: input.asset_type,
      asset_name: input.asset_name.trim(),
      action: input.action,
      quantity: input.quantity,
      price: input.price,
      currency: input.currency ?? "USD",
      total_value: Math.round(totalValue * 100) / 100,
      notes: input.notes?.trim() || null,
    })
    .eq("id", id);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/diary");
}

export async function deleteTradeEntry(id: string) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("trade_entries")
    .delete()
    .eq("id", id);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/diary");
}
