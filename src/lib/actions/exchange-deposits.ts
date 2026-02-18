"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ExchangeDeposit, ExchangeDepositInput } from "@/lib/types";

export async function getExchangeDeposits(): Promise<ExchangeDeposit[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("exchange_deposits")
    .select("*, wallets(name)")
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);

  // Flatten the joined wallet name
  return (data ?? []).map((row) => ({
    id: row.id,
    user_id: row.user_id,
    wallet_id: row.wallet_id,
    wallet_name: (row.wallets as { name: string })?.name ?? "Unknown",
    currency: row.currency,
    amount: row.amount,
    apy: row.apy,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export async function createExchangeDeposit(
  input: ExchangeDepositInput
): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { error } = await supabase.from("exchange_deposits").insert({
    user_id: user.id,
    wallet_id: input.wallet_id,
    currency: input.currency,
    amount: input.amount,
    apy: input.apy ?? 0,
  });

  if (error) {
    // Handle UNIQUE(user_id, wallet_id, currency) violation
    if (error.code === "23505") {
      throw new Error(
        "A deposit with this wallet + currency combination already exists"
      );
    }
    throw new Error(error.message);
  }

  revalidatePath("/dashboard/cash");
}

export async function updateExchangeDeposit(
  id: string,
  input: ExchangeDepositInput
): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("exchange_deposits")
    .update({
      wallet_id: input.wallet_id,
      currency: input.currency,
      amount: input.amount,
      apy: input.apy ?? 0,
    })
    .eq("id", id);

  if (error) {
    if (error.code === "23505") {
      throw new Error(
        "A deposit with this wallet + currency combination already exists"
      );
    }
    throw new Error(error.message);
  }

  revalidatePath("/dashboard/cash");
}

export async function deleteExchangeDeposit(id: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("exchange_deposits")
    .delete()
    .eq("id", id);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/cash");
}
