"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { Broker, BrokerInput, WalletType, PrivacyLabel } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";
import {
  findOrCreateInstitution,
  renameInstitution,
} from "@/lib/actions/institutions";
import { validateUUID, validateName } from "@/lib/validation";
import { captureAction } from "@/lib/actions/with-sentry";

export async function getBrokers(): Promise<Broker[]> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from("brokers")
    .select("*")
    .eq("user_id", user.id)
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
): Promise<string> {
  return captureAction("brokers.createBroker", async () => {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  validateName(input.name, 100, "Broker name");
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
      if (walletErr) {
        console.error(`[brokers] Sibling wallet creation failed for broker "${trimmedName}":`, walletErr.message);
      } else if (walletCreated) {
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

  // Create sibling cash account if requested (with sensible defaults)
  if (opts?.also_bank) {
    const { data: existingCash } = await supabase
      .from("cash_accounts")
      .select("id")
      .eq("institution_id", institutionId)
      .eq("currency", "EUR")
      .is("deleted_at", null)
      .limit(1);

    if (!existingCash?.length) {
      const { createCashAccount } = await import("@/lib/actions/cash-accounts");
      await createCashAccount({
        institution_id: institutionId,
        name: trimmedName,
        currency: "EUR",
        balance: 0,
      });
    }
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/accounts");
  if (opts?.also_bank) revalidatePath("/dashboard/cash");

  if (!created) throw new Error("Failed to create broker");
  return created.id;
  });
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
  return captureAction("brokers.updateBroker", async () => {
  validateUUID(id, "Broker ID");
  validateName(input.name.trim(), 100, "Broker name");
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  const trimmedName = input.name.trim();

  // Capture before snapshot
  const { data: before } = await supabase
    .from("brokers")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("brokers")
    .update({ name: trimmedName })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) throw new Error(error.message);

  if (before?.institution_id && before.name !== trimmedName) {
    await renameInstitution(before.institution_id, trimmedName);
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
          name: trimmedName,
          wallet_type: opts.wallet_type ?? "custodial",
          privacy_label: opts.wallet_privacy ?? null,
          chain: opts.wallet_chain?.trim() || null,
          institution_id: before.institution_id,
        }).select("*").single();
        if (walletErr) {
          console.error(`[brokers] Sibling wallet creation failed during updateBroker "${trimmedName}":`, walletErr.message);
        } else if (walletCreated) {
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

  // Role extension: create sibling cash account if requested
  if (opts?.also_bank && before?.institution_id) {
    const { data: existingCash } = await supabase
      .from("cash_accounts")
      .select("id")
      .eq("institution_id", before.institution_id)
      .eq("currency", "EUR")
      .is("deleted_at", null)
      .limit(1);

    if (!existingCash?.length) {
      const { createCashAccount } = await import("@/lib/actions/cash-accounts");
      await createCashAccount({
        institution_id: before.institution_id,
        name: trimmedName,
        currency: "EUR",
        balance: 0,
      });
    }
  }

  // Capture after snapshot
  const { data: after } = await supabase
    .from("brokers")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
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
  });
}

export async function deleteBroker(id: string, opts?: { isAdjustment?: boolean }) {
  return captureAction("brokers.deleteBroker", async () => {
  validateUUID(id, "Broker ID");
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Verify ownership before cascade deletion
  const { data: owned } = await supabase
    .from("brokers")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();
  if (!owned) throw new Error("Not found");

  // Delete child stock positions individually so each gets an activity_log entry
  const { deleteStockPosition } = await import("@/lib/actions/stocks");
  const { data: stockPositions } = await supabase
    .from("stock_positions")
    .select("id")
    .eq("broker_id", id)
    .is("deleted_at", null);

  if (stockPositions?.length) {
    await Promise.all(
      stockPositions.map((pos) =>
        deleteStockPosition(pos.id, opts ? { isAdjustment: opts.isAdjustment } : undefined)
      )
    );
  }

  // Delete child cash accounts (broker deposits) individually so each gets an activity_log entry
  const { deleteCashAccount } = await import("@/lib/actions/cash-accounts");
  const { data: brokerCashAccounts } = await supabase
    .from("cash_accounts")
    .select("id")
    .eq("broker_id", id)
    .is("deleted_at", null);

  if (brokerCashAccounts?.length) {
    await Promise.all(
      brokerCashAccounts.map((dep) =>
        deleteCashAccount(dep.id, opts ? { isAdjustment: opts.isAdjustment } : undefined)
      )
    );
  }

  // Capture full snapshot before soft-delete
  const { data: snapshot } = await supabase
    .from("brokers")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("brokers")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);

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
  });
}
