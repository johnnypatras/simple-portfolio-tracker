"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { Profile } from "@/types/database";

/** Fetch the current user's profile. */
export async function getProfile(): Promise<Profile> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (error) throw new Error(error.message);
  return data as Profile;
}
