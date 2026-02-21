"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { WalletInput } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";
import {
  findOrCreateInstitution,
  cleanupOrphanedInstitution,
  renameInstitution,
} from "@/lib/actions/institutions";

export async function getWallets() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("wallets")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return data;
}

export async function createWallet(
  input: WalletInput,
  opts?: { also_broker?: boolean; also_bank?: boolean }
) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const trimmedName = input.name.trim();

  // Find or create institution
  const institutionId = await findOrCreateInstitution(trimmedName);

  const { error } = await supabase.from("wallets").insert({
    user_id: user.id,
    name: trimmedName,
    wallet_type: input.wallet_type,
    privacy_label: input.privacy_label ?? null,
    chain: input.chain?.trim() || null,
    institution_id: institutionId,
  });

  if (error) throw new Error(error.message);

  await logActivity({
    action: "created",
    entity_type: "wallet",
    entity_name: trimmedName,
    description: `Added wallet "${trimmedName}"`,
    details: { ...input },
  });

  // Create sibling broker if requested
  if (opts?.also_broker) {
    // Check if broker already exists for this institution
    const { data: existingBroker } = await supabase
      .from("brokers")
      .select("id")
      .eq("institution_id", institutionId)
      .limit(1);

    if (!existingBroker?.length) {
      const { error: brokerErr } = await supabase.from("brokers").insert({
        user_id: user.id,
        name: trimmedName,
        institution_id: institutionId,
      });
      if (!brokerErr) {
        await logActivity({
          action: "created",
          entity_type: "broker",
          entity_name: trimmedName,
          description: `Added broker "${trimmedName}" (via wallet creation)`,
        });
      }
    }
  }

  // Create sibling bank account if requested (with sensible defaults)
  if (opts?.also_bank) {
    const { data: existingBank } = await supabase
      .from("bank_accounts")
      .select("id")
      .eq("institution_id", institutionId)
      .limit(1);

    if (!existingBank?.length) {
      const { error: bankErr } = await supabase.from("bank_accounts").insert({
        user_id: user.id,
        name: trimmedName,
        bank_name: trimmedName,
        region: "GR",
        currency: "EUR",
        balance: 0,
        apy: 0,
        institution_id: institutionId,
      });
      if (!bankErr) {
        await logActivity({
          action: "created",
          entity_type: "bank_account",
          entity_name: trimmedName,
          description: `Added bank account "${trimmedName}" (via wallet creation)`,
        });
      }
    }
  }

  revalidatePath("/dashboard/settings");
  if (opts?.also_bank) revalidatePath("/dashboard/cash");
}

export async function updateWallet(
  id: string,
  input: WalletInput,
  opts?: { also_broker?: boolean; also_bank?: boolean }
) {
  const supabase = await createServerSupabaseClient();
  const trimmedName = input.name.trim();

  // Get current wallet to check for name change
  const { data: current } = await supabase
    .from("wallets")
    .select("name, institution_id")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("wallets")
    .update({
      name: trimmedName,
      wallet_type: input.wallet_type,
      privacy_label: input.privacy_label ?? null,
      chain: input.chain?.trim() || null,
    })
    .eq("id", id);

  if (error) throw new Error(error.message);

  // If name changed and institution is linked, rename the institution
  // (DB trigger will propagate to all siblings)
  if (current?.institution_id && current.name !== trimmedName) {
    await renameInstitution(current.institution_id, trimmedName);
  }

  // Role extension: create sibling broker if requested
  if (opts?.also_broker && current?.institution_id) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: existingBroker } = await supabase
        .from("brokers")
        .select("id")
        .eq("institution_id", current.institution_id)
        .limit(1);

      if (!existingBroker?.length) {
        const { error: brokerErr } = await supabase.from("brokers").insert({
          user_id: user.id,
          name: trimmedName,
          institution_id: current.institution_id,
        });
        if (!brokerErr) {
          await logActivity({
            action: "created",
            entity_type: "broker",
            entity_name: trimmedName,
            description: `Added broker "${trimmedName}" (via wallet edit)`,
          });
        }
      }
    }
  }

  // Role extension: create sibling bank account if requested
  if (opts?.also_bank && current?.institution_id) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: existingBank } = await supabase
        .from("bank_accounts")
        .select("id")
        .eq("institution_id", current.institution_id)
        .limit(1);

      if (!existingBank?.length) {
        const { error: bankErr } = await supabase.from("bank_accounts").insert({
          user_id: user.id,
          name: trimmedName,
          bank_name: trimmedName,
          region: "GR",
          currency: "EUR",
          balance: 0,
          apy: 0,
          institution_id: current.institution_id,
        });
        if (!bankErr) {
          await logActivity({
            action: "created",
            entity_type: "bank_account",
            entity_name: trimmedName,
            description: `Added bank account "${trimmedName}" (via wallet edit)`,
          });
        }
      }
    }
  }

  await logActivity({
    action: "updated",
    entity_type: "wallet",
    entity_name: trimmedName,
    description: `Updated wallet "${trimmedName}"`,
    details: { ...input },
  });
  revalidatePath("/dashboard/settings");
  if (opts?.also_bank) revalidatePath("/dashboard/cash");
}

export async function deleteWallet(id: string) {
  const supabase = await createServerSupabaseClient();
  const { data: existing } = await supabase
    .from("wallets")
    .select("name, institution_id")
    .eq("id", id)
    .single();

  const { error } = await supabase.from("wallets").delete().eq("id", id);

  if (error) throw new Error(error.message);
  await logActivity({
    action: "removed",
    entity_type: "wallet",
    entity_name: existing?.name ?? "Unknown",
    description: `Removed wallet "${existing?.name ?? id}"`,
  });

  // Cleanup orphaned institution
  if (existing?.institution_id) {
    await cleanupOrphanedInstitution(existing.institution_id);
  }

  revalidatePath("/dashboard/settings");
}
