"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { BrokerInput } from "@/lib/types";

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
  revalidatePath("/dashboard/settings");
}

export async function updateBroker(id: string, input: BrokerInput) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("brokers")
    .update({ name: input.name.trim() })
    .eq("id", id);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/settings");
}

export async function deleteBroker(id: string) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("brokers").delete().eq("id", id);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/settings");
}
