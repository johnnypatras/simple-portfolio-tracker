"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Profile, BaseCurrency } from "@/lib/types";
import { partialUpdate } from "@/lib/partial-update";
import { validateName } from "@/lib/validation";
import { VALID_THEMES } from "@/lib/constants";
import { captureAction } from "@/lib/actions/with-sentry";

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
  return captureAction("profile.updateProfile", async () => {
  // Validate string fields
  if (input.first_name) validateName(input.first_name, 100, "First name");
  if (input.last_name) validateName(input.last_name, 100, "Last name");
  if (input.display_name) validateName(input.display_name, 100, "Display name");
  if (input.primary_currency && !["USD", "EUR"].includes(input.primary_currency)) {
    throw new Error("Invalid currency. Must be USD or EUR.");
  }
  if (input.theme && !(VALID_THEMES as readonly string[]).includes(input.theme)) {
    throw new Error("Invalid theme.");
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { error } = await supabase
    .from("profiles")
    .update(partialUpdate({ ...input, updated_at: new Date().toISOString() }))
    .eq("id", user.id);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
  });
}

/**
 * Delete all portfolio data for the current user.
 * Keeps the account and profile intact.
 * Only targets tables with user_id — child tables (positions, goal_prices)
 * are cleaned up automatically via ON DELETE CASCADE.
 */
export async function clearAllData(): Promise<void> {
  return captureAction("profile.clearAllData", async () => {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Delete in parallel batches respecting FK ordering.
  // crypto_positions, stock_positions, goal_prices cascade from their parents.

  // Batch 1: leaf tables (no FK dependents)
  const batch1Results = await Promise.all([
    supabase.from("activity_log").delete().eq("user_id", user.id),
    supabase.from("portfolio_snapshots").delete().eq("user_id", user.id),
    supabase.from("diary_entries").delete().eq("user_id", user.id),
    supabase.from("trade_entries").delete().eq("user_id", user.id),
  ]);
  for (const { error } of batch1Results) {
    if (error) throw new Error(`Failed to clear leaf tables: ${error.message}`);
  }

  // Batch 2: tables with cascade-deleted children
  const batch2Results = await Promise.all([
    supabase.from("cash_accounts").delete().eq("user_id", user.id),
    supabase.from("stock_assets").delete().eq("user_id", user.id),
    supabase.from("crypto_assets").delete().eq("user_id", user.id),
  ]);
  for (const { error } of batch2Results) {
    if (error) throw new Error(`Failed to clear asset tables: ${error.message}`);
  }

  // Batch 3: infrastructure tables
  const batch3Results = await Promise.all([
    supabase.from("brokers").delete().eq("user_id", user.id),
    supabase.from("wallets").delete().eq("user_id", user.id),
  ]);
  for (const { error } of batch3Results) {
    if (error) throw new Error(`Failed to clear infrastructure tables: ${error.message}`);
  }

  // Batch 4: root table
  const { error: instErr } = await supabase.from("institutions").delete().eq("user_id", user.id);
  if (instErr) throw new Error(`Failed to clear institutions: ${instErr.message}`);

  // portfolio_shares uses owner_id instead of user_id
  const { error: sharesErr } = await supabase
    .from("portfolio_shares")
    .delete()
    .eq("owner_id", user.id);
  if (sharesErr) throw new Error(`Failed to clear portfolio_shares: ${sharesErr.message}`);

  revalidatePath("/dashboard");
  });
}

/**
 * Delete the current user's account entirely.
 * Uses service-role admin client to delete from auth.users,
 * which cascades to profiles and all portfolio data via ON DELETE CASCADE.
 */
export async function deleteAccount(): Promise<void> {
  return captureAction("profile.deleteAccount", async () => {
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
  });
}

/**
 * Request an email change for the current user.
 * Supabase sends a verification link to the new address automatically.
 */
export async function changeEmail(newEmail: string): Promise<void> {
  return captureAction("profile.changeEmail", async () => {
  const trimmed = newEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new Error("Invalid email address");
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  if (user.email === trimmed) {
    throw new Error("New email is the same as current email");
  }

  const { error } = await supabase.auth.updateUser({ email: trimmed });
  if (error) throw new Error(error.message);
  });
}

/**
 * Change the current user's password.
 * Requires the current password for verification.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<void> {
  return captureAction("profile.changePassword", async () => {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) throw new Error("Not authenticated");

  if (typeof currentPassword !== "string" || currentPassword.length < 1 || currentPassword.length > 72) {
    throw new Error("Invalid password");
  }
  if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 72) {
    throw new Error("New password must be 8-72 characters");
  }

  if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    throw new Error("Password must include uppercase, lowercase, and a number");
  }

  // Verify current password (after all validation — avoids wasting a network round-trip)
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: currentPassword,
  });
  if (signInError) throw new Error("Current password is incorrect");

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
  });
}
