"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { TradeEntry, TradeEntryInput } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";

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
      .is("deleted_at", null)
      .order("ticker"),
    supabase
      .from("stock_assets")
      .select("ticker, name, currency")
      .is("deleted_at", null)
      .order("ticker"),
    supabase
      .from("bank_accounts")
      .select("currency")
      .is("deleted_at", null),
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
    .is("deleted_at", null)
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

  const { data: created, error } = await supabase.from("trade_entries").insert({
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
  }).select("*").single();

  if (error) throw new Error(error.message);
  await logActivity({
    action: "created",
    entity_type: "trade_entry",
    entity_name: `${input.action.toUpperCase()} ${input.asset_name.trim()}`,
    description: `Logged ${input.action} of ${input.quantity} ${input.asset_name.trim()} at ${input.price} ${input.currency ?? "USD"}`,
    entity_id: created?.id,
    entity_table: "trade_entries",
    before_snapshot: null,
    after_snapshot: created,
  });
  revalidatePath("/dashboard/diary");
}

export async function updateTradeEntry(id: string, input: TradeEntryInput) {
  const supabase = await createServerSupabaseClient();
  const totalValue = input.quantity * input.price;

  // Capture before snapshot
  const { data: before } = await supabase
    .from("trade_entries")
    .select("*")
    .eq("id", id)
    .single();

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

  // Capture after snapshot
  const { data: after } = await supabase
    .from("trade_entries")
    .select("*")
    .eq("id", id)
    .single();

  await logActivity({
    action: "updated",
    entity_type: "trade_entry",
    entity_name: `${input.action.toUpperCase()} ${input.asset_name.trim()}`,
    description: `Updated trade: ${input.action} ${input.quantity} ${input.asset_name.trim()} at ${input.price} ${input.currency ?? "USD"}`,
    entity_id: id,
    entity_table: "trade_entries",
    before_snapshot: before,
    after_snapshot: after,
  });
  revalidatePath("/dashboard/diary");
}

export async function deleteTradeEntry(id: string) {
  const supabase = await createServerSupabaseClient();

  // Capture full snapshot before soft-delete
  const { data: snapshot } = await supabase
    .from("trade_entries")
    .select("*")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("trade_entries")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(error.message);
  const label = snapshot
    ? `${snapshot.action.toUpperCase()} ${snapshot.asset_name}`
    : "Unknown trade";
  await logActivity({
    action: "removed",
    entity_type: "trade_entry",
    entity_name: label,
    description: `Removed trade: ${label}`,
    entity_id: id,
    entity_table: "trade_entries",
    before_snapshot: snapshot,
    after_snapshot: null,
  });
  revalidatePath("/dashboard/diary");
}
