"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { WalletInput } from "@/lib/types";
import { DEFAULT_COUNTRY } from "@/lib/constants";
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
    .is("deleted_at", null)
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

  const { data: created, error } = await supabase.from("wallets").insert({
    user_id: user.id,
    name: trimmedName,
    wallet_type: input.wallet_type,
    privacy_label: input.privacy_label ?? null,
    chain: input.chain?.trim() || null,
    institution_id: institutionId,
  }).select("*").single();

  if (error) throw new Error(error.message);

  await logActivity({
    action: "created",
    entity_type: "wallet",
    entity_name: trimmedName,
    description: `Added wallet "${trimmedName}"`,
    entity_id: created?.id,
    entity_table: "wallets",
    before_snapshot: null,
    after_snapshot: created,
  });

  // Create sibling broker if requested
  if (opts?.also_broker) {
    // Check if broker already exists for this institution
    const { data: existingBroker } = await supabase
      .from("brokers")
      .select("id")
      .eq("institution_id", institutionId)
      .is("deleted_at", null)
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
      .is("deleted_at", null)
      .limit(1);

    if (!existingBank?.length) {
      const { error: bankErr } = await supabase.from("bank_accounts").insert({
        user_id: user.id,
        name: trimmedName,
        bank_name: trimmedName,
        region: DEFAULT_COUNTRY,
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
  revalidatePath("/dashboard/accounts");
  if (opts?.also_bank) revalidatePath("/dashboard/cash");
}

export async function updateWallet(
  id: string,
  input: WalletInput,
  opts?: { also_broker?: boolean; also_bank?: boolean }
) {
  const supabase = await createServerSupabaseClient();
  const trimmedName = input.name.trim();

  // Capture before snapshot
  const { data: before } = await supabase
    .from("wallets")
    .select("*")
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
  if (before?.institution_id && before.name !== trimmedName) {
    await renameInstitution(before.institution_id, trimmedName);
  }

  // Role extension: create sibling broker if requested
  if (opts?.also_broker && before?.institution_id) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: existingBroker } = await supabase
        .from("brokers")
        .select("id")
        .eq("institution_id", before.institution_id)
        .is("deleted_at", null)
        .limit(1);

      if (!existingBroker?.length) {
        const { error: brokerErr } = await supabase.from("brokers").insert({
          user_id: user.id,
          name: trimmedName,
          institution_id: before.institution_id,
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
  if (opts?.also_bank && before?.institution_id) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: existingBank } = await supabase
        .from("bank_accounts")
        .select("id")
        .eq("institution_id", before.institution_id)
        .is("deleted_at", null)
        .limit(1);

      if (!existingBank?.length) {
        const { error: bankErr } = await supabase.from("bank_accounts").insert({
          user_id: user.id,
          name: trimmedName,
          bank_name: trimmedName,
          region: DEFAULT_COUNTRY,
          currency: "EUR",
          balance: 0,
          apy: 0,
          institution_id: before.institution_id,
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

  // Capture after snapshot
  const { data: after } = await supabase
    .from("wallets")
    .select("*")
    .eq("id", id)
    .single();

  await logActivity({
    action: "updated",
    entity_type: "wallet",
    entity_name: trimmedName,
    description: `Updated wallet "${trimmedName}"`,
    entity_id: id,
    entity_table: "wallets",
    before_snapshot: before,
    after_snapshot: after,
  });
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/accounts");
  if (opts?.also_bank) revalidatePath("/dashboard/cash");
}

export async function deleteWallet(id: string) {
  const supabase = await createServerSupabaseClient();

  // Capture full snapshot before soft-delete
  const { data: snapshot } = await supabase
    .from("wallets")
    .select("*")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("wallets")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(error.message);
  await logActivity({
    action: "removed",
    entity_type: "wallet",
    entity_name: snapshot?.name ?? "Unknown",
    description: `Removed wallet "${snapshot?.name ?? id}"`,
    entity_id: id,
    entity_table: "wallets",
    before_snapshot: snapshot,
    after_snapshot: null,
  });

  // Cleanup orphaned institution (checks active children only)
  if (snapshot?.institution_id) {
    await cleanupOrphanedInstitution(snapshot.institution_id);
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/accounts");
}
