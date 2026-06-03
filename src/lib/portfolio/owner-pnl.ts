/**
 * Owner-scoped per-asset transaction read for the per-class holdings pages
 * (crypto / stocks / cash). Server-only.
 *
 * The dashboard + share pages get `pnlByAsset` from {@link assemblePortfolioView}.
 * The three per-class pages call {@link aggregatePortfolio} directly (each with
 * only its own asset class), so they fetch the SAME bulk transaction map here and
 * pass it through as `assetTransactions`. The aggregate then computes per-asset
 * P&L (keyed `crypto:{id}` / `stock:{id}` / `cash:{accountId}`) for the table.
 *
 * GRACEFUL DEGRADATION (mirrors assemble.ts): a thrown read is logged +
 * Sentry-captured and yields `null`, never a 500 — a holdings page must render
 * even if cost data is briefly unavailable; the aggregate then computes no P&L
 * and every P&L cell shows "—". An unauthenticated edge case also yields `null`.
 *
 * OWNER PATH ONLY: uses the RLS-scoped server client + auth.uid(). The share
 * pages do NOT use this — they go through assemblePortfolioView's dual-client
 * (admin + owner_id) path.
 */

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getAllAssetTransactions } from "./asset-transactions";
import type { AssetKey, AssetTransactionRow } from "./asset-transactions";

export async function getOwnerAssetTransactions(): Promise<Map<AssetKey, AssetTransactionRow[]> | null> {
  try {
    const supabase = await createServerSupabaseClient();
    const userId = (await supabase.auth.getUser()).data.user?.id ?? null;
    if (!userId) return null;
    return await getAllAssetTransactions(supabase, userId);
  } catch (e: unknown) {
    console.error("[owner-pnl] getOwnerAssetTransactions failed:", e);
    void import("@sentry/nextjs")
      .then((Sentry) => {
        Sentry.captureException(e, {
          tags: { area: "cost-basis", op: "getOwnerAssetTransactions" },
        });
      })
      .catch(() => {});
    return null;
  }
}
