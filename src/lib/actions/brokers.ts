"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { BrokerInput, WalletType, PrivacyLabel } from "@/lib/types";
import { DEFAULT_COUNTRY } from "@/lib/constants";
import { logActivity } from "@/lib/actions/activity-log";
import {
  findOrCreateInstitution,
  renameInstitution,
} from "@/lib/actions/institutions";

export async function getBrokers() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("brokers")
    .select("*")
    .is("deleted_at", null)
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

  const { data: created, error } = await supabase.from("brokers").insert({
    user_id: user.id,
    name: trimmedName,
    institution_id: institutionId,
  }).select("*").single();

  if (error) throw new Error(error.message);
  await logActivity({
    action: "created",
    entity_type: "broker",
    entity_name: trimmedName,
    description: `Added broker "${trimmedName}"`,
    entity_id: created?.id,
    entity_table: "brokers",
    before_snapshot: null,
    after_snapshot: created,
  });

  // Create sibling wallet if requested
  if (opts?.also_wallet) {
    const { data: existingWallet } = await supabase
      .from("wallets")
      .select("id")
      .eq("institution_id", institutionId)
      .is("deleted_at", null)
      .limit(1);

    if (!existingWallet?.length) {
      const { data: walletCreated, error: walletErr } = await supabase.from("wallets").insert({
        user_id: user.id,
        name: trimmedName,
        wallet_type: opts.wallet_type ?? "custodial",
        privacy_label: opts.wallet_privacy ?? null,
        chain: opts.wallet_chain?.trim() || null,
        institution_id: institutionId,
      }).select("*").single();
      if (!walletErr && walletCreated) {
        await logActivity({
          action: "created",
          entity_type: "wallet",
          entity_name: trimmedName,
          description: `Added wallet "${trimmedName}" (via broker creation)`,
          entity_id: walletCreated.id,
          entity_table: "wallets",
          before_snapshot: null,
          after_snapshot: walletCreated,
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
      const { data: bankCreated, error: bankErr } = await supabase.from("bank_accounts").insert({
        user_id: user.id,
        name: trimmedName,
        bank_name: trimmedName,
        region: DEFAULT_COUNTRY,
        currency: "EUR",
        balance: 0,
        apy: 0,
        institution_id: institutionId,
      }).select("*").single();
      if (!bankErr && bankCreated) {
        await logActivity({
          action: "created",
          entity_type: "bank_account",
          entity_name: trimmedName,
          description: `Added bank account "${trimmedName}" (via broker creation)`,
          entity_id: bankCreated.id,
          entity_table: "bank_accounts",
          before_snapshot: null,
          after_snapshot: bankCreated,
        });
      }
    }
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/accounts");
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

  // Capture before snapshot
  const { data: before } = await supabase
    .from("brokers")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("brokers")
    .update({ name: trimmedName })
    .eq("id", id);

  if (error) throw new Error(error.message);

  if (before?.institution_id && before.name !== trimmedName) {
    await renameInstitution(before.institution_id, trimmedName);
  }

  // Role extension: create sibling wallet if requested
  if (opts?.also_wallet && before?.institution_id) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: existingWallet } = await supabase
        .from("wallets")
        .select("id")
        .eq("institution_id", before.institution_id)
        .is("deleted_at", null)
        .limit(1);

      if (!existingWallet?.length) {
        const { data: walletCreated, error: walletErr } = await supabase.from("wallets").insert({
          user_id: user.id,
          name: trimmedName,
          wallet_type: opts.wallet_type ?? "custodial",
          privacy_label: opts.wallet_privacy ?? null,
          chain: opts.wallet_chain?.trim() || null,
          institution_id: before.institution_id,
        }).select("*").single();
        if (!walletErr && walletCreated) {
          await logActivity({
            action: "created",
            entity_type: "wallet",
            entity_name: trimmedName,
            description: `Added wallet "${trimmedName}" (via broker edit)`,
            entity_id: walletCreated.id,
            entity_table: "wallets",
            before_snapshot: null,
            after_snapshot: walletCreated,
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
        const { data: bankCreated, error: bankErr } = await supabase.from("bank_accounts").insert({
          user_id: user.id,
          name: trimmedName,
          bank_name: trimmedName,
          region: DEFAULT_COUNTRY,
          currency: "EUR",
          balance: 0,
          apy: 0,
          institution_id: before.institution_id,
        }).select("*").single();
        if (!bankErr && bankCreated) {
          await logActivity({
            action: "created",
            entity_type: "bank_account",
            entity_name: trimmedName,
            description: `Added bank account "${trimmedName}" (via broker edit)`,
            entity_id: bankCreated.id,
            entity_table: "bank_accounts",
            before_snapshot: null,
            after_snapshot: bankCreated,
          });
        }
      }
    }
  }

  // Capture after snapshot
  const { data: after } = await supabase
    .from("brokers")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  await logActivity({
    action: "updated",
    entity_type: "broker",
    entity_name: trimmedName,
    description: `Updated broker "${trimmedName}"`,
    entity_id: id,
    entity_table: "brokers",
    before_snapshot: before,
    after_snapshot: after,
  });
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/accounts");
  if (opts?.also_bank) revalidatePath("/dashboard/cash");
}

export async function deleteBroker(id: string) {
  const supabase = await createServerSupabaseClient();

  // Capture full snapshot before soft-delete
  const { data: snapshot } = await supabase
    .from("brokers")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("brokers")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(error.message);
  await logActivity({
    action: "removed",
    entity_type: "broker",
    entity_name: snapshot?.name ?? "Unknown",
    description: `Removed broker "${snapshot?.name ?? id}"`,
    entity_id: id,
    entity_table: "brokers",
    before_snapshot: snapshot,
    after_snapshot: null,
  });

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/accounts");
}
