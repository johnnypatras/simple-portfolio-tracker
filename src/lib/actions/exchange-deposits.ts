"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ExchangeDeposit, ExchangeDepositInput } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";

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

  // Fetch wallet name for logging
  const { data: wallet } = await supabase
    .from("wallets")
    .select("name")
    .eq("id", input.wallet_id)
    .single();

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

  const label = `${input.amount} ${input.currency} on ${wallet?.name ?? "Unknown"}`;
  await logActivity({
    action: "created",
    entity_type: "exchange_deposit",
    entity_name: label,
    description: `Added exchange deposit: ${label}`,
    details: { ...input, wallet_name: wallet?.name },
  });
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
}

export async function updateExchangeDeposit(
  id: string,
  input: ExchangeDepositInput
): Promise<void> {
  const supabase = await createServerSupabaseClient();

  // Fetch wallet name for logging
  const { data: wallet } = await supabase
    .from("wallets")
    .select("name")
    .eq("id", input.wallet_id)
    .single();

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

  const label = `${input.amount} ${input.currency} on ${wallet?.name ?? "Unknown"}`;
  await logActivity({
    action: "updated",
    entity_type: "exchange_deposit",
    entity_name: label,
    description: `Updated exchange deposit: ${label}`,
    details: { ...input, wallet_name: wallet?.name },
  });
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
}

export async function deleteExchangeDeposit(id: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  // Fetch details before deleting
  const { data: existing } = await supabase
    .from("exchange_deposits")
    .select("amount, currency, wallets(name)")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("exchange_deposits")
    .delete()
    .eq("id", id);

  if (error) throw new Error(error.message);
  const walletName =
    (existing?.wallets as unknown as { name: string } | null)?.name ?? "Unknown";
  const label = existing
    ? `${existing.amount} ${existing.currency} on ${walletName}`
    : "Unknown";
  await logActivity({
    action: "removed",
    entity_type: "exchange_deposit",
    entity_name: label,
    description: `Removed exchange deposit: ${label}`,
  });
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
}
