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

  const { data: created, error } = await supabase.from("broker_deposits").insert({
    user_id: user.id,
    broker_id: input.broker_id,
    currency: input.currency,
    amount: input.amount,
    apy: input.apy ?? 0,
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
  await logActivity({
    action: "created",
    entity_type: "broker_deposit",
    entity_name: label,
    description: `Added broker deposit: ${label}`,
    entity_id: created?.id,
    entity_table: "broker_deposits",
    before_snapshot: null,
    after_snapshot: created,
  });
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
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

  // Capture before snapshot
  const { data: before } = await supabase
    .from("broker_deposits")
    .select("*")
    .eq("id", id)
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

  // Capture after snapshot
  const { data: after } = await supabase
    .from("broker_deposits")
    .select("*")
    .eq("id", id)
    .single();

  const label = `${input.amount} ${input.currency} on ${broker?.name ?? "Unknown"}`;
  await logActivity({
    action: "updated",
    entity_type: "broker_deposit",
    entity_name: label,
    description: `Updated broker deposit: ${label}`,
    entity_id: id,
    entity_table: "broker_deposits",
    before_snapshot: before,
    after_snapshot: after,
  });
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
}

export async function deleteBrokerDeposit(id: string): Promise<void> {
  const supabase = await createServerSupabaseClient();

  // Capture full snapshot before soft-delete
  const { data: snapshot } = await supabase
    .from("broker_deposits")
    .select("*, brokers(name)")
    .eq("id", id)
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
  await logActivity({
    action: "removed",
    entity_type: "broker_deposit",
    entity_name: label,
    description: `Removed broker deposit: ${label}`,
    entity_id: id,
    entity_table: "broker_deposits",
    before_snapshot: snapshot,
    after_snapshot: null,
  });
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard");
}
