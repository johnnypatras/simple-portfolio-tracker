// Server-only module (no "use server"): an internal render-time helper, NOT a
// client-callable action. It accepts a userId arg and is meant for server-side
// dedup only — server-only is enforced by the createServerSupabaseClient import
// (uses next/headers). Mirrors historical-inputs-cache.ts.
import { cache } from "react";
import * as Sentry from "@sentry/nextjs";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAllAssetTransactions } from "./asset-transactions";
import type { AssetKey, AssetTransactionRow } from "./asset-transactions";

/**
 * Request-cached wrapper around getAllAssetTransactions for the authenticated-user
 * (server-client / RLS) path. The bulk read is 8+ paginated round-trips and runs
 * TWICE per dashboard render — assemblePortfolioView (pnlByAsset) and
 * fetchCostBasisSeriesAssets (the cost-basis series, via the benchmark extension).
 * React cache() dedups them to ONE execution. Keyed on userId (string) — passing
 * the supabase client object would defeat cache() arg-identity dedup (a fresh
 * client per call would never hit).
 *
 * Owns graceful degradation + a single Sentry capture: never throws. On any
 * failure returns an EMPTY map so the P&L / series degrade to "no cost data"
 * (purely additive — every P&L cell shows "—") instead of 500-ing the dashboard.
 *
 * Admin / cross-user (share, comparison) callers must use the sibling
 * getAllAssetTransactionsForOwner(ownerId) below — this wrapper is
 * server-client/current-user only.
 */
export const getAllAssetTransactionsCached = cache(
  async (userId: string): Promise<Map<AssetKey, AssetTransactionRow[]>> => {
    try {
      const supabase = await createServerSupabaseClient();
      return await getAllAssetTransactions(supabase, userId);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { context: "asset-transactions-cache.getAllAssetTransactionsCached" },
      });
      return new Map();
    }
  },
);

/**
 * Admin-client variant of getAllAssetTransactionsCached for the share / cross-user
 * (owner_id) path. React cache() dedups across assemblePortfolioView (with
 * ownerUserId) + getHistoricalBenchmarkExtension(owner_id) within one share
 * render — both are passed the SAME verified share.owner_id, so they share the
 * cache key. Keyed on ownerId (string) — the admin client is a fresh object per
 * call, so keying on it would defeat dedup. Owns graceful degradation: never
 * throws; on any failure returns an empty map so a cost-data hiccup can't
 * error-pin the PUBLIC share link.
 *
 * SECURITY: callers MUST pass a server-validated ownerId (from a verified share
 * token). This wrapper does NOT validate the token — that's the caller's job. The
 * admin client bypasses RLS by design; getAllAssetTransactions enforces the
 * ownerId scope with .eq("user_id", ownerId) on every query.
 */
export const getAllAssetTransactionsForOwner = cache(
  async (ownerId: string): Promise<Map<AssetKey, AssetTransactionRow[]>> => {
    try {
      const admin = createAdminClient();
      return await getAllAssetTransactions(admin, ownerId);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { context: "asset-transactions-cache.getAllAssetTransactionsForOwner" },
      });
      return new Map();
    }
  },
);
