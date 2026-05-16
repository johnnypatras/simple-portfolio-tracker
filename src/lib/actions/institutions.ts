"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { InstitutionWithRoles, InstitutionRole, PrivacyLabel } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";
import { validateUUID, validateName, validateCurrency } from "@/lib/validation";
import { MAX_LABEL_LENGTH } from "@/lib/constants";
import { captureAction } from "@/lib/actions/with-sentry";
import * as Sentry from "@sentry/nextjs";

/**
 * Fetch all institutions for the current user with computed roles.
 * A role is determined by checking which child tables have records
 * linked via institution_id.
 */
export async function getInstitutionsWithRoles(): Promise<InstitutionWithRoles[]> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  // Fetch institutions and all child records in parallel (exclude soft-deleted)
  // All queries explicitly scoped by user_id for defense-in-depth (on top of RLS).
  const [instRes, walletsRes, brokersRes, banksRes] = await Promise.all([
    supabase.from("institutions").select("*").eq("user_id", user.id).is("deleted_at", null).order("name"),
    supabase.from("wallets").select("institution_id").eq("user_id", user.id).is("deleted_at", null),
    supabase.from("brokers").select("institution_id").eq("user_id", user.id).is("deleted_at", null),
    supabase.from("cash_accounts").select("institution_id").eq("user_id", user.id).is("deleted_at", null),
  ]);

  if (instRes.error) throw new Error(instRes.error.message);

  // Build Sets of institution_ids per role
  const walletInstIds = new Set(
    (walletsRes.data ?? []).map((w) => w.institution_id).filter(Boolean)
  );
  const brokerInstIds = new Set(
    (brokersRes.data ?? []).map((b) => b.institution_id).filter(Boolean)
  );
  const bankInstIds = new Set(
    (banksRes.data ?? []).map((b) => b.institution_id).filter(Boolean)
  );

  return (instRes.data ?? []).map((inst) => {
    const roles: InstitutionRole[] = [];
    if (walletInstIds.has(inst.id)) roles.push("wallet");
    if (brokerInstIds.has(inst.id)) roles.push("broker");
    if (bankInstIds.has(inst.id)) roles.push("bank");
    return { ...inst, roles };
  });
}

/**
 * Find or create an institution by name (exact match) for the current user.
 * Returns the institution id.
 */
export async function findOrCreateInstitution(name: string): Promise<string> {
  return captureAction("institutions.findOrCreateInstitution", async () => {
  const trimmed = name.trim();
  validateName(trimmed, 100, "Institution name");
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Try to find existing (active only)
  const { data: existing } = await supabase
    .from("institutions")
    .select("id")
    .eq("user_id", user.id)
    .eq("name", trimmed)
    .is("deleted_at", null)
    .maybeSingle();

  if (existing) return existing.id;

  // Create new
  const { data: created, error } = await supabase
    .from("institutions")
    .insert({ user_id: user.id, name: trimmed })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return created.id;
  });
}

/**
 * Rename an institution. The DB trigger will propagate the name
 * change to all linked wallets, brokers, and cash_accounts.
 */
export async function renameInstitution(id: string, newName: string): Promise<void> {
  return captureAction("institutions.renameInstitution", async () => {
  validateUUID(id, "Institution ID");
  validateName(newName.trim(), 100, "Institution name");
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { error } = await supabase
    .from("institutions")
    .update({ name: newName.trim() })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) throw new Error(error.message);

  // Refresh entity_name on activity_log for all cash accounts at this institution
  const { refreshCashEntityNames } = await import("@/lib/actions/cash-accounts");
  await refreshCashEntityNames(supabase, user.id, { institution_id: id });
  });
}

/**
 * Update institution-level properties: rename and/or add sibling roles.
 * Called from the institution edit dialog (separate from per-account editing).
 */
export async function updateInstitutionRoles(
  institutionId: string,
  opts: {
    newName?: string;
    country?: string;
    also_wallet?: boolean;
    wallet_privacy?: PrivacyLabel | null;
    wallet_chain?: string | null;
    also_broker?: boolean;
    also_bank?: boolean;
    bank_currency?: string;
  }
): Promise<void> {
  return captureAction("institutions.updateInstitutionRoles", async () => {
  validateUUID(institutionId, "Institution ID");
  if (opts.newName) validateName(opts.newName.trim(), 100, "Institution name");
  if (opts.country !== undefined && opts.country.trim()) validateName(opts.country.trim(), MAX_LABEL_LENGTH, "Country");
  if (opts.bank_currency) validateCurrency(opts.bank_currency);
  if (opts.wallet_chain !== undefined && opts.wallet_chain?.trim()) validateName(opts.wallet_chain.trim(), MAX_LABEL_LENGTH, "Chain");
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data: inst } = await supabase
    .from("institutions")
    .select("*")
    .eq("id", institutionId)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();
  if (!inst) throw new Error("Institution not found");

  const instName = opts.newName?.trim() || inst.name;

  // Rename if changed (DB trigger propagates to wallets, brokers, cash_accounts)
  if (opts.newName && opts.newName.trim() !== inst.name) {
    await renameInstitution(institutionId, opts.newName.trim());
    const { data: afterRename } = await supabase
      .from("institutions")
      .select("*")
      .eq("id", institutionId)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .single();
    await logActivity({
      action: "updated",
      entity_type: "institution",
      entity_name: opts.newName.trim(),
      description: `Renamed institution "${inst.name}" → "${opts.newName.trim()}"`,
      entity_id: institutionId,
      entity_table: "institutions",
      before_snapshot: inst,
      after_snapshot: afterRename,
    });
  }

  // Propagate country to all linked cash accounts
  if (opts.country !== undefined) {
    const { error: regionErr } = await supabase
      .from("cash_accounts")
      .update({ region: opts.country })
      .eq("institution_id", institutionId)
      .eq("user_id", user.id)
      .is("deleted_at", null);
    if (regionErr) {
      console.error(`[institutions] Region propagation failed for "${instName}":`, regionErr.message);
      Sentry.captureException(regionErr, {
        tags: { action: "institutions.updateInstitutionRoles", phase: "region_propagation" },
        extra: { institutionId, country: opts.country },
      });
    }
  }

  // Create sibling wallet if requested
  if (opts.also_wallet) {
    const { data: existing } = await supabase
      .from("wallets")
      .select("id")
      .eq("institution_id", institutionId)
      .is("deleted_at", null)
      .limit(1);

    if (!existing?.length) {
      const { data: walletCreated, error: walletErr } = await supabase.from("wallets").insert({
        user_id: user.id,
        name: instName,
        wallet_type: "custodial",
        privacy_label: opts.wallet_privacy ?? null,
        chain: opts.wallet_chain?.trim() || null,
        institution_id: institutionId,
      }).select("*").single();
      if (walletErr) {
        // Surface to Sentry — the parent action returns success so without
        // this capture the user sees "saved" but no wallet exists.
        console.error(`[institutions] Sibling wallet creation failed for "${instName}":`, walletErr.message);
        Sentry.captureException(walletErr, {
          tags: { action: "institutions.updateInstitutionRoles", phase: "sibling_wallet" },
          extra: { institutionId, instName },
        });
      } else if (walletCreated) {
        await logActivity({
          action: "created",
          entity_type: "wallet",
          entity_name: instName,
          description: `Added wallet "${instName}" (via institution edit)`,
          entity_id: walletCreated.id,
          entity_table: "wallets",
          before_snapshot: null,
          after_snapshot: walletCreated,
        });
      }
    }
  }

  // Create sibling broker if requested
  if (opts.also_broker) {
    const { data: existing } = await supabase
      .from("brokers")
      .select("id")
      .eq("institution_id", institutionId)
      .is("deleted_at", null)
      .limit(1);

    if (!existing?.length) {
      const { data: brokerCreated, error: brokerErr } = await supabase.from("brokers").insert({
        user_id: user.id,
        name: instName,
        institution_id: institutionId,
      }).select("*").single();
      if (brokerErr) {
        // Surface to Sentry — see sibling-wallet comment above.
        console.error(`[institutions] Sibling broker creation failed for "${instName}":`, brokerErr.message);
        Sentry.captureException(brokerErr, {
          tags: { action: "institutions.updateInstitutionRoles", phase: "sibling_broker" },
          extra: { institutionId, instName },
        });
      } else if (brokerCreated) {
        await logActivity({
          action: "created",
          entity_type: "broker",
          entity_name: instName,
          description: `Added broker "${instName}" (via institution edit)`,
          entity_id: brokerCreated.id,
          entity_table: "brokers",
          before_snapshot: null,
          after_snapshot: brokerCreated,
        });
      }
    }
  }

  // Create sibling cash account if requested
  if (opts.also_bank) {
    const { data: existing } = await supabase
      .from("cash_accounts")
      .select("id")
      .eq("institution_id", institutionId)
      .eq("currency", opts.bank_currency ?? "EUR")
      .is("deleted_at", null)
      .limit(1);

    if (!existing?.length) {
      const { createCashAccount } = await import("@/lib/actions/cash-accounts");
      await createCashAccount({
        institution_id: institutionId,
        name: instName,
        currency: opts.bank_currency ?? "EUR",
        balance: 0,
      });
    }
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/accounts");
  revalidatePath("/dashboard/cash");
  });
}

/**
 * Remove a specific role from an institution.
 * Soft-deletes all linked wallets or brokers (cascade trigger handles children).
 * If no roles remain, the institution itself is cleaned up.
 */
export async function removeInstitutionRole(
  institutionId: string,
  role: "wallet" | "broker" | "bank",
  opts?: { isAdjustment?: boolean }
): Promise<void> {
  return captureAction("institutions.removeInstitutionRole", async () => {
  validateUUID(institutionId, "Institution ID");
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  if (role === "wallet") {
    const { data: wallets } = await supabase
      .from("wallets")
      .select("id")
      .eq("institution_id", institutionId)
      .eq("user_id", user.id)
      .is("deleted_at", null);

    if (wallets?.length) {
      const { deleteWallet } = await import("@/lib/actions/wallets");
      await Promise.all(wallets.map((w) => deleteWallet(w.id, opts)));
    }
  } else if (role === "broker") {
    const { data: brokers } = await supabase
      .from("brokers")
      .select("id")
      .eq("institution_id", institutionId)
      .eq("user_id", user.id)
      .is("deleted_at", null);

    if (brokers?.length) {
      const { deleteBroker } = await import("@/lib/actions/brokers");
      await Promise.all(brokers.map((b) => deleteBroker(b.id, opts)));
    }
  } else if (role === "bank") {
    const { data: banks } = await supabase
      .from("cash_accounts")
      .select("id")
      .eq("institution_id", institutionId)
      .eq("user_id", user.id)
      .is("deleted_at", null);

    if (banks?.length) {
      const { deleteCashAccount } = await import("@/lib/actions/cash-accounts");
      await Promise.all(banks.map((ba) => deleteCashAccount(ba.id, opts)));
    }
  }

  // Institution persists even if empty — user can delete it explicitly via the edit modal
  revalidatePath("/dashboard/accounts");
  revalidatePath("/dashboard/cash");
  });
}

/**
 * Delete an institution and all its children (cascade trigger handles soft-deletes).
 */
export async function deleteInstitution(institutionId: string, opts?: { isAdjustment?: boolean }): Promise<void> {
  return captureAction("institutions.deleteInstitution", async () => {
  validateUUID(institutionId, "Institution ID");
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data: inst } = await supabase
    .from("institutions")
    .select("*")
    .eq("id", institutionId)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();
  if (!inst) throw new Error("Institution not found");

  // Explicitly delete children before soft-deleting institution so each gets logged
  const [
    { data: instWallets },
    { data: instBrokers },
    { data: instCashAccounts },
  ] = await Promise.all([
    supabase.from("wallets").select("id").eq("institution_id", institutionId).is("deleted_at", null),
    supabase.from("brokers").select("id").eq("institution_id", institutionId).is("deleted_at", null),
    supabase.from("cash_accounts").select("id").eq("institution_id", institutionId).is("deleted_at", null),
  ]);

  const { deleteWallet } = await import("@/lib/actions/wallets");
  const { deleteBroker } = await import("@/lib/actions/brokers");
  const { deleteCashAccount } = await import("@/lib/actions/cash-accounts");

  await Promise.all([
    ...(instWallets ?? []).map((w) => deleteWallet(w.id, opts)),
    ...(instBrokers ?? []).map((b) => deleteBroker(b.id, opts)),
    ...(instCashAccounts ?? []).map((ca) => deleteCashAccount(ca.id, opts)),
  ]);

  const { error } = await supabase
    .from("institutions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", institutionId)
    .eq("user_id", user.id);

  if (error) throw new Error(error.message);

  await logActivity({
    action: "removed",
    entity_type: "institution",
    entity_name: inst.name,
    description: `Deleted institution "${inst.name}" and all linked accounts`,
    entity_id: institutionId,
    entity_table: "institutions",
    before_snapshot: inst,
    after_snapshot: null,
  });

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/accounts");
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard/crypto");
  revalidatePath("/dashboard/stocks");
  });
}
