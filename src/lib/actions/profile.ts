"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Profile, BaseCurrency } from "@/lib/types";

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

/** Update the current user's profile fields. */
export async function updateProfile(input: {
  first_name?: string | null;
  last_name?: string | null;
  display_name?: string | null;
  primary_currency?: BaseCurrency;
  theme?: string | null;
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

  // All user-owned tables in safe deletion order (children before parents).
  // crypto_positions, stock_positions, goal_prices cascade from their parents.
  const tablesWithUserId = [
    "activity_log",
    "portfolio_snapshots",
    "diary_entries",
    "trade_entries",
    "exchange_deposits",
    "broker_deposits",
    "stock_assets",
    "crypto_assets",
    "bank_accounts",
    "brokers",
    "wallets",
    "institutions",
  ];

  for (const table of tablesWithUserId) {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq("user_id", user.id);
    if (error) throw new Error(`Failed to clear ${table}: ${error.message}`);
  }

  // portfolio_shares uses owner_id instead of user_id
  const { error: sharesErr } = await supabase
    .from("portfolio_shares")
    .delete()
    .eq("owner_id", user.id);
  if (sharesErr) throw new Error(`Failed to clear portfolio_shares: ${sharesErr.message}`);

  revalidatePath("/dashboard");
}

/**
 * Delete the current user's account entirely.
 * Uses service-role admin client to delete from auth.users,
 * which cascades to profiles and all portfolio data via ON DELETE CASCADE.
 */
export async function deleteAccount(): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Delete from auth.users via admin API — cascades to all data tables.
  // This must happen BEFORE signOut: if deleteUser fails, the user
  // can still log in and retry. Reversing the order would lock them out.
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) throw new Error(`Account deletion failed: ${error.message}`);

  // Clean up client session. Non-critical — the user is already deleted,
  // so any future getUser() call would fail regardless.
  await supabase.auth.signOut().catch(() => {});
}

/**
 * Request an email change for the current user.
 * Supabase sends a verification link to the new address automatically.
 */
export async function changeEmail(newEmail: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { error } = await supabase.auth.updateUser({ email: newEmail });
  if (error) throw new Error(error.message);
}

/**
 * Change the current user's password.
 * Requires the current password for verification.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) throw new Error("Not authenticated");

  // Verify current password
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: currentPassword,
  });
  if (signInError) throw new Error("Current password is incorrect");

  // Apply new password
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
}
