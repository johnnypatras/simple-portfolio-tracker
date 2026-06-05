"use server";

import { cache } from "react";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateUUID } from "@/lib/validation";
import { ALL_SNAPSHOTS_DAYS } from "@/lib/constants";
import { fetchAllPaginated } from "@/lib/supabase/pagination";

// ─── Cash Flow Event ─────────────────────────────────────

import type { AssetClass, CashFlowEvent } from "@/lib/types";
import {
  buildBenchmarkCashFlows,
  buildCostBasisSeries,
  buildCostBasisDateSpine,
  fetchCostBasisSeriesAssets,
  type CostBasisSeriesPoint,
  type HistoricalPriceRow,
} from "@/lib/portfolio/historical-prices-augmentation";
import {
  getHistoricalPriceInputs,
  getHistoricalPriceInputsForOwner,
} from "@/lib/actions/historical-inputs-cache";

/**
 * Derive cash flow events from the activity log.
 *
 * Cash flow amounts are pre-computed at write time and stored in
 * cashflow_amount_usd / cashflow_amount_eur columns. This function
 * performs a single DB query instead of fetching historical prices.
 *
 * Model B (2026-06-05): yield rows (is_yield=true) ARE included. Earned income
 * STARTS participating in the S&P replay the day it enters the portfolio, at its
 * market value on the receipt date — like any inflow. The "one rule": money
 * starts counting when it enters, keeps counting through every internal change,
 * stops counting when it leaves; yield received is money entering. Each yielded
 * row carries `is_yield: true` on the event so consumers (e.g. the deposits
 * tooltip) can label it separately from a deposit/buy.
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

  // All cashflows pre-computed at write time. Paginate past the PostgREST
  // max_rows cap (default 1000): post-Phase-4 the S&P benchmark depends
  // ENTIRELY on this stream, so a heavy-DCA user with >1000 cashflow rows would
  // otherwise get a silently-truncated benchmark on every page. A plain
  // `.limit(10_000)` does NOT lift the server cap — only `.range()` paging does.
  // `.order(...)` MUST precede `.range(...)`; the `id` tiebreaker (UUID PK)
  // guarantees deterministic page boundaries when rows share a created_at.
  type CashflowRow = {
    cashflow_amount_usd: number | null;
    cashflow_amount_eur: number | null;
    cashflow_asset_class: string | null;
    entity_name: string | null;
    created_at: string;
    effective_date: string | null;
    is_yield: boolean;
  };
  let data: CashflowRow[];
  try {
    data = await fetchAllPaginated<CashflowRow>((from, to) => {
      // Apply all filters BEFORE .order()/.range() (PostgREST deterministic-
      // pagination idiom; mirrors historical-prices-augmentation.ts). The
      // user_id scope is part of the filter set on the non-admin path.
      const base = supabase
        .from("activity_log")
        .select("cashflow_amount_usd, cashflow_amount_eur, cashflow_asset_class, entity_name, created_at, effective_date, is_yield")
        .eq("cashflow_status", "complete")
        .is("undone_at", null);
      const scoped = resolvedUserId ? base.eq("user_id", resolvedUserId) : base;
      return scoped
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    }, 1000, { label: "cashflows" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[benchmark] deriveCashFlows query failed:", message);
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureException(
      err instanceof Error ? err : new Error(`deriveCashFlows query failed: ${message}`),
    );
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
      // Model B: flag earned income so consumers can label it (deposits tooltip).
      // Optional field — synthetic flows + non-yield rows never set it.
      is_yield: row.is_yield === true ? true : undefined,
    })),
    pendingCount: pendingResult.count ?? 0,
    failedCount: failedResult.count ?? 0,
  };
});

/**
 * Phase 2 + cost-basis seed (Task 3.4b): inputs for extending the S&P benchmark
 * back over Phase 1's synthesized range, PLUS the portfolio-wide per-class
 * running cost-basis series the chart-enrichment seed re-anchor consumes.
 *   - earliestDate: the earliest backdated effective_date (null if none) — the
 *     caller sizes the ^SP500TR history fetch to reach it.
 *   - syntheticCashFlows: benchmark-only cash flows for is_adjustment backdated
 *     lots (absent from deriveCashFlows). Merge into the chart's cashFlows.
 *   - costBasisSeries: per-class running COST + market-minus-cost GAP over the
 *     daily spine (Task 3.4a). Computed over ALL the user's positions —
 *     INDEPENDENT of the backdated-lot gate below, so a user with only
 *     non-backdated user-costed buys still gets a series (the seed needs it).
 *
 * Client selection mirrors deriveCashFlows: explicit userId → admin client
 * (cross-user share/comparison); omitted → authenticated server client (RLS).
 * Prices are already cached by Phase 1's getSnapshots on the same render, so the
 * price read is a cheap cache hit; the series reuses that SAME `prices` index
 * (it already carries the widened user-costed coverage from fetchHistoricalPriceInputsFor).
 */
export async function getHistoricalBenchmarkExtension(
  userId?: string,
): Promise<{
  earliestDate: string | null;
  syntheticCashFlows: CashFlowEvent[];
  sp500Days: number;
  costBasisSeries: CostBasisSeriesPoint[];
}> {
  if (userId) validateUUID(userId, "User ID");
  // Resolve the user. On the current-user path we read the session via the
  // server client; on the share/comparison path the caller-supplied userId is
  // authoritative.
  const resolvedUserId =
    userId ?? (await (await createServerSupabaseClient()).auth.getUser()).data.user?.id;
  if (!resolvedUserId) {
    return { earliestDate: null, syntheticCashFlows: [], sp500Days: ALL_SNAPSHOTS_DAYS, costBasisSeries: [] };
  }

  // Route both paths through request-cached + graceful wrappers so a single
  // render shares ONE fetchHistoricalPriceInputsFor execution per user (React
  // cache() keyed on the userId string), and a transient price/FX/DB failure
  // degrades to empty inputs instead of throwing:
  //   • current-user (server-client / RLS): getHistoricalPriceInputs dedups
  //     with getSnapshots in the same dashboard render.
  //   • cross-user share/comparison (explicit userId → admin client):
  //     getHistoricalPriceInputsForOwner dedups with getSharedPortfolio's own
  //     augmentation fetch in the same share render — and, critically, never
  //     throws, so a price/FX hiccup can't error-pin the PUBLIC share link.
  const { lots, prices } = userId
    ? await getHistoricalPriceInputsForOwner(resolvedUserId)
    : await getHistoricalPriceInputs(resolvedUserId);

  // ── Cost-basis series (Task 3.4b) — computed INDEPENDENTLY of the backdated
  // lot gate. A user with only non-backdated user-costed buys has lots.length===0
  // but still needs the series for the seed. Own try/catch so a series failure
  // never breaks the synthetic-flows path (and vice versa). Same dual-client
  // contract: explicit userId → admin (share/comparison); else server (RLS).
  const costBasisSeries = await buildCostBasisSeriesFor(resolvedUserId, !!userId, prices);

  // ── Synthetic benchmark cash flows + sp500Days — KEEP the backdated-lot gate.
  // Without backdated lots there is nothing to back-extend the S&P over.
  if (lots.length === 0) {
    return { earliestDate: null, syntheticCashFlows: [], sp500Days: ALL_SNAPSHOTS_DAYS, costBasisSeries };
  }

  let earliestDate: string | null = null;
  for (const lot of lots) {
    for (const d of lot.deltas) {
      if (earliestDate === null || d.effective_date < earliestDate) {
        earliestDate = d.effective_date;
      }
    }
  }

  // Size the S&P history so fetchIndexHistory reaches the earliest backdated
  // date. Fall back to ALL_SNAPSHOTS_DAYS when there are no backdated lots.
  const sp500Days = earliestDate
    ? Math.max(
        ALL_SNAPSHOTS_DAYS,
        Math.ceil(
          (Date.now() - new Date(`${earliestDate}T00:00:00Z`).getTime()) / 86_400_000,
        ),
      )
    : ALL_SNAPSHOTS_DAYS;

  return {
    earliestDate,
    syntheticCashFlows: buildBenchmarkCashFlows(lots, prices),
    sp500Days,
    costBasisSeries,
  };
}

/**
 * Build the per-class cost-basis series for `userId`, degrading to [] on any
 * failure (a series hiccup must never break the benchmark or, on the share path,
 * error-pin the public link). `isOwnerPath` selects the client: admin (explicit
 * owner_id from a verified share token / comparison) vs RLS-scoped server client.
 *
 * Reuses the SAME `prices` index the value line fetched (already widened to cover
 * user-costed assets back to the chart start), so no extra price fetch happens.
 */
async function buildCostBasisSeriesFor(
  userId: string,
  isOwnerPath: boolean,
  prices: HistoricalPriceRow[],
): Promise<CostBasisSeriesPoint[]> {
  try {
    // The bulk transaction read inside fetchCostBasisSeriesAssets is request-cached
    // (asset-transactions-cache.ts) and keyed on userId, so it dedups with
    // assemblePortfolioView's read in the same render — pass isOwnerPath so it
    // picks the matching cached wrapper. This `client` still serves the asset-meta
    // loads inside that function.
    const client = isOwnerPath ? createAdminClient() : await createServerSupabaseClient();
    const assets = await fetchCostBasisSeriesAssets(client, userId, isOwnerPath);
    const today = new Date().toISOString().slice(0, 10);
    const dates = buildCostBasisDateSpine(assets, today);
    if (dates.length === 0) return [];
    const { series, uncoveredGapLots } = buildCostBasisSeries({ assets, prices, dates });
    if (uncoveredGapLots > 0) {
      // Visibility: the seed under-covers somewhere (a user-costed lot had no
      // cached price on some day). Not fatal — the gap simply reads 0 there.
      const Sentry = await import("@sentry/nextjs");
      Sentry.captureMessage("cost-basis series: uncovered gap lots", {
        level: "warning",
        extra: { userId, uncoveredGapLots, spineDays: dates.length },
      });
    }
    return series;
  } catch (err) {
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureException(
      err instanceof Error ? err : new Error(`cost-basis series build failed: ${String(err)}`),
      { tags: { context: "benchmark.buildCostBasisSeriesFor" } },
    );
    return [];
  }
}
