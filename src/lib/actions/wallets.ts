"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { Wallet, WalletInput } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";
import {
  findOrCreateInstitution,
  renameInstitution,
} from "@/lib/actions/institutions";
import { validateUUID, validateName } from "@/lib/validation";
import { partialUpdate } from "@/lib/partial-update";
import { VALID_WALLET_TYPES, MAX_LABEL_LENGTH } from "@/lib/constants";
import { captureAction } from "@/lib/actions/with-sentry";
import type { WalletType } from "@/lib/types";

function assertWalletType(v: unknown): asserts v is WalletType {
  if (v !== "custodial" && v !== "non_custodial") {
    throw new Error(`Invalid wallet type: must be one of ${VALID_WALLET_TYPES.join(", ")}`);
  }
}

function normalizeChain(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() || null;
  if (trimmed) validateName(trimmed, MAX_LABEL_LENGTH, "Chain");
  return trimmed;
}

export async function getWallets(): Promise<Wallet[]> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return data;
}

export async function createWallet(
  input: WalletInput,
  opts?: { also_broker?: boolean; also_bank?: boolean }
): Promise<string> {
  return captureAction("wallets.createWallet", async () => {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  validateName(input.name, 100, "Wallet name");
  assertWalletType(input.wallet_type);
  const trimmedName = input.name.trim();
  const normalizedChain = normalizeChain(input.chain);

  // Find or create institution
  const institutionId = await findOrCreateInstitution(trimmedName);

  const { data: created, error } = await supabase.from("wallets").insert({
    user_id: user.id,
    name: trimmedName,
    wallet_type: input.wallet_type,
    privacy_label: input.privacy_label ?? null,
    chain: normalizedChain,
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
      const { data: brokerCreated, error: brokerErr } = await supabase.from("brokers").insert({
        user_id: user.id,
        name: trimmedName,
        institution_id: institutionId,
      }).select("*").single();
      if (brokerErr) {
        console.error(`[wallets] Sibling broker creation failed for wallet "${trimmedName}":`, brokerErr.message);
      } else if (brokerCreated) {
        await logActivity({
          action: "created",
          entity_type: "broker",
          entity_name: trimmedName,
          description: `Added broker "${trimmedName}" (via wallet creation)`,
          entity_id: brokerCreated.id,
          entity_table: "brokers",
          before_snapshot: null,
          after_snapshot: brokerCreated,
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

  if (!created) throw new Error("Failed to create wallet");
  return created.id;
  });
}

/**
 * Create a standalone self-custody wallet (no institution).
 * Used for non-custodial wallets like MetaMask, Ledger, etc.
 */
export async function createStandaloneWallet(input: WalletInput): Promise<void> {
  return captureAction("wallets.createStandaloneWallet", async () => {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  validateName(input.name, 100, "Wallet name");
  const trimmedName = input.name.trim();
  const normalizedChain = normalizeChain(input.chain);

  const { data: created, error } = await supabase.from("wallets").insert({
    user_id: user.id,
    name: trimmedName,
    wallet_type: "non_custodial",
    privacy_label: input.privacy_label ?? null,
    chain: normalizedChain,
    institution_id: null,
  }).select("*").single();

  if (error) throw new Error(error.message);

  await logActivity({
    action: "created",
    entity_type: "wallet",
    entity_name: trimmedName,
    description: `Added self-custody wallet "${trimmedName}"`,
    entity_id: created?.id,
    entity_table: "wallets",
    before_snapshot: null,
    after_snapshot: created,
  });

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/accounts");
  });
}

export async function updateWallet(
  id: string,
  input: WalletInput,
  opts?: { also_broker?: boolean; also_bank?: boolean }
) {
  return captureAction("wallets.updateWallet", async () => {
  validateUUID(id, "Wallet ID");
  validateName(input.name.trim(), 100, "Wallet name");
  assertWalletType(input.wallet_type);
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const trimmedName = input.name.trim();
  // Preserve undefined for fields the caller didn't pass; partialUpdate()
  // will strip them. Explicit null is preserved for "clear the value".
  const normalizedChain = input.chain !== undefined ? normalizeChain(input.chain) : undefined;

  // Capture before snapshot
  const { data: before } = await supabase
    .from("wallets")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("wallets")
    .update(partialUpdate({
      name: trimmedName,
      wallet_type: input.wallet_type,
      privacy_label: input.privacy_label,
      chain: normalizedChain,
    }))
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) throw new Error(error.message);

  // If name changed and institution is linked, rename the institution
  // (DB trigger will propagate to all siblings)
  if (before?.institution_id && before.name !== trimmedName) {
    await renameInstitution(before.institution_id, trimmedName);
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
        name: trimmedName,
        institution_id: before.institution_id,
      }).select("*").single();
      if (brokerErr) {
        console.error(`[wallets] Sibling broker creation failed during updateWallet "${trimmedName}":`, brokerErr.message);
      } else if (brokerCreated) {
        await logActivity({
          action: "created",
          entity_type: "broker",
          entity_name: trimmedName,
          description: `Added broker "${trimmedName}" (via wallet edit)`,
          entity_id: brokerCreated.id,
          entity_table: "brokers",
          before_snapshot: null,
          after_snapshot: brokerCreated,
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
    .from("wallets")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
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
  });
}

export async function deleteWallet(id: string, opts?: { isAdjustment?: boolean }) {
  return captureAction("wallets.deleteWallet", async () => {
  validateUUID(id, "Wallet ID");
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Verify ownership before cascade deletion
  const { data: owned } = await supabase
    .from("wallets")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();
  if (!owned) throw new Error("Not found");

  // Delete child crypto positions individually so each gets an activity_log entry
  const { deletePosition } = await import("@/lib/actions/crypto");
  const { data: cryptoPositions } = await supabase
    .from("crypto_positions")
    .select("id")
    .eq("wallet_id", id)
    .is("deleted_at", null);

  if (cryptoPositions?.length) {
    await Promise.all(
      cryptoPositions.map((pos) =>
        deletePosition(pos.id, opts ? { isAdjustment: opts.isAdjustment } : undefined)
      )
    );
  }

  // Delete child cash accounts (exchange deposits) individually so each gets an activity_log entry
  const { deleteCashAccount } = await import("@/lib/actions/cash-accounts");
  const { data: walletCashAccounts } = await supabase
    .from("cash_accounts")
    .select("id")
    .eq("wallet_id", id)
    .is("deleted_at", null);

  if (walletCashAccounts?.length) {
    await Promise.all(
      walletCashAccounts.map((dep) =>
        deleteCashAccount(dep.id, opts ? { isAdjustment: opts.isAdjustment } : undefined)
      )
    );
  }

  // Capture full snapshot before soft-delete
  const { data: snapshot } = await supabase
    .from("wallets")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("wallets")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);

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

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/accounts");
  });
}
