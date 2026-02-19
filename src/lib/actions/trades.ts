"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { TradeEntry, TradeEntryInput } from "@/lib/types";

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
