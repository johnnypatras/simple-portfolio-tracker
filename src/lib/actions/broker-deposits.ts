"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { BrokerDeposit, BrokerDepositInput } from "@/lib/types";
import { logActivity, toUsdAndEur } from "@/lib/actions/activity-log";
import { validateAmount, validateCurrency } from "@/lib/validation";

export async function getBrokerDeposits(): Promise<BrokerDeposit[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("broker_deposits")
    .select("*, brokers(name)")
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    id: row.id,
    user_id: row.user_id,
    broker_id: row.broker_id,
    broker_name: (row.brokers as { name: string })?.name ?? "Unknown",
    currency: row.currency,
    amount: row.amount,
    apy: row.apy,
    last_was_adjustment: row.last_was_adjustment ?? false,
    last_was_transfer: row.last_was_transfer ?? false,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export async function createBrokerDeposit(
  input: BrokerDepositInput,
  opts?: { isAdjustment?: boolean; transferGroupId?: string; effectiveDate?: string }
): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  validateCurrency(input.currency);
  validateAmount(input.amount, "Deposit amount");

  const { data: broker } = await supabase
    .from("brokers")
    .select("name")
    .eq("id", input.broker_id)
    .is("deleted_at", null)
    .single();

  const { data: created, error } = await supabase.from("broker_deposits").insert({
    user_id: user.id,
    broker_id: input.broker_id,
    currency: input.currency,
    amount: input.amount,
    apy: input.apy ?? 0,
    last_was_adjustment: opts?.isAdjustment ?? false,
    last_was_transfer: opts?.transferGroupId != null,
  }).select("*").single();

  if (error) {
    if (error.code === "23505") {
      throw new Error(
        "A deposit with this broker + currency combination already exists"
      );
    }
    throw new Error(error.message);
  }

  const label = `${input.amount} ${input.currency} on ${broker?.name ?? "Unknown"}`;
  let deltaUsd: number | null = null;
  let deltaEur: number | null = null;
  if (opts?.isAdjustment && created) {
    try {
      const converted = await toUsdAndEur(created.amount ?? 0, created.currency, opts?.effectiveDate?.split("T")[0]);
      deltaUsd = Math.round(converted.usd * 100) / 100;
      deltaEur = Math.round(converted.eur * 100) / 100;
    } catch (err) {
      console.error("[broker-deposits] FX delta failed, will be null (backfillable):", err instanceof Error ? err.message : err);
    }
  }
  await logActivity({
    action: "created",
    entity_type: "broker_deposit",
    entity_name: label,
    description: `Added broker deposit: ${label}`,
    entity_id: created?.id,
    entity_table: "broker_deposits",
    before_snapshot: null,
    after_snapshot: created,
    is_adjustment: opts?.isAdjustment,
    delta_usd: deltaUsd,
    delta_eur: deltaEur,
    transfer_group_id: opts?.transferGroupId,
    created_at: opts?.effectiveDate,
  });
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
}

export async function updateBrokerDeposit(
  id: string,
  input: BrokerDepositInput,
  opts?: { isAdjustment?: boolean; transferGroupId?: string; effectiveDate?: string }
): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  validateCurrency(input.currency);
  validateAmount(input.amount, "Deposit amount");

  // Parallelize independent queries: broker name + before snapshot
  const [{ data: broker }, { data: before }] = await Promise.all([
    supabase
      .from("brokers")
      .select("name")
      .eq("id", input.broker_id)
      .is("deleted_at", null)
      .single(),
    supabase
      .from("broker_deposits")
      .select("*")
      .eq("id", id)
      .is("deleted_at", null)
      .single(),
  ]);

  const { error } = await supabase
    .from("broker_deposits")
    .update({
      broker_id: input.broker_id,
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
        "A deposit with this broker + currency combination already exists"
      );
    }
    throw new Error(error.message);
  }

  // Capture after snapshot
  const { data: after } = await supabase
    .from("broker_deposits")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  const label = `${input.amount} ${input.currency} on ${broker?.name ?? "Unknown"}`;
  let deltaUsd: number | null = null;
  let deltaEur: number | null = null;
  if (opts?.isAdjustment) {
    try {
      const beforeAmt = (before?.amount as number) ?? 0;
      const afterAmt = (after?.amount as number) ?? 0;
      const currency = (after?.currency as string) ?? (before?.currency as string) ?? "USD";
      const converted = await toUsdAndEur(afterAmt - beforeAmt, currency, opts?.effectiveDate?.split("T")[0]);
      deltaUsd = Math.round(converted.usd * 100) / 100;
      deltaEur = Math.round(converted.eur * 100) / 100;
    } catch (err) {
      console.error("[broker-deposits] FX delta failed, will be null (backfillable):", err instanceof Error ? err.message : err);
    }
  }
  await logActivity({
    action: "updated",
    entity_type: "broker_deposit",
    entity_name: label,
    description: `Updated broker deposit: ${label}`,
    entity_id: id,
    entity_table: "broker_deposits",
    before_snapshot: before,
    after_snapshot: after,
    is_adjustment: opts?.isAdjustment,
    delta_usd: deltaUsd,
    delta_eur: deltaEur,
    transfer_group_id: opts?.transferGroupId,
    created_at: opts?.effectiveDate,
  });
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
}

export async function deleteBrokerDeposit(id: string, opts?: { isAdjustment?: boolean }): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Capture full snapshot before soft-delete
  const { data: snapshot } = await supabase
    .from("broker_deposits")
    .select("*, brokers(name)")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("broker_deposits")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(error.message);

  const brokerName =
    (snapshot?.brokers as unknown as { name: string } | null)?.name ?? "Unknown";
  const label = snapshot
    ? `${snapshot.amount} ${snapshot.currency} on ${brokerName}`
    : "Unknown";
  let deltaUsd: number | null = null;
  let deltaEur: number | null = null;
  if (opts?.isAdjustment && snapshot) {
    try {
      const converted = await toUsdAndEur(-(snapshot.amount ?? 0), snapshot.currency ?? "USD");
      deltaUsd = Math.round(converted.usd * 100) / 100;
      deltaEur = Math.round(converted.eur * 100) / 100;
    } catch (err) {
      console.error("[broker-deposits] FX delta failed, will be null (backfillable):", err instanceof Error ? err.message : err);
    }
  }
  await logActivity({
    action: "removed",
    entity_type: "broker_deposit",
    entity_name: label,
    description: `Removed broker deposit: ${label}`,
    entity_id: id,
    entity_table: "broker_deposits",
    before_snapshot: snapshot,
    after_snapshot: null,
    is_adjustment: opts?.isAdjustment,
    delta_usd: deltaUsd,
    delta_eur: deltaEur,
  });
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
}
