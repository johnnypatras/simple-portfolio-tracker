"use server";

import { revalidatePath } from "next/cache";
import { nanoid } from "nanoid";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateUUID } from "@/lib/validation";
import { MAX_SHARE_EXPIRY_DAYS } from "@/lib/constants";
import type { Profile, UserRole, UserStatus, InviteCode } from "@/lib/types";
import { captureAction } from "@/lib/actions/with-sentry";

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
  // DB stores role/status as text (constrained by application logic); narrow at boundary
  return (data ?? []).map<Profile>((row) => ({
    ...row,
    role: row.role as UserRole,
    status: row.status as UserStatus,
  }));
}

export async function approveUser(userId: string): Promise<void> {
  return captureAction("admin.approveUser", async () => {
  validateUUID(userId, "User ID");
  await requireAdmin();
  const admin = createAdminClient();

  const { error } = await admin
    .from("profiles")
    .update({ status: "active" as UserStatus })
    .eq("id", userId);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/settings");
  });
}

export async function rejectUser(userId: string): Promise<void> {
  return captureAction("admin.rejectUser", async () => {
  validateUUID(userId, "User ID");
  await requireAdmin();
  const admin = createAdminClient();

  const { data: profile } = await admin
    .from("profiles")
    .select("status")
    .eq("id", userId)
    .single();
  if (!profile) throw new Error("User not found");
  if (profile.status !== "pending") throw new Error("Can only reject users with pending status");

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/settings");
  });
}

export async function suspendUser(userId: string): Promise<void> {
  return captureAction("admin.suspendUser", async () => {
  validateUUID(userId, "User ID");
  const adminId = await requireAdmin();
  if (userId === adminId) throw new Error("Cannot suspend yourself");
  const admin = createAdminClient();

  const { error } = await admin
    .from("profiles")
    .update({ status: "suspended" as UserStatus })
    .eq("id", userId);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/settings");
  });
}

export async function unsuspendUser(userId: string): Promise<void> {
  return captureAction("admin.unsuspendUser", async () => {
  validateUUID(userId, "User ID");
  await requireAdmin();
  const admin = createAdminClient();

  const { error } = await admin
    .from("profiles")
    .update({ status: "active" as UserStatus })
    .eq("id", userId);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/settings");
  });
}

// ─── Invite Codes ─────────────────────────────────────────

export async function getInviteCodes(): Promise<InviteCode[]> {
  await requireAdmin();
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("invite_codes")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  // Enrich with used_by email
  // DB allows created_by = NULL for legacy seed rows; in practice all admin-
  // created invites have it set. Narrow to empty string if missing so the
  // UI has a consistent shape.
  const codes: InviteCode[] = (data ?? []).map((row) => ({
    ...row,
    created_by: row.created_by ?? "",
  }));
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
  return captureAction("admin.createInviteCode", async () => {
  const adminId = await requireAdmin();
  const admin = createAdminClient();

  if (expiresInDays != null && (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_SHARE_EXPIRY_DAYS)) {
    throw new Error(`Expiry must be between 1 and ${MAX_SHARE_EXPIRY_DAYS} days`);
  }

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
  revalidatePath("/dashboard/settings");
  return code;
  });
}

export async function deleteInviteCode(codeId: string): Promise<void> {
  return captureAction("admin.deleteInviteCode", async () => {
  validateUUID(codeId, "Invite code ID");
  await requireAdmin();
  const admin = createAdminClient();

  const { error } = await admin
    .from("invite_codes")
    .delete()
    .eq("id", codeId)
    .is("used_by", null); // only delete unused codes

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/settings");
  });
}
