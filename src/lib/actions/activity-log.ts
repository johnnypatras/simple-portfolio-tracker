"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getFXRates } from "@/lib/prices/fx";
import { captureAction } from "@/lib/actions/with-sentry";
import * as Sentry from "@sentry/nextjs";
import {
  cashAmountField,
  cashDelta,
  positionQtyDelta,
  CASH_ENTITY_TYPES,
  type CashEntityType,
} from "@/lib/deltas";
import { classifyAssetClass } from "@/lib/cashflow";
import { toCsv } from "@/lib/csv";
import { round2 } from "@/lib/format";
import { validateUUID } from "@/lib/validation";
import { MAX_QUERY_LIMIT, ACTIVITY_LOG_DEFAULT_LIMIT, ACTIVITY_LOG_MAX_LIMIT } from "@/lib/constants";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionType, ActivityLog, AssetClass, EntityType, AdjustmentDelta, FlowStatus } from "@/lib/types";
import type { Database } from "@/types/database";
import { normalizeActivityLogRow } from "@/lib/activity-log-normalize";

type ActivityLogInsert = Database["public"]["Tables"]["activity_log"]["Insert"];

// ─── FX conversion helper ───────────────────────────────
// Converts an amount in any currency to both USD and EUR.
// Only called when isAdjustment = true (rare), so one FX call is fine.

export async function toUsdAndEur(
  amount: number,
  currency: string,
  date?: string
): Promise<{ usd: number; eur: number }> {
  if (amount === 0) return { usd: 0, eur: 0 };

  // getFXRates throws on failure — callers must handle or let it propagate.
  // This prevents silently writing wrong deltas (e.g., 1:1 EUR/USD).
  if (currency === "USD") {
    const rates = await getFXRates("USD", ["EUR"], date);
    return { usd: amount, eur: amount * rates.EUR };
  }
  if (currency === "EUR") {
    const rates = await getFXRates("EUR", ["USD"], date);
    return { usd: amount * rates.USD, eur: amount };
  }
  // Other currency → fetch both rates
  const rates = await getFXRates(currency, ["USD", "EUR"], date);
  return {
    usd: amount * rates.USD,
    eur: amount * rates.EUR,
  };
}

// ─── Fire-and-forget activity logger ────────────────────
// Never throws — logging failures must not break mutations.

export async function logActivity(params: {
  action: ActionType;
  entity_type: EntityType;
  entity_name: string;
  description: string;
  details?: Record<string, unknown>;
  entity_id?: string;
  entity_table?: string;
  before_snapshot?: unknown;
  after_snapshot?: unknown;
  is_adjustment?: boolean;
  delta_usd?: number | null;
  delta_eur?: number | null;
  transfer_group_id?: string;
  created_at?: string;
  effective_date?: string;
  // Cashflow tracking (pre-computed at write time)
  cashflow_amount_usd?: number | null;
  cashflow_amount_eur?: number | null;
  cashflow_asset_class?: AssetClass | null;
  cashflow_status?: FlowStatus;
  delta_status?: FlowStatus;
}): Promise<void> {
  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return; // silently bail if unauthenticated

    const row: ActivityLogInsert = {
      user_id: user.id,
      action: params.action,
      entity_type: params.entity_type,
      entity_name: params.entity_name,
      description: params.description,
      details: (params.details ?? null) as ActivityLogInsert["details"],
      entity_id: params.entity_id ?? null,
      entity_table: params.entity_table ?? null,
      before_snapshot: (params.before_snapshot ?? null) as ActivityLogInsert["before_snapshot"],
      after_snapshot: (params.after_snapshot ?? null) as ActivityLogInsert["after_snapshot"],
      is_adjustment: params.is_adjustment ?? false,
      delta_usd: params.delta_usd ?? null,
      delta_eur: params.delta_eur ?? null,
      transfer_group_id: params.transfer_group_id ?? null,
      effective_date: params.effective_date ?? null,
      cashflow_amount_usd: params.cashflow_amount_usd ?? null,
      cashflow_amount_eur: params.cashflow_amount_eur ?? null,
      cashflow_asset_class: params.cashflow_asset_class ?? null,
      cashflow_status: params.cashflow_status ?? null,
      delta_status: params.delta_status ?? null,
    };
    if (params.created_at) row.created_at = params.created_at;
    await supabase.from("activity_log").insert(row);
  } catch (err) {
    // activity_log is the audit-trail substrate for undo, transfers, deltas,
    // and the history view — a silent insert failure here means downstream
    // operations later can't find the entry. Capture so the regression is
    // investigable; do NOT re-throw so the parent mutation completes (the
    // primary action is already successful at this point).
    console.error("[activity-log] Failed to log activity:", err);
    Sentry.captureException(err, {
      tags: { action: "activity-log.logActivity", entity_type: params.entity_type },
      extra: {
        entity_id: params.entity_id,
        entity_table: params.entity_table,
        action_type: params.action,
      },
    });
  }
}

// ─── Fetch activity logs with optional filters ──────────

export async function getActivityLogs(filters?: {
  entity_type?: EntityType;
  action?: ActionType;
  limit?: number;
  offset?: number;
}): Promise<{ logs: ActivityLog[]; total: number }> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  const limit = Math.max(1, Math.min(filters?.limit ?? ACTIVITY_LOG_DEFAULT_LIMIT, ACTIVITY_LOG_MAX_LIMIT));
  const offset = Math.max(0, filters?.offset ?? 0);

  // Build filtered query — exclude split children from main pagination
  let query = supabase
    .from("activity_log")
    .select("*", { count: "exact" })
    .eq("user_id", user.id)
    .is("split_from_id", null)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (filters?.entity_type) {
    query = query.eq("entity_type", filters.entity_type);
  }
  if (filters?.action) {
    query = query.eq("action", filters.action);
  }

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  return {
    logs: (data ?? []).map(normalizeActivityLogRow),
    total: count ?? 0,
  };
}

// ─── Fetch split children for parent entries ────────────

export async function getSplitChildren(parentIds: string[]): Promise<ActivityLog[]> {
  if (parentIds.length === 0) return [];
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from("activity_log")
    .select("*")
    .eq("user_id", user.id)
    .in("split_from_id", parentIds)
    .is("undone_at", null)
    .order("effective_date", { ascending: true });
  if (error) throw new Error(`Failed to fetch split children: ${error.message}`);
  return (data ?? []).map(normalizeActivityLogRow);
}

// ─── Delta computation from snapshots ───────────────────
// Computes the USD/EUR delta for a retroactive adjustment toggle.
// Cash entities: extract amount + currency from snapshots.
// Position entities: extract quantity, look up historical price.

export async function computeDeltaFromSnapshots(
  entityType: string,
  action: ActionType,
  date: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  supabaseOverride?: SupabaseClient
): Promise<{ usd: number; eur: number }> {
  // Cash entities — delta comes from amount/balance fields
  if (CASH_ENTITY_TYPES.includes(entityType as CashEntityType)) {
    const field = cashAmountField(entityType as CashEntityType);
    const beforeAmt = (before?.[field] as number) ?? 0;
    const afterAmt = (after?.[field] as number) ?? 0;
    const currency =
      (after?.currency as string) ?? (before?.currency as string) ?? "USD";

    const delta = cashDelta(action, beforeAmt, afterAmt);

    const txDate = date.split("T")[0];
    return toUsdAndEur(delta, currency, txDate);
  }

  // Position entities — need historical price lookup
  if (entityType === "crypto_position" || entityType === "stock_position") {
    const beforeQty = (before?.quantity as number) ?? 0;
    const afterQty = (after?.quantity as number) ?? 0;

    const qtyDelta = positionQtyDelta(action, beforeQty, afterQty);

    if (Math.abs(qtyDelta) < 1e-12) return { usd: 0, eur: 0 };

    if (entityType === "crypto_position") {
      // Look up crypto asset for coingecko_id
      const assetId =
        (after?.crypto_asset_id as string) ??
        (before?.crypto_asset_id as string);
      if (!assetId) throw new Error(`No crypto_asset_id in snapshots for delta computation`);

      const supabase = supabaseOverride ?? (await createServerSupabaseClient());
      const { data: asset } = await supabase
        .from("crypto_assets")
        .select("coingecko_id")
        .eq("id", assetId)
        .single();
      if (!asset?.coingecko_id) throw new Error(`Crypto asset ${assetId} not found or missing coingecko_id`);

      // Fetch historical price for the date
      const { fetchCoinHistory } = await import("@/lib/prices/coingecko");
      const txDate = date.split("T")[0];
      const daysSince = Math.ceil(
        (Date.now() - new Date(txDate).getTime()) / 86_400_000
      );
      const history = await fetchCoinHistory(
        asset.coingecko_id,
        Math.max(daysSince + 5, 30)
      );

      if (history.length === 0) {
        throw new Error(`CoinGecko returned no price history for ${asset.coingecko_id} (${daysSince} days)`);
      }

      // Find closest price on or before the date
      let priceUsd = 0;
      for (const h of history) {
        if (h.date <= txDate) priceUsd = h.price;
        else break;
      }
      if (priceUsd === 0) priceUsd = history[0].price;

      const deltaUsd = qtyDelta * priceUsd;
      // Convert to EUR
      const rates = await getFXRates("USD", ["EUR"], txDate);
      return { usd: deltaUsd, eur: deltaUsd * rates.EUR };
    }

    if (entityType === "stock_position") {
      // Look up stock asset for yahoo_ticker and currency
      const assetId =
        (after?.stock_asset_id as string) ??
        (before?.stock_asset_id as string);
      if (!assetId) throw new Error(`No stock_asset_id in snapshots for delta computation`);

      const supabase = supabaseOverride ?? (await createServerSupabaseClient());
      const { data: asset } = await supabase
        .from("stock_assets")
        .select("yahoo_ticker, currency")
        .eq("id", assetId)
        .single();
      if (!asset?.yahoo_ticker) throw new Error(`Stock asset ${assetId} not found or missing yahoo_ticker`);

      const { fetchIndexHistory } = await import("@/lib/prices/yahoo");
      const txDate = date.split("T")[0];
      const daysSince = Math.ceil(
        (Date.now() - new Date(txDate).getTime()) / 86_400_000
      );
      const history = await fetchIndexHistory(
        asset.yahoo_ticker,
        Math.max(daysSince + 5, 30)
      );

      if (history.length === 0) {
        throw new Error(`Yahoo returned no price history for ${asset.yahoo_ticker} (${daysSince} days)`);
      }

      // Use null sentinel (not 0) to distinguish "no historical price found
      // on-or-before txDate" from "found price was zero." Audit R1 Phase 5:
      // the old code treated both as missing → fell back to history[0].close
      // → if that was also zero, silently wrote deltaNative = 0 and marked
      // the row 'complete', appearing to apply the adjustment but contributing
      // nothing to the back-fill formula.
      let priceNative: number | null = null;
      for (const h of history) {
        if (h.date <= txDate) priceNative = h.close;
        else break;
      }
      if (priceNative === null) priceNative = history[0].close;
      if (!Number.isFinite(priceNative) || priceNative <= 0) {
        throw new Error(
          `Yahoo returned non-positive price for ${asset.yahoo_ticker} at ${txDate} (price=${priceNative}). Refusing to write zero-valued delta.`,
        );
      }

      const deltaNative = qtyDelta * priceNative;
      return toUsdAndEur(deltaNative, asset.currency ?? "USD", txDate);
    }
  }

  return { usd: 0, eur: 0 };
}

// ─── Toggle adjustment flag ─────────────────────────────
// When toggling ON (becomes adjustment): compute delta, clear cashflow.
// When toggling OFF (becomes non-adjustment): compute cashflow, clear delta.

export async function toggleActivityAdjustment(
  logId: string,
  isAdjustment: boolean
): Promise<void> {
  return captureAction("activity-log.toggleActivityAdjustment", async () => {
  validateUUID(logId, "Activity log ID");
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Fetch full row to access snapshots
  const { data: row, error: fetchErr } = await supabase
    .from("activity_log")
    .select("*")
    .eq("id", logId)
    .eq("user_id", user.id)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);
  if (!row) throw new Error("Activity log entry not found");

  let deltaUsd: number | null = null;
  let deltaEur: number | null = null;
  let deltaStatus: FlowStatus | null = null;
  let cashflowUsd: number | null = null;
  let cashflowEur: number | null = null;
  let cashflowAssetClass: AssetClass | null = null;
  let cashflowStatus: FlowStatus | null = null;

  if (isAdjustment) {
    // Toggling ON (becomes adjustment) → compute delta, clear cashflow
    try {
      const deltas = await computeDeltaFromSnapshots(
        row.entity_type,
        row.action,
        (row.effective_date as string) ?? (row.created_at as string),
        row.before_snapshot as Record<string, unknown> | null,
        row.after_snapshot as Record<string, unknown> | null
      );
      deltaUsd = round2(deltas.usd);
      deltaEur = round2(deltas.eur);
      deltaStatus = "complete";
    } catch (err) {
      console.error("[activity-log] Delta computation failed on toggle:", err instanceof Error ? err.message : err);
      deltaStatus = "pending";
    }
    // Clear cashflow (no longer a real money flow)
    cashflowUsd = null;
    cashflowEur = null;
    cashflowAssetClass = null;
    cashflowStatus = null;
  } else {
    // Toggling OFF (becomes non-adjustment) → compute cashflow, clear delta
    try {
      const values = await computeDeltaFromSnapshots(
        row.entity_type,
        row.action,
        (row.effective_date as string) ?? (row.created_at as string),
        row.before_snapshot as Record<string, unknown> | null,
        row.after_snapshot as Record<string, unknown> | null
      );
      cashflowUsd = round2(values.usd);
      cashflowEur = round2(values.eur);

      // Determine asset class
      const { classifyAssetClass, isStablecoin } = await import("@/lib/cashflow");
      // Check stablecoin status for crypto positions
      let isStable = false;
      if (row.entity_type === "crypto_position") {
        const snap = (row.after_snapshot ?? row.before_snapshot) as Record<string, unknown> | null;
        const assetId = snap?.crypto_asset_id as string | undefined;
        if (assetId) {
          const { data: asset } = await supabase
            .from("crypto_assets")
            .select("subcategory")
            .eq("id", assetId)
            .single();
          isStable = isStablecoin(asset?.subcategory);
        }
      }
      cashflowAssetClass = classifyAssetClass(row.entity_type as EntityType, isStable);
      cashflowStatus = "complete";
    } catch (err) {
      console.error("[activity-log] Cashflow computation failed on toggle:", err instanceof Error ? err.message : err);
      cashflowStatus = "pending";
    }
    // Clear delta (no longer an adjustment)
    deltaUsd = null;
    deltaEur = null;
    deltaStatus = null;
  }

  const { error } = await supabase
    .from("activity_log")
    .update({
      is_adjustment: isAdjustment,
      delta_usd: deltaUsd,
      delta_eur: deltaEur,
      delta_status: deltaStatus,
      cashflow_amount_usd: cashflowUsd,
      cashflow_amount_eur: cashflowEur,
      cashflow_asset_class: cashflowAssetClass,
      cashflow_status: cashflowStatus,
    })
    .eq("id", logId)
    .eq("user_id", user.id);
  if (error) throw new Error(error.message);
  });
}

// ─── Adjustment deltas for chart ────────────────────────
// Returns cumulative adjustment deltas by date for the chart.

export async function getAdjustmentDeltas(
  userId?: string
): Promise<AdjustmentDelta[]> {
  // Admin client path is for Edge Function / cron only — validate UUID to prevent misuse
  if (userId) validateUUID(userId, "User ID");
  const supabase = userId
    ? createAdminClient()
    : await createServerSupabaseClient();

  // On the non-admin path, resolve the authenticated user for explicit user_id filtering
  let resolvedUserId = userId;
  if (!resolvedUserId) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];
    resolvedUserId = user.id;
  }

  // Fetch stablecoin position IDs so we can classify them as cash (matching snapshot logic)
  // Snapshots count stablecoins in cash_value_usd, not crypto_value_usd.
  //
  // Also fetch the IDs of stock_positions whose stock_asset has kind='manual'.
  // Those positions are priced via NAV history (manual_nav_updates) and their
  // historical contribution is added directly to snapshot stocks_value_* by
  // augmentSnapshotsWithManualNavs() in getSnapshots(). Including their
  // is_adjustment activity_log entries in the back-fill formula
  // `value + (finalCumDelta - cumDelta)` would (a) double-count value for
  // dates ≥ effective_date and (b) project today's value onto pre-purchase
  // dates — the user explicitly wants pre-purchase dates to show no asset.
  const [stablecoinRes, manualStockPosRes] = await Promise.all([
    supabase
      .from("crypto_positions")
      .select("id, crypto_assets!inner(subcategory)")
      .ilike("crypto_assets.subcategory", "stablecoin")
      .eq("crypto_assets.user_id", resolvedUserId),
    supabase
      .from("stock_positions")
      .select("id, stock_assets!inner(kind, user_id)")
      .eq("stock_assets.user_id", resolvedUserId)
      .eq("stock_assets.kind", "manual"),
  ]);
  if (stablecoinRes.error) throw new Error(`Failed to load stablecoin positions: ${stablecoinRes.error.message}`);
  if (manualStockPosRes.error) throw new Error(`Failed to load manual stock positions: ${manualStockPosRes.error.message}`);
  const stablecoinPosIds = new Set(
    (stablecoinRes.data ?? []).map((p) => p.id as string)
  );
  const manualStockPosIds = new Set(
    (manualStockPosRes.data ?? []).map((p) => p.id as string)
  );

  const query = supabase
    .from("activity_log")
    .select("created_at, effective_date, delta_usd, delta_eur, entity_type, entity_id, entity_table")
    .eq("is_adjustment", true)
    .eq("user_id", resolvedUserId)
    .is("undone_at", null)
    .not("delta_usd", "is", null)
    .order("created_at", { ascending: true })
    .limit(MAX_QUERY_LIMIT);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  if (!data?.length) return [];

  // Post-sort by effective_date (falls back to created_at date portion)
  // so cumulative sums accumulate in correct chronological order
  const sorted = [...data].sort((a, b) => {
    const dateA = (a.effective_date as string) ?? (a.created_at as string).split("T")[0];
    const dateB = (b.effective_date as string) ?? (b.created_at as string).split("T")[0];
    return dateA.localeCompare(dateB);
  });

  // Entity-type to asset-class mapping
  // Stablecoin crypto_positions are reclassified as cash to match snapshot aggregation
  const getAssetClass = (entityType: string, entityId: string | null, entityTable: string | null): "crypto" | "stocks" | "cash" | null => {
    if (entityType === "crypto_position") {
      // Stablecoins are counted as cash in snapshots (subcategory = 'stablecoin')
      if (entityTable === "crypto_positions" && entityId && stablecoinPosIds.has(entityId)) {
        return "cash";
      }
      return "crypto";
    }
    return classifyAssetClass(entityType as EntityType);
  };

  // Build cumulative sums by date — total + per asset class
  const byDate = new Map<string, {
    usd: number; eur: number;
    cryptoUsd: number; cryptoEur: number;
    stocksUsd: number; stocksEur: number;
    cashUsd: number; cashEur: number;
  }>();

  let cumUsd = 0, cumEur = 0;
  let cryptoUsd = 0, cryptoEur = 0;
  let stocksUsd = 0, stocksEur = 0;
  let cashUsd = 0, cashEur = 0;

  for (const row of sorted) {
    // Skip kind='manual' stock_position entries — they're priced via NAV
    // history and contribute to past snapshots directly through
    // augmentSnapshotsWithManualNavs(). Including them here would double-count
    // post-purchase value and incorrectly project today's value onto
    // pre-purchase dates. The back-fill should stop at effective_date.
    if (
      row.entity_type === "stock_position" &&
      typeof row.entity_id === "string" &&
      manualStockPosIds.has(row.entity_id)
    ) {
      continue;
    }

    const dUsd = (row.delta_usd as number) ?? 0;
    const dEur = (row.delta_eur as number) ?? 0;
    cumUsd += dUsd;
    cumEur += dEur;

    const assetClass = getAssetClass(row.entity_type as string, row.entity_id as string | null, row.entity_table as string | null);
    if (assetClass === "crypto") { cryptoUsd += dUsd; cryptoEur += dEur; }
    else if (assetClass === "stocks") { stocksUsd += dUsd; stocksEur += dEur; }
    else if (assetClass === "cash") { cashUsd += dUsd; cashEur += dEur; }

    const date = (row.effective_date as string) ?? (row.created_at as string).split("T")[0];
    byDate.set(date, {
      usd: cumUsd, eur: cumEur,
      cryptoUsd, cryptoEur,
      stocksUsd, stocksEur,
      cashUsd, cashEur,
    });
  }

  return Array.from(byDate.entries()).map(([date, v]) => ({
    date,
    cumulative_usd: v.usd,
    cumulative_eur: v.eur,
    crypto_cumulative_usd: v.cryptoUsd,
    crypto_cumulative_eur: v.cryptoEur,
    stocks_cumulative_usd: v.stocksUsd,
    stocks_cumulative_eur: v.stocksEur,
    cash_cumulative_usd: v.cashUsd,
    cash_cumulative_eur: v.cashEur,
  }));
}

// ─── CSV export ─────────────────────────────────────────

export async function exportActivityLogsCsv(): Promise<string> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  const { data, error } = await supabase
    .from("activity_log")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(MAX_QUERY_LIMIT);

  if (error) throw new Error(error.message);

  const rows = (data ?? []).map(normalizeActivityLogRow);

  const headers = [
    "Date", "Effective Date", "Action", "Type", "Name", "Description",
    "Adjustment", "Delta USD", "Delta EUR",
    "Transfer Group", "Split From", "Compensates For", "Undone At",
  ];

  const csvRows = rows.map((row) => [
    new Date(row.created_at).toISOString(),
    row.effective_date ?? "",
    row.action,
    row.entity_type,
    row.entity_name,
    row.description,
    row.is_adjustment ? "Yes" : "No",
    row.delta_usd ?? "",
    row.delta_eur ?? "",
    row.transfer_group_id ?? "",
    row.split_from_id ?? "",
    row.compensates_for ?? "",
    row.undone_at ?? "",
  ]);

  return toCsv(headers, csvRows);
}
