"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { BrokerDeposit, BrokerDepositInput } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";

export async function getBrokerDeposits(): Promise<BrokerDeposit[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("broker_deposits")
    .select("*, brokers(name)")
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
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export async function createBrokerDeposit(
  input: BrokerDepositInput
): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data: broker } = await supabase
    .from("brokers")
    .select("name")
    .eq("id", input.broker_id)
    .single();

  const { error } = await supabase.from("broker_deposits").insert({
    user_id: user.id,
    broker_id: input.broker_id,
    currency: input.currency,
    amount: input.amount,
    apy: input.apy ?? 0,
  });

  if (error) {
    if (error.code === "23505") {
      throw new Error(
        "A deposit with this broker + currency combination already exists"
      );
    }
    throw new Error(error.message);
  }

  const label = `${input.amount} ${input.currency} on ${broker?.name ?? "Unknown"}`;
  await logActivity({
    action: "created",
    entity_type: "broker_deposit",
    entity_name: label,
    description: `Added broker deposit: ${label}`,
    details: { ...input, broker_name: broker?.name },
  });
  revalidatePath("/dashboard/cash");
}

export async function updateBrokerDeposit(
  id: string,
  input: BrokerDepositInput
): Promise<void> {
  const supabase = await createServerSupabaseClient();

  const { data: broker } = await supabase
    .from("brokers")
    .select("name")
    .eq("id", input.broker_id)
    .single();

  const { error } = await supabase
    .from("broker_deposits")
    .update({
      broker_id: input.broker_id,
      currency: input.currency,
      amount: input.amount,
      apy: input.apy ?? 0,
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

  const label = `${input.amount} ${input.currency} on ${broker?.name ?? "Unknown"}`;
  await logActivity({
    action: "updated",
    entity_type: "broker_deposit",
    entity_name: label,
    description: `Updated broker deposit: ${label}`,
    details: { ...input, broker_name: broker?.name },
  });
  revalidatePath("/dashboard/cash");
}

export async function deleteBrokerDeposit(id: string): Promise<void> {
  const supabase = await createServerSupabaseClient();

  const { data: existing } = await supabase
    .from("broker_deposits")
    .select("amount, currency, brokers(name)")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("broker_deposits")
    .delete()
    .eq("id", id);

  if (error) throw new Error(error.message);

  const brokerName =
    (existing?.brokers as unknown as { name: string } | null)?.name ?? "Unknown";
  const label = existing
    ? `${existing.amount} ${existing.currency} on ${brokerName}`
    : "Unknown";
  await logActivity({
    action: "removed",
    entity_type: "broker_deposit",
    entity_name: label,
    description: `Removed broker deposit: ${label}`,
  });
  revalidatePath("/dashboard/cash");
}
