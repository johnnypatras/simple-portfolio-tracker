"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { TradeEntry, TradeEntryInput } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";
import { validateUUID, validateQuantity, validateAmount, validateCurrency, validateName, validateDate } from "@/lib/validation";
import { partialUpdate } from "@/lib/partial-update";

/** Lightweight asset name lists for the trade diary dropdown */
export async function getAssetOptions(): Promise<{
  crypto: { ticker: string; name: string }[];
  stock: { ticker: string; name: string; currency: string }[];
  cash: string[];
}> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const [cryptoRes, stockRes, cashRes] = await Promise.all([
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
      .from("cash_accounts")
      .select("currency")
      .is("deleted_at", null),
  ]);

  // Deduplicate cash currencies into a sorted list
  const cashCurrencies = [
    ...new Set((cashRes.data ?? []).map((c) => c.currency as string)),
  ].sort();

  return {
    crypto: cryptoRes.data ?? [],
    stock: stockRes.data ?? [],
    cash: cashCurrencies,
  };
}

export async function getTradeEntries(): Promise<TradeEntry[]> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
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

  validateDate(input.trade_date, "Trade date");
  validateName(input.asset_name, 100, "Asset name");
  validateQuantity(input.quantity, "Quantity");
  validateAmount(input.price, "Price");
  if (input.currency) validateCurrency(input.currency);

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
    notes: input.notes?.trim()?.slice(0, 2000) || null,
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
  validateUUID(id, "Trade entry ID");
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  validateDate(input.trade_date, "Trade date");
  validateName(input.asset_name, 100, "Asset name");
  validateQuantity(input.quantity, "Quantity");
  validateAmount(input.price, "Price");
  if (input.currency) validateCurrency(input.currency);

  const totalValue = input.quantity * input.price;

  // Capture before snapshot
  const { data: before } = await supabase
    .from("trade_entries")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("trade_entries")
    .update(partialUpdate({
      trade_date: input.trade_date,
      asset_type: input.asset_type,
      asset_name: input.asset_name.trim(),
      action: input.action,
      quantity: input.quantity,
      price: input.price,
      currency: input.currency,
      total_value: Math.round(totalValue * 100) / 100,
      notes: input.notes?.trim()?.slice(0, 2000) || null,
    }))
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) throw new Error(error.message);

  // Capture after snapshot
  const { data: after } = await supabase
    .from("trade_entries")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
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
  validateUUID(id, "Trade entry ID");
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Capture full snapshot before soft-delete
  const { data: snapshot } = await supabase
    .from("trade_entries")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("trade_entries")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);

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
