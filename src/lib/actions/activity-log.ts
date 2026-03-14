"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getFXRates } from "@/lib/prices/fx";
import {
  cashAmountField,
  cashDelta,
  positionQtyDelta,
  type CashEntityType,
} from "@/lib/deltas";
import { toCsv } from "@/lib/csv";
import { validateUUID } from "@/lib/validation";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionType, ActivityLog, EntityType } from "@/lib/types";

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
  // Cashflow tracking (pre-computed at write time)
  cashflow_amount_usd?: number | null;
  cashflow_amount_eur?: number | null;
  cashflow_asset_class?: string | null;
  cashflow_status?: "complete" | "pending" | null;
  delta_status?: "complete" | "pending" | null;
}): Promise<void> {
  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return; // silently bail if unauthenticated

    await supabase.from("activity_log").insert({
      user_id: user.id,
      action: params.action,
      entity_type: params.entity_type,
      entity_name: params.entity_name,
      description: params.description,
      details: params.details ?? null,
      entity_id: params.entity_id ?? null,
      entity_table: params.entity_table ?? null,
      before_snapshot: params.before_snapshot ?? null,
      after_snapshot: params.after_snapshot ?? null,
      is_adjustment: params.is_adjustment ?? false,
      delta_usd: params.delta_usd ?? null,
      delta_eur: params.delta_eur ?? null,
      transfer_group_id: params.transfer_group_id ?? null,
      ...(params.created_at ? { created_at: params.created_at } : {}),
      cashflow_amount_usd: params.cashflow_amount_usd ?? null,
      cashflow_amount_eur: params.cashflow_amount_eur ?? null,
      cashflow_asset_class: params.cashflow_asset_class ?? null,
      cashflow_status: params.cashflow_status ?? null,
      delta_status: params.delta_status ?? null,
    });
  } catch (err) {
    console.error("[activity-log] Failed to log activity:", err);
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
  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  // Build filtered query
  let query = supabase
    .from("activity_log")
    .select("*", { count: "exact" })
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
    logs: (data ?? []) as ActivityLog[],
    total: count ?? 0,
  };
}

// ─── Delta computation from snapshots ───────────────────
// Computes the USD/EUR delta for a retroactive adjustment toggle.
// Cash entities: extract amount + currency from snapshots.
// Position entities: extract quantity, look up historical price.

export async function computeDeltaFromSnapshots(
  entityType: string,
  action: string,
  date: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  supabaseOverride?: SupabaseClient
): Promise<{ usd: number; eur: number }> {
  // Cash entities — delta comes from amount/balance fields
  if (
    entityType === "bank_account" ||
    entityType === "exchange_deposit" ||
    entityType === "broker_deposit"
  ) {
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

      let priceNative = 0;
      for (const h of history) {
        if (h.date <= txDate) priceNative = h.close;
        else break;
      }
      if (priceNative === 0) priceNative = history[0].close;

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
  validateUUID(logId, "Activity log ID");
  const supabase = await createServerSupabaseClient();

  // Fetch full row to access snapshots
  const { data: row, error: fetchErr } = await supabase
    .from("activity_log")
    .select("*")
    .eq("id", logId)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);
  if (!row) throw new Error("Activity log entry not found");

  let deltaUsd: number | null = null;
  let deltaEur: number | null = null;
  let deltaStatus: string | null = null;
  let cashflowUsd: number | null = null;
  let cashflowEur: number | null = null;
  let cashflowAssetClass: string | null = null;
  let cashflowStatus: string | null = null;

  if (isAdjustment) {
    // Toggling ON (becomes adjustment) → compute delta, clear cashflow
    try {
      const deltas = await computeDeltaFromSnapshots(
        row.entity_type,
        row.action,
        row.created_at,
        row.before_snapshot as Record<string, unknown> | null,
        row.after_snapshot as Record<string, unknown> | null
      );
      deltaUsd = Math.round(deltas.usd * 100) / 100;
      deltaEur = Math.round(deltas.eur * 100) / 100;
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
        row.created_at,
        row.before_snapshot as Record<string, unknown> | null,
        row.after_snapshot as Record<string, unknown> | null
      );
      cashflowUsd = Math.round(values.usd * 100) / 100;
      cashflowEur = Math.round(values.eur * 100) / 100;

      // Determine asset class
      const { classifyAssetClass } = await import("@/lib/cashflow");
      // Check stablecoin status for crypto positions
      let isStablecoin = false;
      if (row.entity_type === "crypto_position") {
        const snap = (row.after_snapshot ?? row.before_snapshot) as Record<string, unknown> | null;
        const assetId = snap?.crypto_asset_id as string | undefined;
        if (assetId) {
          const { data: asset } = await supabase
            .from("crypto_assets")
            .select("subcategory")
            .eq("id", assetId)
            .single();
          isStablecoin = asset?.subcategory?.toLowerCase() === "stablecoin";
        }
      }
      cashflowAssetClass = classifyAssetClass(row.entity_type, isStablecoin);
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
    .eq("id", logId);
  if (error) throw new Error(error.message);
}

// ─── Adjustment deltas for chart ────────────────────────
// Returns cumulative adjustment deltas by date for the chart.

export interface AdjustmentDelta {
  date: string;
  cumulative_usd: number;
  cumulative_eur: number;
  crypto_cumulative_usd: number;
  crypto_cumulative_eur: number;
  stocks_cumulative_usd: number;
  stocks_cumulative_eur: number;
  cash_cumulative_usd: number;
  cash_cumulative_eur: number;
}

export async function getAdjustmentDeltas(
  userId?: string
): Promise<AdjustmentDelta[]> {
  const supabase = userId
    ? createAdminClient()
    : await createServerSupabaseClient();

  // Fetch stablecoin position IDs so we can classify them as cash (matching snapshot logic)
  // Snapshots count stablecoins in cash_value_usd, not crypto_value_usd
  const { data: stablecoinPositions } = await supabase
    .from("crypto_positions")
    .select("id, crypto_assets!inner(subcategory)")
    .ilike("crypto_assets.subcategory", "stablecoin");
  const stablecoinPosIds = new Set(
    (stablecoinPositions ?? []).map((p) => p.id as string)
  );

  let query = supabase
    .from("activity_log")
    .select("created_at, delta_usd, delta_eur, entity_type, entity_id, entity_table")
    .eq("is_adjustment", true)
    .is("undone_at", null)
    .not("delta_usd", "is", null)
    .order("created_at", { ascending: true })
    .limit(10000);

  if (userId) {
    query = query.eq("user_id", userId);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  if (!data?.length) return [];

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
    if (entityType === "stock_position") return "stocks";
    if (entityType === "bank_account" || entityType === "exchange_deposit" || entityType === "broker_deposit") return "cash";
    return null;
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

  for (const row of data) {
    const dUsd = (row.delta_usd as number) ?? 0;
    const dEur = (row.delta_eur as number) ?? 0;
    cumUsd += dUsd;
    cumEur += dEur;

    const assetClass = getAssetClass(row.entity_type as string, row.entity_id as string | null, row.entity_table as string | null);
    if (assetClass === "crypto") { cryptoUsd += dUsd; cryptoEur += dEur; }
    else if (assetClass === "stocks") { stocksUsd += dUsd; stocksEur += dEur; }
    else if (assetClass === "cash") { cashUsd += dUsd; cashEur += dEur; }

    const date = (row.created_at as string).split("T")[0];
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
  const { data, error } = await supabase
    .from("activity_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(10000);

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as ActivityLog[];

  const headers = [
    "Date", "Action", "Type", "Name", "Description",
    "Adjustment", "Delta USD", "Delta EUR",
    "Transfer Group", "Compensates For", "Undone At",
  ];

  const csvRows = rows.map((row) => [
    new Date(row.created_at).toISOString(),
    row.action,
    row.entity_type,
    row.entity_name,
    row.description,
    row.is_adjustment ? "Yes" : "No",
    row.delta_usd ?? "",
    row.delta_eur ?? "",
    row.transfer_group_id ?? "",
    row.compensates_for ?? "",
    row.undone_at ?? "",
  ]);

  return toCsv(headers, csvRows);
}
