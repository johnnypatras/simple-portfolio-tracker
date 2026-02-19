"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { WalletInput } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";

export async function getWallets() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("wallets")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return data;
}

export async function createWallet(input: WalletInput) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { error } = await supabase.from("wallets").insert({
    user_id: user.id,
    name: input.name.trim(),
    wallet_type: input.wallet_type,
    privacy_label: input.privacy_label ?? null,
  });

  if (error) throw new Error(error.message);
  await logActivity({
    action: "created",
    entity_type: "wallet",
    entity_name: input.name.trim(),
    description: `Added wallet "${input.name.trim()}"`,
    details: { ...input },
  });
  revalidatePath("/dashboard/settings");
}

export async function updateWallet(id: string, input: WalletInput) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("wallets")
    .update({
      name: input.name.trim(),
      wallet_type: input.wallet_type,
      privacy_label: input.privacy_label ?? null,
    })
    .eq("id", id);

  if (error) throw new Error(error.message);
  await logActivity({
    action: "updated",
    entity_type: "wallet",
    entity_name: input.name.trim(),
    description: `Updated wallet "${input.name.trim()}"`,
    details: { ...input },
  });
  revalidatePath("/dashboard/settings");
}

export async function deleteWallet(id: string) {
  const supabase = await createServerSupabaseClient();
  const { data: existing } = await supabase
    .from("wallets")
    .select("name")
    .eq("id", id)
    .single();

  const { error } = await supabase.from("wallets").delete().eq("id", id);

  if (error) throw new Error(error.message);
  await logActivity({
    action: "removed",
    entity_type: "wallet",
    entity_name: existing?.name ?? "Unknown",
    description: `Removed wallet "${existing?.name ?? id}"`,
  });
  revalidatePath("/dashboard/settings");
}
