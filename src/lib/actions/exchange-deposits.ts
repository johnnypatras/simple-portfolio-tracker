"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ExchangeDeposit } from "@/lib/types";

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
