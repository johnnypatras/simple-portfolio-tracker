"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { BankAccountInput, WalletType, PrivacyLabel } from "@/lib/types";
import { DEFAULT_COUNTRY } from "@/lib/constants";
import { logActivity, toUsdAndEur } from "@/lib/actions/activity-log";
import {
  findOrCreateInstitution,
  renameInstitution,
} from "@/lib/actions/institutions";
import { validateAmount, validateCurrency, validateName, validateUUID } from "@/lib/validation";

export async function getBankAccounts() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("bank_accounts")
    .select("*")
    .is("deleted_at", null)
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
    isAdjustment?: boolean;
    transferGroupId?: string;
    effectiveDate?: string;
  }
) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  validateName(input.name, 100, "Account name");
  validateName(input.bank_name, 100, "Bank name");
  if (input.currency) validateCurrency(input.currency);
  if (input.balance != null) validateAmount(input.balance, "Balance");

  const trimmedBankName = input.bank_name.trim();
  const institutionId = await findOrCreateInstitution(trimmedBankName);

  const { data: created, error } = await supabase.from("bank_accounts").insert({
    user_id: user.id,
    name: input.name.trim(),
    bank_name: trimmedBankName,
    region: input.country ?? DEFAULT_COUNTRY,
    currency: input.currency ?? "EUR",
    balance: input.balance ?? 0,
    apy: input.apy ?? 0,
    institution_id: institutionId,
    last_was_adjustment: opts?.isAdjustment ?? false,
    last_was_transfer: opts?.transferGroupId != null,
  }).select("*").single();

  if (error) throw new Error(error.message);
  let deltaUsd: number | null = null;
  let deltaEur: number | null = null;
  if (opts?.isAdjustment && created) {
    try {
      const converted = await toUsdAndEur(created.balance ?? 0, created.currency ?? "EUR", opts?.effectiveDate?.split("T")[0]);
      deltaUsd = Math.round(converted.usd * 100) / 100;
      deltaEur = Math.round(converted.eur * 100) / 100;
    } catch (err) {
      console.error("[bank-accounts] FX delta failed, will be null (backfillable):", err instanceof Error ? err.message : err);
    }
  }
  await logActivity({
    action: "created",
    entity_type: "bank_account",
    entity_name: `${input.name.trim()} (${trimmedBankName})`,
    description: `Added bank account "${input.name.trim()}" at ${trimmedBankName}`,
    entity_id: created?.id,
    entity_table: "bank_accounts",
    before_snapshot: null,
    after_snapshot: created,
    is_adjustment: opts?.isAdjustment,
    delta_usd: deltaUsd,
    delta_eur: deltaEur,
    transfer_group_id: opts?.transferGroupId,
    created_at: opts?.effectiveDate,
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
        name: trimmedBankName,
        wallet_type: opts.wallet_type ?? "custodial",
        privacy_label: opts.wallet_privacy ?? null,
        chain: opts.wallet_chain?.trim() || null,
        institution_id: institutionId,
      }).select("*").single();
      if (!walletErr && walletCreated) {
        await logActivity({
          action: "created",
          entity_type: "wallet",
          entity_name: trimmedBankName,
          description: `Added wallet "${trimmedBankName}" (via bank creation)`,
          entity_id: walletCreated.id,
          entity_table: "wallets",
          before_snapshot: null,
          after_snapshot: walletCreated,
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
      .is("deleted_at", null)
      .limit(1);

    if (!existingBroker?.length) {
      const { data: brokerCreated, error: brokerErr } = await supabase.from("brokers").insert({
        user_id: user.id,
        name: trimmedBankName,
        institution_id: institutionId,
      }).select("*").single();
      if (!brokerErr && brokerCreated) {
        await logActivity({
          action: "created",
          entity_type: "broker",
          entity_name: trimmedBankName,
          description: `Added broker "${trimmedBankName}" (via bank creation)`,
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
    isAdjustment?: boolean;
    transferGroupId?: string;
    effectiveDate?: string;
  }
) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  validateUUID(id, "Bank account ID");
  validateName(input.name, 100, "Account name");
  validateName(input.bank_name, 100, "Bank name");
  if (input.currency) validateCurrency(input.currency);
  if (input.balance != null) validateAmount(input.balance, "Balance");

  const trimmedBankName = input.bank_name.trim();

  // Capture before snapshot
  const { data: before } = await supabase
    .from("bank_accounts")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  const updateFields: Record<string, unknown> = {
    name: input.name.trim(),
    bank_name: trimmedBankName,
    currency: input.currency ?? "EUR",
    balance: input.balance ?? 0,
    apy: input.apy ?? 0,
    last_was_adjustment: opts?.isAdjustment ?? false,
    last_was_transfer: opts?.transferGroupId != null,
  };
  if (input.country !== undefined) updateFields.region = input.country;

  const { error } = await supabase
    .from("bank_accounts")
    .update(updateFields)
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) throw new Error(error.message);

  // If bank_name changed and institution linked, rename institution
  if (before?.institution_id && before.bank_name !== trimmedBankName) {
    await renameInstitution(before.institution_id, trimmedBankName);
  }

  // Role extension: create sibling wallet if requested
  if (opts?.also_wallet && before?.institution_id) {
    const { data: existingWallet } = await supabase
      .from("wallets")
      .select("id")
      .eq("institution_id", before.institution_id)
      .is("deleted_at", null)
      .limit(1);

    if (!existingWallet?.length) {
      const { data: walletCreated, error: walletErr } = await supabase.from("wallets").insert({
        user_id: user.id,
        name: trimmedBankName,
        wallet_type: opts.wallet_type ?? "custodial",
        privacy_label: opts.wallet_privacy ?? null,
        chain: opts.wallet_chain?.trim() || null,
        institution_id: before.institution_id,
      }).select("*").single();
      if (!walletErr && walletCreated) {
        await logActivity({
          action: "created",
          entity_type: "wallet",
          entity_name: trimmedBankName,
          description: `Added wallet "${trimmedBankName}" (via bank edit)`,
          entity_id: walletCreated.id,
          entity_table: "wallets",
          before_snapshot: null,
          after_snapshot: walletCreated,
        });
      }
    }
  }

  // Role extension: create sibling broker if requested
  if (opts?.also_broker && before?.institution_id) {
    const { data: existingBroker } = await supabase
      .from("brokers")
      .select("id")
      .eq("institution_id", before.institution_id)
      .is("deleted_at", null)
      .limit(1);

    if (!existingBroker?.length) {
      const { data: brokerCreated, error: brokerErr } = await supabase.from("brokers").insert({
        user_id: user.id,
        name: trimmedBankName,
        institution_id: before.institution_id,
      }).select("*").single();
      if (!brokerErr && brokerCreated) {
        await logActivity({
          action: "created",
          entity_type: "broker",
          entity_name: trimmedBankName,
          description: `Added broker "${trimmedBankName}" (via bank edit)`,
          entity_id: brokerCreated.id,
          entity_table: "brokers",
          before_snapshot: null,
          after_snapshot: brokerCreated,
        });
      }
    }
  }

  // Capture after snapshot
  const { data: after } = await supabase
    .from("bank_accounts")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  let deltaUsd: number | null = null;
  let deltaEur: number | null = null;
  if (opts?.isAdjustment) {
    try {
      const beforeBal = (before?.balance as number) ?? 0;
      const afterBal = (after?.balance as number) ?? 0;
      const currency = (after?.currency as string) ?? (before?.currency as string) ?? "EUR";
      const converted = await toUsdAndEur(afterBal - beforeBal, currency, opts?.effectiveDate?.split("T")[0]);
      deltaUsd = Math.round(converted.usd * 100) / 100;
      deltaEur = Math.round(converted.eur * 100) / 100;
    } catch (err) {
      console.error("[bank-accounts] FX delta failed, will be null (backfillable):", err instanceof Error ? err.message : err);
    }
  }
  await logActivity({
    action: "updated",
    entity_type: "bank_account",
    entity_name: `${input.name.trim()} (${trimmedBankName})`,
    description: `Updated bank account "${input.name.trim()}"`,
    entity_id: id,
    entity_table: "bank_accounts",
    before_snapshot: before,
    after_snapshot: after,
    is_adjustment: opts?.isAdjustment,
    delta_usd: deltaUsd,
    delta_eur: deltaEur,
    transfer_group_id: opts?.transferGroupId,
    created_at: opts?.effectiveDate,
  });
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/accounts");
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
}

export async function deleteBankAccount(id: string, opts?: { isAdjustment?: boolean }) {
  validateUUID(id, "Bank account ID");
  const supabase = await createServerSupabaseClient();

  // Capture full snapshot before soft-delete
  const { data: snapshot } = await supabase
    .from("bank_accounts")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("bank_accounts")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(error.message);
  const label = snapshot
    ? `${snapshot.name} (${snapshot.bank_name})`
    : "Unknown";
  let deltaUsd: number | null = null;
  let deltaEur: number | null = null;
  if (opts?.isAdjustment && snapshot) {
    try {
      const converted = await toUsdAndEur(-(snapshot.balance ?? 0), snapshot.currency ?? "EUR");
      deltaUsd = Math.round(converted.usd * 100) / 100;
      deltaEur = Math.round(converted.eur * 100) / 100;
    } catch (err) {
      console.error("[bank-accounts] FX delta failed, will be null (backfillable):", err instanceof Error ? err.message : err);
    }
  }
  await logActivity({
    action: "removed",
    entity_type: "bank_account",
    entity_name: label,
    description: `Removed bank account "${snapshot?.name ?? id}"`,
    entity_id: id,
    entity_table: "bank_accounts",
    before_snapshot: snapshot,
    after_snapshot: null,
    is_adjustment: opts?.isAdjustment,
    delta_usd: deltaUsd,
    delta_eur: deltaEur,
  });

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/accounts");
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
}
