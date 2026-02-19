"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { BrokerInput } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";

export async function getBrokers() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("brokers")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return data;
}

export async function createBroker(input: BrokerInput) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { error } = await supabase.from("brokers").insert({
    user_id: user.id,
    name: input.name.trim(),
  });

  if (error) throw new Error(error.message);
  await logActivity({
    action: "created",
    entity_type: "broker",
    entity_name: input.name.trim(),
    description: `Added broker "${input.name.trim()}"`,
    details: { name: input.name.trim() },
  });
  revalidatePath("/dashboard/settings");
}

export async function updateBroker(id: string, input: BrokerInput) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("brokers")
    .update({ name: input.name.trim() })
    .eq("id", id);

  if (error) throw new Error(error.message);
  await logActivity({
    action: "updated",
    entity_type: "broker",
    entity_name: input.name.trim(),
    description: `Updated broker "${input.name.trim()}"`,
    details: { name: input.name.trim() },
  });
  revalidatePath("/dashboard/settings");
}

export async function deleteBroker(id: string) {
  const supabase = await createServerSupabaseClient();
  const { data: existing } = await supabase
    .from("brokers")
    .select("name")
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
  revalidatePath("/dashboard/settings");
}
