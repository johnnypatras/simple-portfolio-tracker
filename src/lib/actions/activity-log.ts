"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
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
import { toCsv } from "@/lib/csv";
import { round2 } from "@/lib/format";
import { validateUUID } from "@/lib/validation";
import { ACTIVITY_LOG_DEFAULT_LIMIT, ACTIVITY_LOG_MAX_LIMIT } from "@/lib/constants";
import { fetchAllPaginated } from "@/lib/supabase/pagination";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionType, ActivityLog, AssetClass, EntityType, FlowStatus, ToggleAdjustmentResult } from "@/lib/types";
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
      // Look up crypto asset for coingecko_id + ticker. The ticker drives the
      // Yahoo `{TICKER}-USD` symbol (e.g. BTC-USD); coingecko_id is the
      // obscure-coin fallback source.
      const assetId =
        (after?.crypto_asset_id as string) ??
        (before?.crypto_asset_id as string);
      if (!assetId) throw new Error(`No crypto_asset_id in snapshots for delta computation`);

      const supabase = supabaseOverride ?? (await createServerSupabaseClient());
      const { data: asset } = await supabase
        .from("crypto_assets")
        .select("coingecko_id, ticker")
        .eq("id", assetId)
        .single();
      if (!asset?.coingecko_id) throw new Error(`Crypto asset ${assetId} not found or missing coingecko_id`);

      const txDate = date.split("T")[0];

      // PRIMARY: Yahoo `{TICKER}-USD` daily history. Unlike CoinGecko's
      // market_chart (Demo plan caps at ~365 days), Yahoo serves multi-year
      // history, so backdated lots older than a year reconstruct correctly.
      // This matches historical-prices-augmentation.ts, which prices the same
      // backdated crypto lot on the chart via `${ticker.toUpperCase()}-USD`.
      // Both paths MUST agree so the benchmark seed reconciles.
      let priceUsd = 0;
      if (asset.ticker) {
        const { fetchYahooDailyHistory } = await import("@/lib/prices/historical");
        const yahooSymbol = `${asset.ticker.toUpperCase()}-USD`;
        const yahooHistory = await fetchYahooDailyHistory(yahooSymbol, txDate, txDate);
        // fetchYahooDailyHistory already pads the start edge (RANGE_PAD_DAYS) so
        // a prior trading day exists to forward-fill from. Walk on-or-before.
        for (const h of yahooHistory) {
          if (h.date <= txDate) priceUsd = h.price;
          else break;
        }
        if (priceUsd === 0 && yahooHistory.length > 0) priceUsd = yahooHistory[0].price;
      }

      // FALLBACK: CoinGecko market_chart for obscure coins not on Yahoo (Yahoo
      // returned []). Subject to the ~365-day Demo-plan cap — best-effort only.
      if (priceUsd === 0) {
        const { fetchCoinHistory } = await import("@/lib/prices/coingecko");
        const daysSince = Math.ceil(
          (Date.now() - new Date(txDate).getTime()) / 86_400_000
        );
        const history = await fetchCoinHistory(
          asset.coingecko_id,
          Math.max(daysSince + 5, 30)
        );
        for (const h of history) {
          if (h.date <= txDate) priceUsd = h.price;
          else break;
        }
        if (priceUsd === 0 && history.length > 0) priceUsd = history[0].price;
      }

      if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        throw new Error(
          `No positive historical price for crypto asset ${assetId} (ticker=${asset.ticker ?? "?"}, coingecko_id=${asset.coingecko_id}) at ${txDate} from Yahoo or CoinGecko. Refusing to write zero-valued delta.`,
        );
      }

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
//
// Returns `{ status, changed }` (ToggleAdjustmentResult). `status` is the
// FlowStatus of the side this call computed (R2-4): when toggling OFF that's
// `cashflow_status`, when toggling ON it's `delta_status`. It is 'complete' on
// a successful price fetch and 'pending' when the fetch failed (the row's flag
// still flips, but the cashflow/delta is unresolved and self-heals via the
// backfill cron). `changed` is true on a real flip and false on the M1
// idempotency no-op (row already in the requested state); the migration loop
// counts only real flips so concurrent runs can't double-claim a row (F3), and
// uses `status` to tally `pending` rows honestly. The no-op echoes the row's
// CURRENT status for the requested direction (the already-fetched
// `row.cashflow_status` / `row.delta_status` — no extra query). The UI caller
// (activity-timeline.tsx) ignores the return value.
//
// `FlowStatus` already includes `null`, so no widening is needed for rows that
// never had a status written.

/**
 * Narrow a DB enum-text status column (typed `string | null` in the generated
 * Database types) to the `FlowStatus` domain union at the query boundary.
 * Unknown values collapse to `null` — this validates rather than blindly
 * asserts, so a stray DB value can never masquerade as 'pending'/'complete'.
 */
function toFlowStatus(value: string | null): FlowStatus {
  if (value === "complete" || value === "pending" || value === "failed") return value;
  return null;
}

export async function toggleActivityAdjustment(
  logId: string,
  isAdjustment: boolean
): Promise<ToggleAdjustmentResult> {
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

  // Defense-in-depth (H4): transfer legs MUST stay is_adjustment=true so the
  // S&P benchmark ignores them — flipping one to false recreates the phantom
  // bulk-deposit bug. Undone rows are tombstones; toggling them is meaningless
  // and would re-derive cashflow for a reversed action. The migration's
  // candidate filter already excludes both, but the UI toggle and any future
  // caller don't — guard at the primitive.
  if (row.transfer_group_id !== null) throw new Error("Cannot toggle adjustment on transfer legs");
  if (row.undone_at !== null) throw new Error("Cannot toggle adjustment on undone entries");

  // Idempotency (M1): already at the requested value → no-op. Avoids a
  // redundant 1–8s historical-price fetch + a no-op UPDATE when a concurrent
  // migration already flipped this row. Return the row's CURRENT status for
  // the requested direction (R2-4) — the side this call WOULD have computed —
  // so the migration counter stays honest without re-querying (the full row,
  // incl. both status columns, is already in hand).
  if (row.is_adjustment === isAdjustment) {
    return {
      status: toFlowStatus(isAdjustment ? row.delta_status : row.cashflow_status),
      changed: false,
    };
  }

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
      // The error is caught locally (status→'pending', UPDATE still succeeds) so
      // neither the captureAction wrapper nor the migration loop ever sees it.
      // Capture here so a single-row History-timeline toggle that hits a
      // price-fetch failure is operator-visible (R2-2).
      Sentry.captureException(err, {
        tags: {
          action: "activity-log.toggleActivityAdjustment.priceFetch",
          entity_type: row.entity_type,
        },
        extra: { logId, direction: "ON" },
      });
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
      // Same containment as the ON branch: caught locally → status='pending',
      // UPDATE still succeeds, so the outer captureAction wrapper never sees it.
      // Capture here so a single-row toggle hitting a price-fetch failure is
      // operator-visible. The migration loop captures per-row, but the UI
      // toggle path otherwise has no Sentry visibility (R2-2).
      Sentry.captureException(err, {
        tags: {
          action: "activity-log.toggleActivityAdjustment.priceFetch",
          entity_type: row.entity_type,
        },
        extra: { logId, direction: "OFF" },
      });
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
    .eq("user_id", user.id)
    // TOCTOU guard (M2): we read the row, then spent ~1–8s fetching external
    // prices. If a concurrent undo set undone_at in that window, this UPDATE
    // matches 0 rows and the now-undone row is correctly left alone (no need
    // to throw on 0-match — the undo's state wins).
    .is("undone_at", null);
  if (error) throw new Error(error.message);

  // Return the status of the side this call computed (R2-4): cashflow when
  // toggling OFF, delta when toggling ON. 'pending' here means the row's flag
  // flipped but the cashflow/delta couldn't be priced — the migration counts
  // these so the success message stays honest. `changed: true` because we
  // reached this point past the idempotency guard, so the UPDATE ran.
  return { status: isAdjustment ? deltaStatus : cashflowStatus, changed: true };
  });
}

// ─── CSV export ─────────────────────────────────────────

export async function exportActivityLogsCsv(): Promise<string> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Paginate past the PostgREST max_rows cap (1000): a `.limit()` is silently
  // capped, so a heavy user's CSV export would be truncated mid-history (data
  // loss in THEIR export). Stable order — created_at desc + id tiebreaker —
  // guarantees page integrity even when two rows share the same created_at.
  const rawRows = await fetchAllPaginated<Database["public"]["Tables"]["activity_log"]["Row"]>(
    (from, to) =>
      supabase
        .from("activity_log")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to),
    1000, { label: "activity:csv-export" },
  );

  const rows = rawRows.map(normalizeActivityLogRow);

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
