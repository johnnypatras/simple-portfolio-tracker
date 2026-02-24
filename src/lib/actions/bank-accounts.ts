"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { BankAccountInput, WalletType, PrivacyLabel } from "@/lib/types";
import { DEFAULT_COUNTRY } from "@/lib/constants";
import { logActivity } from "@/lib/actions/activity-log";
import {
  findOrCreateInstitution,
  cleanupOrphanedInstitution,
  renameInstitution,
} from "@/lib/actions/institutions";

export async function getBankAccounts() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("bank_accounts")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return data;
}

export async function createBankAccount(
  input: BankAccountInput,
  opts?: {
    also_wallet?: boolean;
    wallet_type?: WalletType;
    wallet_privacy?: PrivacyLabel | null;
    wallet_chain?: string | null;
    also_broker?: boolean;
  }
) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const trimmedBankName = input.bank_name.trim();
  const institutionId = await findOrCreateInstitution(trimmedBankName);

  const { error } = await supabase.from("bank_accounts").insert({
    user_id: user.id,
    name: input.name.trim(),
    bank_name: trimmedBankName,
    region: input.country ?? DEFAULT_COUNTRY,
    currency: input.currency ?? "EUR",
    balance: input.balance ?? 0,
    apy: input.apy ?? 0,
    institution_id: institutionId,
  });

  if (error) throw new Error(error.message);
  await logActivity({
    action: "created",
    entity_type: "bank_account",
    entity_name: `${input.name.trim()} (${trimmedBankName})`,
    description: `Added bank account "${input.name.trim()}" at ${trimmedBankName}`,
    details: { ...input },
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
        name: trimmedBankName,
        wallet_type: opts.wallet_type ?? "custodial",
        privacy_label: opts.wallet_privacy ?? null,
        chain: opts.wallet_chain?.trim() || null,
        institution_id: institutionId,
      });
      if (!walletErr) {
        await logActivity({
          action: "created",
          entity_type: "wallet",
          entity_name: trimmedBankName,
          description: `Added wallet "${trimmedBankName}" (via bank creation)`,
        });
      }
    }
  }

  // Create sibling broker if requested
  if (opts?.also_broker) {
    const { data: existingBroker } = await supabase
      .from("brokers")
      .select("id")
      .eq("institution_id", institutionId)
      .limit(1);

    if (!existingBroker?.length) {
      const { error: brokerErr } = await supabase.from("brokers").insert({
        user_id: user.id,
        name: trimmedBankName,
        institution_id: institutionId,
      });
      if (!brokerErr) {
        await logActivity({
          action: "created",
          entity_type: "broker",
          entity_name: trimmedBankName,
          description: `Added broker "${trimmedBankName}" (via bank creation)`,
        });
      }
    }
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
}

export async function updateBankAccount(
  id: string,
  input: BankAccountInput,
  opts?: {
    also_wallet?: boolean;
    wallet_type?: WalletType;
    wallet_privacy?: PrivacyLabel | null;
    wallet_chain?: string | null;
    also_broker?: boolean;
  }
) {
  const supabase = await createServerSupabaseClient();
  const trimmedBankName = input.bank_name.trim();

  const { data: current } = await supabase
    .from("bank_accounts")
    .select("bank_name, institution_id")
    .eq("id", id)
    .single();

  const updateFields: Record<string, unknown> = {
    name: input.name.trim(),
    bank_name: trimmedBankName,
    currency: input.currency ?? "EUR",
    balance: input.balance ?? 0,
    apy: input.apy ?? 0,
  };
  if (input.country !== undefined) updateFields.region = input.country;

  const { error } = await supabase
    .from("bank_accounts")
    .update(updateFields)
    .eq("id", id);

  if (error) throw new Error(error.message);

  // If bank_name changed and institution linked, rename institution
  if (current?.institution_id && current.bank_name !== trimmedBankName) {
    await renameInstitution(current.institution_id, trimmedBankName);
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
          name: trimmedBankName,
          wallet_type: opts.wallet_type ?? "custodial",
          privacy_label: opts.wallet_privacy ?? null,
          chain: opts.wallet_chain?.trim() || null,
          institution_id: current.institution_id,
        });
        if (!walletErr) {
          await logActivity({
            action: "created",
            entity_type: "wallet",
            entity_name: trimmedBankName,
            description: `Added wallet "${trimmedBankName}" (via bank edit)`,
          });
        }
      }
    }
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
          name: trimmedBankName,
          institution_id: current.institution_id,
        });
        if (!brokerErr) {
          await logActivity({
            action: "created",
            entity_type: "broker",
            entity_name: trimmedBankName,
            description: `Added broker "${trimmedBankName}" (via bank edit)`,
          });
        }
      }
    }
  }

  await logActivity({
    action: "updated",
    entity_type: "bank_account",
    entity_name: `${input.name.trim()} (${trimmedBankName})`,
    description: `Updated bank account "${input.name.trim()}"`,
    details: { ...input },
  });
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
}

export async function deleteBankAccount(id: string) {
  const supabase = await createServerSupabaseClient();
  const { data: existing } = await supabase
    .from("bank_accounts")
    .select("name, bank_name, institution_id")
    .eq("id", id)
    .single();

  const { error } = await supabase.from("bank_accounts").delete().eq("id", id);

  if (error) throw new Error(error.message);
  const label = existing
    ? `${existing.name} (${existing.bank_name})`
    : "Unknown";
  await logActivity({
    action: "removed",
    entity_type: "bank_account",
    entity_name: label,
    description: `Removed bank account "${existing?.name ?? id}"`,
  });

  if (existing?.institution_id) {
    await cleanupOrphanedInstitution(existing.institution_id);
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
}
