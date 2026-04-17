"use server";

import { cache } from "react";
import { revalidatePath } from "next/cache";
import { nanoid } from "nanoid";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateName, validateUUID } from "@/lib/validation";
import { MAX_SHARE_EXPIRY_DAYS } from "@/lib/constants";
import type { ShareScope } from "@/lib/share-utils";
import type { ShareLink, CreateShareLinkOpts, ValidatedShare } from "@/lib/types";
import { captureAction } from "@/lib/actions/with-sentry";

// ─── Types ──────────────────────────────────────────────
//
// All public types (ShareLink, CreateShareLinkOpts, ValidatedShare) are
// defined in `@/lib/types`. Turbopack strips type re-exports from
// "use server" modules, so consumers must import from "@/lib/types"
// directly (see `src/components/settings/sharing-settings.tsx`).
// `ShareScope` still lives in the pure `@/lib/share-utils` module and
// callers that need its value (not just type) import it from there.

// ─── Actions ────────────────────────────────────────────

/** Create a new share link. Returns the generated token. */
export async function createShareLink(
  opts: CreateShareLinkOpts = {}
): Promise<string> {
  return captureAction("shares.createShareLink", async () => {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const shareLabel = opts.label?.trim() || null;
  if (shareLabel) validateName(shareLabel, 100, "Share label");

  if (opts.expiresInDays != null && (opts.expiresInDays < 1 / 24 || opts.expiresInDays > MAX_SHARE_EXPIRY_DAYS)) {
    throw new Error(`Expiry must be between 1 hour and ${MAX_SHARE_EXPIRY_DAYS} days`);
  }

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
    label: shareLabel,
    expires_at: expiresAt,
  });

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/settings");
  return token;
  });
}

/** Revoke a share (sets revoked_at). */
export async function revokeShare(shareId: string): Promise<void> {
  return captureAction("shares.revokeShare", async () => {
  validateUUID(shareId, "Share ID");
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
  });
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
  // DB column is nullable because user-type shares don't have tokens;
  // CHECK constraint `share_link_has_token` + `.eq("share_type", "link")`
  // filter above guarantees link-type rows always have a token. Filter
  // null defensively so the domain contract holds at the boundary.
  return (data ?? []).filter((r): r is typeof r & { token: string } => r.token !== null);
}

/**
 * Validate a share token. Returns share metadata if valid, null otherwise.
 * Uses service-role client since the caller may be anonymous.
 * Wrapped in React.cache() so layout + page share a single DB call per render.
 */
export const validateShareToken = cache(async (
  token: string
): Promise<ValidatedShare | null> => {
  // Reject malformed tokens before hitting the DB (nanoid(21) = 21 chars, URL-safe alphabet)
  if (!/^[A-Za-z0-9_-]{21}$/.test(token)) return null;

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
