"use server";

import { cache } from "react";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateUUID } from "@/lib/validation";
import { MAX_QUERY_LIMIT } from "@/lib/constants";

// ─── Cash Flow Event ─────────────────────────────────────

import type { AssetClass, CashFlowEvent } from "@/lib/types";

/**
 * Derive cash flow events from the activity log.
 *
 * Cash flow amounts are pre-computed at write time and stored in
 * cashflow_amount_usd / cashflow_amount_eur columns. This function
 * performs a single DB query instead of fetching historical prices.
 */
export const deriveCashFlows = cache(async function deriveCashFlows(
  userId?: string
): Promise<{
  events: CashFlowEvent[];
  pendingCount: number;
  failedCount: number;
}> {
  if (userId) validateUUID(userId, "User ID");
  const supabase = userId ? createAdminClient() : await createServerSupabaseClient();

  // Resolve user ID for explicit row-level filtering on non-admin path
  const resolvedUserId = userId ?? (await supabase.auth.getUser()).data.user?.id;

  // Single DB query — all cashflows pre-computed at write time
  let query = supabase
    .from("activity_log")
    .select("cashflow_amount_usd, cashflow_amount_eur, cashflow_asset_class, entity_name, created_at, effective_date")
    .eq("cashflow_status", "complete")
    .is("undone_at", null)
    .order("created_at", { ascending: true })
    .limit(MAX_QUERY_LIMIT);
  if (resolvedUserId) query = query.eq("user_id", resolvedUserId);
  const { data, error } = await query;

  if (error) {
    console.error("[benchmark] deriveCashFlows query failed:", error.message);
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureException(new Error(`deriveCashFlows query failed: ${error.message}`));
    return { events: [], pendingCount: 0, failedCount: 0 };
  }

  // Pending/failed counts for UI warning
  let pendingQuery = supabase
    .from("activity_log")
    .select("*", { count: "exact", head: true })
    .is("undone_at", null)
    .or("cashflow_status.eq.pending,delta_status.eq.pending");
  let failedQuery = supabase
    .from("activity_log")
    .select("*", { count: "exact", head: true })
    .is("undone_at", null)
    .or("cashflow_status.eq.failed,delta_status.eq.failed");
  if (resolvedUserId) {
    pendingQuery = pendingQuery.eq("user_id", resolvedUserId);
    failedQuery = failedQuery.eq("user_id", resolvedUserId);
  }
  const [pendingResult, failedResult] = await Promise.all([pendingQuery, failedQuery]);

  // Log (but don't throw) when the pending/failed counts can't be fetched —
  // silently returning 0 hides operational problems from the stale banner.
  if (pendingResult.error) {
    console.error("[deriveCashFlows] pendingCount query failed:", pendingResult.error.message);
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureException(new Error(`deriveCashFlows pendingCount failed: ${pendingResult.error.message}`));
  }
  if (failedResult.error) {
    console.error("[deriveCashFlows] failedCount query failed:", failedResult.error.message);
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureException(new Error(`deriveCashFlows failedCount failed: ${failedResult.error.message}`));
  }

  // Post-sort by effective_date (falls back to created_at date portion)
  // so cashflow events appear in correct chronological order
  const sorted = [...(data ?? [])].sort((a, b) => {
    const dateA = (a.effective_date as string) ?? (a.created_at as string).split("T")[0];
    const dateB = (b.effective_date as string) ?? (b.created_at as string).split("T")[0];
    return dateA.localeCompare(dateB);
  });

  return {
    events: sorted.map((row) => ({
      date: (row.effective_date as string) ?? (row.created_at as string).split("T")[0],
      amount_usd: (row.cashflow_amount_usd as number) ?? 0,
      amount_eur: (row.cashflow_amount_eur as number) ?? undefined,
      asset_class: (row.cashflow_asset_class as AssetClass) ?? undefined,
      entity_name: (row.entity_name as string) ?? undefined,
    })),
    pendingCount: pendingResult.count ?? 0,
    failedCount: failedResult.count ?? 0,
  };
});
