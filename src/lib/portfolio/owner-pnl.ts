/**
 * Owner-scoped and share-page per-asset transaction reads for the per-class
 * holdings pages (crypto / stocks / cash). Server-only.
 *
 * The dashboard + share overview pages get `pnlByAsset` from
 * {@link assemblePortfolioView}. The three per-class pages call
 * {@link aggregatePortfolio} directly (each with only its own asset class),
 * so they fetch the SAME bulk transaction map and pass it through as
 * `assetTransactions`. The aggregate then computes per-asset P&L (keyed
 * `crypto:{id}` / `stock:{id}` / `cash:{accountId}`) for the table.
 *
 * GRACEFUL DEGRADATION (mirrors assemble.ts): a thrown read is logged +
 * Sentry-captured and yields `null`, never a 500 — a holdings page must render
 * even if cost data is briefly unavailable; the aggregate then computes no P&L
 * and every P&L cell shows "—". An unauthenticated edge case also yields `null`.
 *
 * {@link safeGetAllAssetTransactions} is the shared try/catch+Sentry wrapper
 * used by BOTH the owner path and the share-page path. It accepts the already-
 * resolved client + userId so neither caller needs to duplicate that plumbing.
 *
 * SECURITY: the share-page callers MUST pass the service-role admin client
 * and the share's verified `owner_id` (NOT the viewer's session userId). The
 * admin client bypasses RLS, so the explicit userId is the only scope guard —
 * getAllAssetTransactions enforces it with .eq("user_id", userId) everywhere.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getAllAssetTransactions } from "./asset-transactions";
import type { AssetKey, AssetTransactionRow } from "./asset-transactions";

/**
 * Shared graceful-degradation wrapper around {@link getAllAssetTransactions}.
 * Logs + Sentry-captures a thrown read and returns `null` so the calling page
 * never 500s due to a cost-data failure.
 *
 * OWNER path: call with the RLS-scoped server client + the authenticated
 * user's id (`auth.uid()`).
 *
 * SHARE-PAGE path: call with the service-role admin client + the share's
 * verified `owner_id`. Because the admin client bypasses RLS, the `userId`
 * arg is the ONLY scope guard — never pass a viewer's session id here.
 *
 * @param client  - Supabase client (RLS-scoped or admin, per path).
 * @param userId  - User id that scopes EVERY query inside getAllAssetTransactions.
 * @param opTag   - Short string for the Sentry `op` tag (e.g. "getOwnerAssetTransactions").
 */
export async function safeGetAllAssetTransactions(
  client: SupabaseClient<Database>,
  userId: string,
  opTag: string,
): Promise<Map<AssetKey, AssetTransactionRow[]> | null> {
  try {
    return await getAllAssetTransactions(client, userId);
  } catch (e: unknown) {
    console.error(`[owner-pnl] ${opTag} failed:`, e);
    void import("@sentry/nextjs")
      .then((Sentry) => {
        Sentry.captureException(e, {
          tags: { area: "cost-basis", op: opTag },
        });
      })
      .catch(() => {});
    return null;
  }
}

/**
 * OWNER PATH: reads the authenticated user's per-asset transaction map via the
 * RLS-scoped server client + session `auth.uid()`. Returns `null` if the user
 * is not authenticated or if the read throws (graceful degradation).
 */
export async function getOwnerAssetTransactions(): Promise<Map<AssetKey, AssetTransactionRow[]> | null> {
  const supabase = await createServerSupabaseClient();
  const userId = (await supabase.auth.getUser()).data.user?.id ?? null;
  if (!userId) return null;
  return safeGetAllAssetTransactions(supabase, userId, "getOwnerAssetTransactions");
}
