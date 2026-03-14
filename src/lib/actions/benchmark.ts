"use server";

import { cache } from "react";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// ─── Cash Flow Event ─────────────────────────────────────

export type AssetClass = "crypto" | "stocks" | "cash";

export interface CashFlowEvent {
  date: string;       // YYYY-MM-DD
  amount_usd: number; // positive = deposit, negative = withdrawal
  amount_eur?: number; // EUR amount via historical rate (avoids USD round-trip for EUR entities)
  asset_class?: AssetClass;
  entity_name?: string;
}

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
  const supabase = userId ? createAdminClient() : await createServerSupabaseClient();

  // Single DB query — all cashflows pre-computed at write time
  let query = supabase
    .from("activity_log")
    .select("cashflow_amount_usd, cashflow_amount_eur, cashflow_asset_class, entity_name, created_at")
    .eq("cashflow_status", "complete")
    .is("undone_at", null)
    .order("created_at", { ascending: true })
    .limit(10000);
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query;

  if (error) {
    console.error("[benchmark] deriveCashFlows query failed:", error.message);
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
  if (userId) {
    pendingQuery = pendingQuery.eq("user_id", userId);
    failedQuery = failedQuery.eq("user_id", userId);
  }
  const [pendingResult, failedResult] = await Promise.all([pendingQuery, failedQuery]);

  return {
    events: (data ?? []).map((row) => ({
      date: (row.created_at as string).split("T")[0],
      amount_usd: (row.cashflow_amount_usd as number) ?? 0,
      amount_eur: (row.cashflow_amount_eur as number) ?? undefined,
      asset_class: (row.cashflow_asset_class as AssetClass) ?? undefined,
      entity_name: (row.entity_name as string) ?? undefined,
    })),
    pendingCount: pendingResult.count ?? 0,
    failedCount: failedResult.count ?? 0,
  };
});
