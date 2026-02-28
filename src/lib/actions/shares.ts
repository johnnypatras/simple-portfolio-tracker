"use server";

import { cache } from "react";
import { revalidatePath } from "next/cache";
import { nanoid } from "nanoid";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// ─── Types ──────────────────────────────────────────────

export type ShareScope = "overview" | "full" | "full_with_history";

export interface ShareLink {
  id: string;
  token: string;
  scope: ShareScope;
  label: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateShareLinkOpts {
  scope?: ShareScope;
  label?: string;
  /** Expiry in days from now. null = never expires. */
  expiresInDays?: number | null;
}

// ─── Validated share result (for layout/pages) ──────────

export interface ValidatedShare {
  id: string;
  owner_id: string;
  scope: ShareScope;
  label: string | null;
}

// ─── Actions ────────────────────────────────────────────

/** Create a new share link. Returns the generated token. */
export async function createShareLink(
  opts: CreateShareLinkOpts = {}
): Promise<string> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const token = nanoid(21);
  const expiresAt =
    opts.expiresInDays != null
      ? new Date(Date.now() + opts.expiresInDays * 86_400_000).toISOString()
      : null;

  const { error } = await supabase.from("portfolio_shares").insert({
    owner_id: user.id,
    share_type: "link",
    token,
    scope: opts.scope ?? "full",
    label: opts.label?.trim() || null,
    expires_at: expiresAt,
  });

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/settings");
  return token;
}

/** Revoke a share (sets revoked_at). */
export async function revokeShare(shareId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { error } = await supabase
    .from("portfolio_shares")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", shareId)
    .eq("owner_id", user.id);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/settings");
}

/** List all link shares created by the current user. */
export async function getMyShares(): Promise<ShareLink[]> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data, error } = await supabase
    .from("portfolio_shares")
    .select("id, token, scope, label, expires_at, revoked_at, created_at, updated_at")
    .eq("owner_id", user.id)
    .eq("share_type", "link")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as ShareLink[];
}

/**
 * Validate a share token. Returns share metadata if valid, null otherwise.
 * Uses service-role client since the caller may be anonymous.
 * Wrapped in React.cache() so layout + page share a single DB call per render.
 */
export const validateShareToken = cache(async (
  token: string
): Promise<ValidatedShare | null> => {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("portfolio_shares")
    .select("id, owner_id, scope, label, expires_at, revoked_at")
    .eq("token", token)
    .eq("share_type", "link")
    .single();

  if (error || !data) return null;

  // Check revocation
  if (data.revoked_at) return null;

  // Check expiry
  if (data.expires_at && new Date(data.expires_at) < new Date()) return null;

  return {
    id: data.id,
    owner_id: data.owner_id,
    scope: data.scope as ShareScope,
    label: data.label,
  };
});
