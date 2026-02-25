"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { InstitutionWithRoles, InstitutionRole, PrivacyLabel } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";

/**
 * Fetch all institutions for the current user with computed roles.
 * A role is determined by checking which child tables have records
 * linked via institution_id.
 */
export async function getInstitutionsWithRoles(): Promise<InstitutionWithRoles[]> {
  const supabase = await createServerSupabaseClient();

  // Fetch institutions and all child records in parallel (exclude soft-deleted)
  const [instRes, walletsRes, brokersRes, banksRes] = await Promise.all([
    supabase.from("institutions").select("*").is("deleted_at", null).order("name"),
    supabase.from("wallets").select("institution_id").is("deleted_at", null),
    supabase.from("brokers").select("institution_id").is("deleted_at", null),
    supabase.from("bank_accounts").select("institution_id").is("deleted_at", null),
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
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const trimmed = name.trim();

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
}

/**
 * Check if an institution has any remaining active linked records.
 * If orphaned, soft-delete it.
 */
export async function cleanupOrphanedInstitution(institutionId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Only count active (non-soft-deleted) children
  const [w, b, ba] = await Promise.all([
    supabase.from("wallets").select("id").eq("institution_id", institutionId).is("deleted_at", null).limit(1),
    supabase.from("brokers").select("id").eq("institution_id", institutionId).is("deleted_at", null).limit(1),
    supabase.from("bank_accounts").select("id").eq("institution_id", institutionId).is("deleted_at", null).limit(1),
  ]);

  const hasChildren =
    (w.data?.length ?? 0) > 0 ||
    (b.data?.length ?? 0) > 0 ||
    (ba.data?.length ?? 0) > 0;

  if (!hasChildren) {
    await supabase
      .from("institutions")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", institutionId)
      .eq("user_id", user.id);
  }
}

/**
 * Rename an institution. The DB trigger will propagate the name
 * change to all linked wallets, brokers, and bank_accounts.
 */
export async function renameInstitution(id: string, newName: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { error } = await supabase
    .from("institutions")
    .update({ name: newName.trim() })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) throw new Error(error.message);
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
  }
): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data: inst } = await supabase
    .from("institutions")
    .select("*")
    .eq("id", institutionId)
    .is("deleted_at", null)
    .single();
  if (!inst) throw new Error("Institution not found");

  const instName = opts.newName?.trim() || inst.name;

  // Rename if changed (DB trigger propagates to wallets, brokers, bank_accounts)
  if (opts.newName && opts.newName.trim() !== inst.name) {
    await renameInstitution(institutionId, opts.newName.trim());
    const { data: afterRename } = await supabase
      .from("institutions")
      .select("*")
      .eq("id", institutionId)
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

  // Propagate country to all linked bank accounts
  if (opts.country !== undefined) {
    await supabase
      .from("bank_accounts")
      .update({ region: opts.country })
      .eq("institution_id", institutionId)
      .is("deleted_at", null);
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
      if (!walletErr && walletCreated) {
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
      if (!brokerErr && brokerCreated) {
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

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/accounts");
  revalidatePath("/dashboard/cash");
}

/**
 * Remove a specific role from an institution.
 * Soft-deletes all linked wallets or brokers (cascade trigger handles children).
 * If no roles remain, the institution itself is cleaned up.
 */
export async function removeInstitutionRole(
  institutionId: string,
  role: "wallet" | "broker"
): Promise<void> {
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
      .is("deleted_at", null);

    if (wallets?.length) {
      const { deleteWallet } = await import("@/lib/actions/wallets");
      for (const w of wallets) {
        await deleteWallet(w.id);
      }
    }
  } else if (role === "broker") {
    const { data: brokers } = await supabase
      .from("brokers")
      .select("id")
      .eq("institution_id", institutionId)
      .is("deleted_at", null);

    if (brokers?.length) {
      const { deleteBroker } = await import("@/lib/actions/brokers");
      for (const b of brokers) {
        await deleteBroker(b.id);
      }
    }
  }

  // cleanupOrphanedInstitution is already called inside deleteWallet/deleteBroker
  revalidatePath("/dashboard/accounts");
  revalidatePath("/dashboard/cash");
}

/**
 * Delete an institution and all its children (cascade trigger handles soft-deletes).
 */
export async function deleteInstitution(institutionId: string): Promise<void> {
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

  const { error } = await supabase
    .from("institutions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", institutionId);

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
}
