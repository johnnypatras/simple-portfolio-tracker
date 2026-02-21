"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { Profile, Currency } from "@/lib/types";

/** Fetch the current user's profile. */
export async function getProfile(): Promise<Profile> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (error) throw new Error(error.message);
  return data as Profile;
}

/** Update the current user's profile (display name, currency). */
export async function updateProfile(input: {
  display_name?: string | null;
  primary_currency?: Currency;
}): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { error } = await supabase
    .from("profiles")
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq("id", user.id);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

/**
 * Delete all portfolio data for the current user.
 * Keeps the account and profile intact.
 * Only targets tables with user_id — child tables (positions, goal_prices)
 * are cleaned up automatically via ON DELETE CASCADE.
 */
export async function clearAllData(): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Tables with user_id column, in safe deletion order.
  // crypto_positions, stock_positions, goal_prices cascade from their parents.
  const tables = [
    "activity_log",
    "portfolio_snapshots",
    "diary_entries",
    "trade_entries",
    "exchange_deposits",
    "stock_assets",
    "crypto_assets",
    "bank_accounts",
    "brokers",
    "wallets",
  ];

  for (const table of tables) {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq("user_id", user.id);
    if (error) throw new Error(`Failed to clear ${table}: ${error.message}`);
  }

  revalidatePath("/dashboard");
}

/**
 * Delete the current user's account entirely.
 * Uses the Supabase admin auth.admin.deleteUser via an RPC function,
 * or signs out and deletes profile (cascade handles the rest).
 */
export async function deleteAccount(): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Delete profile — CASCADE will remove all user data
  const { error } = await supabase
    .from("profiles")
    .delete()
    .eq("id", user.id);

  if (error) throw new Error(error.message);

  // Sign out the user
  await supabase.auth.signOut();
}
