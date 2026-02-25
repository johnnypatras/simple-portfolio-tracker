"use server";

import { revalidatePath } from "next/cache";
import { nanoid } from "nanoid";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Profile, UserStatus } from "@/lib/types";

// ─── Helpers ──────────────────────────────────────────────

async function requireAdmin(): Promise<string> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "admin") throw new Error("Forbidden");
  return user.id;
}

// ─── User Management ──────────────────────────────────────

export async function getUsers(): Promise<Profile[]> {
  await requireAdmin();
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("profiles")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function approveUser(userId: string): Promise<void> {
  await requireAdmin();
  const admin = createAdminClient();

  const { error } = await admin
    .from("profiles")
    .update({ status: "active" as UserStatus })
    .eq("id", userId);

  if (error) throw new Error(error.message);
  revalidatePath("/settings");
}

export async function rejectUser(userId: string): Promise<void> {
  await requireAdmin();
  const admin = createAdminClient();

  // Delete auth user — profile cascade should handle the rest
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw new Error(error.message);
  revalidatePath("/settings");
}

export async function suspendUser(userId: string): Promise<void> {
  const adminId = await requireAdmin();
  if (userId === adminId) throw new Error("Cannot suspend yourself");
  const admin = createAdminClient();

  const { error } = await admin
    .from("profiles")
    .update({ status: "suspended" as UserStatus })
    .eq("id", userId);

  if (error) throw new Error(error.message);
  revalidatePath("/settings");
}

export async function unsuspendUser(userId: string): Promise<void> {
  await requireAdmin();
  const admin = createAdminClient();

  const { error } = await admin
    .from("profiles")
    .update({ status: "active" as UserStatus })
    .eq("id", userId);

  if (error) throw new Error(error.message);
  revalidatePath("/settings");
}

// ─── Invite Codes ─────────────────────────────────────────

export interface InviteCode {
  id: string;
  code: string;
  created_by: string;
  used_by: string | null;
  used_at: string | null;
  expires_at: string | null;
  created_at: string;
  // Joined
  used_by_email?: string | null;
}

export async function getInviteCodes(): Promise<InviteCode[]> {
  await requireAdmin();
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("invite_codes")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  // Enrich with used_by email
  const codes = (data ?? []) as InviteCode[];
  const usedByIds = codes
    .map((c) => c.used_by)
    .filter((id): id is string => id !== null);

  if (usedByIds.length > 0) {
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, email")
      .in("id", usedByIds);

    const emailMap = new Map(
      (profiles ?? []).map((p: { id: string; email: string }) => [p.id, p.email])
    );

    for (const code of codes) {
      if (code.used_by) {
        code.used_by_email = emailMap.get(code.used_by) ?? null;
      }
    }
  }

  return codes;
}

export async function createInviteCode(
  expiresInDays?: number | null
): Promise<string> {
  const adminId = await requireAdmin();
  const admin = createAdminClient();

  const code = nanoid(12);
  const expiresAt =
    expiresInDays != null
      ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
      : null;

  const { error } = await admin.from("invite_codes").insert({
    code,
    created_by: adminId,
    expires_at: expiresAt,
  });

  if (error) throw new Error(error.message);
  revalidatePath("/settings");
  return code;
}

export async function deleteInviteCode(codeId: string): Promise<void> {
  await requireAdmin();
  const admin = createAdminClient();

  const { error } = await admin
    .from("invite_codes")
    .delete()
    .eq("id", codeId)
    .is("used_by", null); // only delete unused codes

  if (error) throw new Error(error.message);
  revalidatePath("/settings");
}
