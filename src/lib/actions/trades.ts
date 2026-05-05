"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { TradeEntry, TradeEntryInput } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";
import { validateUUID, validateQuantity, validateAmount, validateCurrency, validateName, validateDate } from "@/lib/validation";
import { partialUpdate } from "@/lib/partial-update";
import { round2 } from "@/lib/format";
import { MAX_NOTES_LENGTH } from "@/lib/constants";
import { captureAction } from "@/lib/actions/with-sentry";

const VALID_ASSET_TYPES = new Set(["crypto", "stock", "cash", "other"]);
const VALID_TRADE_ACTIONS = new Set(["buy", "sell"]);

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
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .order("ticker"),
    supabase
      .from("stock_assets")
      .select("ticker, name, currency")
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .order("ticker"),
    supabase
      .from("cash_accounts")
      .select("currency")
      .eq("user_id", user.id)
      .is("deleted_at", null),
  ]);

  if (cryptoRes.error) throw new Error(`Failed to load crypto assets: ${cryptoRes.error.message}`);
  if (stockRes.error) throw new Error(`Failed to load stock assets: ${stockRes.error.message}`);
  if (cashRes.error) throw new Error(`Failed to load cash accounts: ${cashRes.error.message}`);

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
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("trade_date", { ascending: false });

  if (error) throw new Error(error.message);
  // DB stores action/asset_type as text (constrained by application logic); narrow at boundary
  return (data ?? []).map<TradeEntry>((row) => ({
    ...row,
    action: row.action as TradeEntry["action"],
    asset_type: row.asset_type as TradeEntry["asset_type"],
  }));
}

export async function createTradeEntry(input: TradeEntryInput) {
  return captureAction("trades.createTradeEntry", async () => {
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
  if (!VALID_ASSET_TYPES.has(input.asset_type)) throw new Error(`Invalid asset type: "${input.asset_type}"`);
  if (!VALID_TRADE_ACTIONS.has(input.action)) throw new Error(`Invalid action: "${input.action}"`);

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
    total_value: round2(totalValue),
    notes: input.notes?.trim()?.slice(0, MAX_NOTES_LENGTH) || null,
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
  });
}

export async function updateTradeEntry(id: string, input: TradeEntryInput) {
  return captureAction("trades.updateTradeEntry", async () => {
  validateUUID(id, "Trade entry ID");
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  validateDate(input.trade_date, "Trade date");
  validateName(input.asset_name, 100, "Asset name");
  validateQuantity(input.quantity, "Quantity");
  validateAmount(input.price, "Price");
  if (input.currency) validateCurrency(input.currency);
  if (!VALID_ASSET_TYPES.has(input.asset_type)) throw new Error(`Invalid asset type: "${input.asset_type}"`);
  if (!VALID_TRADE_ACTIONS.has(input.action)) throw new Error(`Invalid action: "${input.action}"`);

  const totalValue = input.quantity * input.price;

  // Capture before snapshot
  const { data: before } = await supabase
    .from("trade_entries")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  // Preserve undefined for fields the caller didn't pass; partialUpdate()
  // will strip them. Explicit null/empty-string is preserved for "clear".
  const normalizedNotes = input.notes !== undefined
    ? (input.notes.trim().slice(0, MAX_NOTES_LENGTH) || null)
    : undefined;

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
      total_value: round2(totalValue),
      notes: normalizedNotes,
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
  });
}

export async function deleteTradeEntry(id: string) {
  return captureAction("trades.deleteTradeEntry", async () => {
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
  });
}
