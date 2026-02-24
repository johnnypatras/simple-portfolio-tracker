"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { InstitutionWithRoles, InstitutionRole, WalletType, PrivacyLabel } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";

/**
 * Fetch all institutions for the current user with computed roles.
 * A role is determined by checking which child tables have records
 * linked via institution_id.
 */
export async function getInstitutionsWithRoles(): Promise<InstitutionWithRoles[]> {
  const supabase = await createServerSupabaseClient();

  // Fetch institutions and all child records in parallel
  const [instRes, walletsRes, brokersRes, banksRes] = await Promise.all([
    supabase.from("institutions").select("*").order("name"),
    supabase.from("wallets").select("institution_id"),
    supabase.from("brokers").select("institution_id"),
    supabase.from("bank_accounts").select("institution_id"),
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

  // Try to find existing
  const { data: existing } = await supabase
    .from("institutions")
    .select("id")
    .eq("user_id", user.id)
    .eq("name", trimmed)
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
 * Check if an institution has any remaining linked records.
 * If orphaned, delete it.
 */
export async function cleanupOrphanedInstitution(institutionId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();

  const [w, b, ba] = await Promise.all([
    supabase.from("wallets").select("id").eq("institution_id", institutionId).limit(1),
    supabase.from("brokers").select("id").eq("institution_id", institutionId).limit(1),
    supabase.from("bank_accounts").select("id").eq("institution_id", institutionId).limit(1),
  ]);

  const hasChildren =
    (w.data?.length ?? 0) > 0 ||
    (b.data?.length ?? 0) > 0 ||
    (ba.data?.length ?? 0) > 0;

  if (!hasChildren) {
    await supabase.from("institutions").delete().eq("id", institutionId);
  }
}

/**
 * Rename an institution. The DB trigger will propagate the name
 * change to all linked wallets, brokers, and bank_accounts.
 */
export async function renameInstitution(id: string, newName: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("institutions")
    .update({ name: newName.trim() })
    .eq("id", id);

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
    wallet_type?: WalletType;
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
    .select("name")
    .eq("id", institutionId)
    .single();
  if (!inst) throw new Error("Institution not found");

  const instName = opts.newName?.trim() || inst.name;

  // Rename if changed (DB trigger propagates to wallets, brokers, bank_accounts)
  if (opts.newName && opts.newName.trim() !== inst.name) {
    await renameInstitution(institutionId, opts.newName.trim());
    await logActivity({
      action: "updated",
      entity_type: "institution",
      entity_name: opts.newName.trim(),
      description: `Renamed institution "${inst.name}" → "${opts.newName.trim()}"`,
    });
  }

  // Propagate country to all linked bank accounts
  if (opts.country !== undefined) {
    await supabase
      .from("bank_accounts")
      .update({ region: opts.country })
      .eq("institution_id", institutionId);
  }

  // Create sibling wallet if requested
  if (opts.also_wallet) {
    const { data: existing } = await supabase
      .from("wallets")
      .select("id")
      .eq("institution_id", institutionId)
      .limit(1);

    if (!existing?.length) {
      const { error: walletErr } = await supabase.from("wallets").insert({
        user_id: user.id,
        name: instName,
        wallet_type: opts.wallet_type ?? "custodial",
        privacy_label: opts.wallet_privacy ?? null,
        chain: opts.wallet_chain?.trim() || null,
        institution_id: institutionId,
      });
      if (!walletErr) {
        await logActivity({
          action: "created",
          entity_type: "wallet",
          entity_name: instName,
          description: `Added wallet "${instName}" (via institution edit)`,
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
      .limit(1);

    if (!existing?.length) {
      const { error: brokerErr } = await supabase.from("brokers").insert({
        user_id: user.id,
        name: instName,
        institution_id: institutionId,
      });
      if (!brokerErr) {
        await logActivity({
          action: "created",
          entity_type: "broker",
          entity_name: instName,
          description: `Added broker "${instName}" (via institution edit)`,
        });
      }
    }
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/accounts");
  revalidatePath("/dashboard/cash");
}
