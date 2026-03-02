"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ExchangeDeposit, ExchangeDepositInput } from "@/lib/types";
import { logActivity, toUsdAndEur } from "@/lib/actions/activity-log";

export async function getExchangeDeposits(): Promise<ExchangeDeposit[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("exchange_deposits")
    .select("*, wallets(name)")
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);

  // Flatten the joined wallet name
  return (data ?? []).map((row) => ({
    id: row.id,
    user_id: row.user_id,
    wallet_id: row.wallet_id,
    wallet_name: (row.wallets as { name: string })?.name ?? "Unknown",
    currency: row.currency,
    amount: row.amount,
    apy: row.apy,
    last_was_adjustment: row.last_was_adjustment ?? false,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export async function createExchangeDeposit(
  input: ExchangeDepositInput,
  opts?: { isAdjustment?: boolean; transferGroupId?: string }
): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Fetch wallet and verify it's custodial (only exchanges can hold fiat deposits)
  const { data: wallet } = await supabase
    .from("wallets")
    .select("name, wallet_type")
    .eq("id", input.wallet_id)
    .is("deleted_at", null)
    .single();

  if (!wallet) throw new Error("Wallet not found");
  if (wallet.wallet_type !== "custodial") {
    throw new Error("Exchange deposits can only be added to custodial wallets (exchanges)");
  }

  const { data: created, error } = await supabase.from("exchange_deposits").insert({
    user_id: user.id,
    wallet_id: input.wallet_id,
    currency: input.currency,
    amount: input.amount,
    apy: input.apy ?? 0,
    last_was_adjustment: opts?.isAdjustment ?? false,
    last_was_transfer: opts?.transferGroupId != null,
  }).select("*").single();

  if (error) {
    // Handle UNIQUE(user_id, wallet_id, currency) violation
    if (error.code === "23505") {
      throw new Error(
        "A deposit with this wallet + currency combination already exists"
      );
    }
    throw new Error(error.message);
  }

  const label = `${input.amount} ${input.currency} on ${wallet?.name ?? "Unknown"}`;
  let deltaUsd: number | null = null;
  let deltaEur: number | null = null;
  if (opts?.isAdjustment && created) {
    const converted = await toUsdAndEur(created.amount ?? 0, created.currency);
    deltaUsd = Math.round(converted.usd * 100) / 100;
    deltaEur = Math.round(converted.eur * 100) / 100;
  }
  await logActivity({
    action: "created",
    entity_type: "exchange_deposit",
    entity_name: label,
    description: `Added exchange deposit: ${label}`,
    entity_id: created?.id,
    entity_table: "exchange_deposits",
    before_snapshot: null,
    after_snapshot: created,
    is_adjustment: opts?.isAdjustment,
    delta_usd: deltaUsd,
    delta_eur: deltaEur,
    transfer_group_id: opts?.transferGroupId,
  });
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
}

export async function updateExchangeDeposit(
  id: string,
  input: ExchangeDepositInput,
  opts?: { isAdjustment?: boolean; transferGroupId?: string }
): Promise<void> {
  const supabase = await createServerSupabaseClient();

  // Fetch wallet and verify it's custodial (only exchanges can hold fiat deposits)
  const { data: wallet } = await supabase
    .from("wallets")
    .select("name, wallet_type")
    .eq("id", input.wallet_id)
    .is("deleted_at", null)
    .single();

  if (!wallet) throw new Error("Wallet not found");
  if (wallet.wallet_type !== "custodial") {
    throw new Error("Exchange deposits can only be added to custodial wallets (exchanges)");
  }

  // Capture before snapshot
  const { data: before } = await supabase
    .from("exchange_deposits")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("exchange_deposits")
    .update({
      wallet_id: input.wallet_id,
      currency: input.currency,
      amount: input.amount,
      apy: input.apy ?? 0,
      last_was_adjustment: opts?.isAdjustment ?? false,
      last_was_transfer: opts?.transferGroupId != null,
    })
    .eq("id", id);

  if (error) {
    if (error.code === "23505") {
      throw new Error(
        "A deposit with this wallet + currency combination already exists"
      );
    }
    throw new Error(error.message);
  }

  // Capture after snapshot
  const { data: after } = await supabase
    .from("exchange_deposits")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  const label = `${input.amount} ${input.currency} on ${wallet?.name ?? "Unknown"}`;
  let deltaUsd: number | null = null;
  let deltaEur: number | null = null;
  if (opts?.isAdjustment) {
    const beforeAmt = (before?.amount as number) ?? 0;
    const afterAmt = (after?.amount as number) ?? 0;
    const currency = (after?.currency as string) ?? (before?.currency as string) ?? "USD";
    const converted = await toUsdAndEur(afterAmt - beforeAmt, currency);
    deltaUsd = Math.round(converted.usd * 100) / 100;
    deltaEur = Math.round(converted.eur * 100) / 100;
  }
  await logActivity({
    action: "updated",
    entity_type: "exchange_deposit",
    entity_name: label,
    description: `Updated exchange deposit: ${label}`,
    entity_id: id,
    entity_table: "exchange_deposits",
    before_snapshot: before,
    after_snapshot: after,
    is_adjustment: opts?.isAdjustment,
    delta_usd: deltaUsd,
    delta_eur: deltaEur,
    transfer_group_id: opts?.transferGroupId,
  });
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
}

export async function deleteExchangeDeposit(id: string, opts?: { isAdjustment?: boolean }): Promise<void> {
  const supabase = await createServerSupabaseClient();

  // Capture full snapshot before soft-delete
  const { data: snapshot } = await supabase
    .from("exchange_deposits")
    .select("*, wallets(name)")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("exchange_deposits")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(error.message);
  const walletName =
    (snapshot?.wallets as unknown as { name: string } | null)?.name ?? "Unknown";
  const label = snapshot
    ? `${snapshot.amount} ${snapshot.currency} on ${walletName}`
    : "Unknown";
  let deltaUsd: number | null = null;
  let deltaEur: number | null = null;
  if (opts?.isAdjustment && snapshot) {
    const converted = await toUsdAndEur(-(snapshot.amount ?? 0), snapshot.currency ?? "USD");
    deltaUsd = Math.round(converted.usd * 100) / 100;
    deltaEur = Math.round(converted.eur * 100) / 100;
  }
  await logActivity({
    action: "removed",
    entity_type: "exchange_deposit",
    entity_name: label,
    description: `Removed exchange deposit: ${label}`,
    entity_id: id,
    entity_table: "exchange_deposits",
    before_snapshot: snapshot,
    after_snapshot: null,
    is_adjustment: opts?.isAdjustment,
    delta_usd: deltaUsd,
    delta_eur: deltaEur,
  });
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
}
