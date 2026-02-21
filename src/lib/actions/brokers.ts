"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { BrokerInput, WalletType, PrivacyLabel } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";
import {
  findOrCreateInstitution,
  cleanupOrphanedInstitution,
  renameInstitution,
} from "@/lib/actions/institutions";

export async function getBrokers() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("brokers")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return data;
}

export async function createBroker(
  input: BrokerInput,
  opts?: {
    also_wallet?: boolean;
    wallet_type?: WalletType;
    wallet_privacy?: PrivacyLabel | null;
    wallet_chain?: string | null;
    also_bank?: boolean;
  }
) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const trimmedName = input.name.trim();
  const institutionId = await findOrCreateInstitution(trimmedName);

  const { error } = await supabase.from("brokers").insert({
    user_id: user.id,
    name: trimmedName,
    institution_id: institutionId,
  });

  if (error) throw new Error(error.message);
  await logActivity({
    action: "created",
    entity_type: "broker",
    entity_name: trimmedName,
    description: `Added broker "${trimmedName}"`,
    details: { name: trimmedName },
  });

  // Create sibling wallet if requested
  if (opts?.also_wallet) {
    const { data: existingWallet } = await supabase
      .from("wallets")
      .select("id")
      .eq("institution_id", institutionId)
      .limit(1);

    if (!existingWallet?.length) {
      const { error: walletErr } = await supabase.from("wallets").insert({
        user_id: user.id,
        name: trimmedName,
        wallet_type: opts.wallet_type ?? "custodial",
        privacy_label: opts.wallet_privacy ?? null,
        chain: opts.wallet_chain?.trim() || null,
        institution_id: institutionId,
      });
      if (!walletErr) {
        await logActivity({
          action: "created",
          entity_type: "wallet",
          entity_name: trimmedName,
          description: `Added wallet "${trimmedName}" (via broker creation)`,
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
          description: `Added bank account "${trimmedName}" (via broker creation)`,
        });
      }
    }
  }

  revalidatePath("/dashboard/settings");
  if (opts?.also_bank) revalidatePath("/dashboard/cash");
}

export async function updateBroker(
  id: string,
  input: BrokerInput,
  opts?: {
    also_wallet?: boolean;
    wallet_type?: WalletType;
    wallet_privacy?: PrivacyLabel | null;
    wallet_chain?: string | null;
    also_bank?: boolean;
  }
) {
  const supabase = await createServerSupabaseClient();
  const trimmedName = input.name.trim();

  const { data: current } = await supabase
    .from("brokers")
    .select("name, institution_id")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("brokers")
    .update({ name: trimmedName })
    .eq("id", id);

  if (error) throw new Error(error.message);

  if (current?.institution_id && current.name !== trimmedName) {
    await renameInstitution(current.institution_id, trimmedName);
  }

  // Role extension: create sibling wallet if requested
  if (opts?.also_wallet && current?.institution_id) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: existingWallet } = await supabase
        .from("wallets")
        .select("id")
        .eq("institution_id", current.institution_id)
        .limit(1);

      if (!existingWallet?.length) {
        const { error: walletErr } = await supabase.from("wallets").insert({
          user_id: user.id,
          name: trimmedName,
          wallet_type: opts.wallet_type ?? "custodial",
          privacy_label: opts.wallet_privacy ?? null,
          chain: opts.wallet_chain?.trim() || null,
          institution_id: current.institution_id,
        });
        if (!walletErr) {
          await logActivity({
            action: "created",
            entity_type: "wallet",
            entity_name: trimmedName,
            description: `Added wallet "${trimmedName}" (via broker edit)`,
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
            description: `Added bank account "${trimmedName}" (via broker edit)`,
          });
        }
      }
    }
  }

  await logActivity({
    action: "updated",
    entity_type: "broker",
    entity_name: trimmedName,
    description: `Updated broker "${trimmedName}"`,
    details: { name: trimmedName },
  });
  revalidatePath("/dashboard/settings");
  if (opts?.also_bank) revalidatePath("/dashboard/cash");
}

export async function deleteBroker(id: string) {
  const supabase = await createServerSupabaseClient();
  const { data: existing } = await supabase
    .from("brokers")
    .select("name, institution_id")
    .eq("id", id)
    .single();

  const { error } = await supabase.from("brokers").delete().eq("id", id);

  if (error) throw new Error(error.message);
  await logActivity({
    action: "removed",
    entity_type: "broker",
    entity_name: existing?.name ?? "Unknown",
    description: `Removed broker "${existing?.name ?? id}"`,
  });

  if (existing?.institution_id) {
    await cleanupOrphanedInstitution(existing.institution_id);
  }

  revalidatePath("/dashboard/settings");
}
