"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { BankAccountInput } from "@/lib/types";

export async function getBankAccounts() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("bank_accounts")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return data;
}

export async function createBankAccount(input: BankAccountInput) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { error } = await supabase.from("bank_accounts").insert({
    user_id: user.id,
    name: input.name.trim(),
    bank_name: input.bank_name.trim(),
    region: input.region ?? "EU",
    currency: input.currency ?? "EUR",
    balance: input.balance ?? 0,
    apy: input.apy ?? 0,
  });

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/cash");
}

export async function updateBankAccount(id: string, input: BankAccountInput) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("bank_accounts")
    .update({
      name: input.name.trim(),
      bank_name: input.bank_name.trim(),
      region: input.region ?? "EU",
      currency: input.currency ?? "EUR",
      balance: input.balance ?? 0,
      apy: input.apy ?? 0,
    })
    .eq("id", id);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/cash");
}

export async function deleteBankAccount(id: string) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("bank_accounts").delete().eq("id", id);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/cash");
}
