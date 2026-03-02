"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getFXRates } from "@/lib/prices/fx";
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

  if (currency === "USD") {
    const rates = await getFXRates("USD", ["EUR"], date);
    return { usd: amount, eur: amount * (rates.EUR ?? 1) };
  }
  if (currency === "EUR") {
    const rates = await getFXRates("EUR", ["USD"], date);
    return { usd: amount * (rates.USD ?? 1), eur: amount };
  }
  // Other currency → fetch both rates
  const rates = await getFXRates(currency, ["USD", "EUR"], date);
  return {
    usd: amount * (rates.USD ?? 1),
    eur: amount * (rates.EUR ?? 1),
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
    });
  } catch {
    // Swallow — audit logging is best-effort
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

async function computeDeltaFromSnapshots(
  entityType: string,
  action: string,
  date: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabaseOverride?: any
): Promise<{ usd: number; eur: number }> {
  // Cash entities — delta comes from amount/balance fields
  if (
    entityType === "bank_account" ||
    entityType === "exchange_deposit" ||
    entityType === "broker_deposit"
  ) {
    const amountField = entityType === "bank_account" ? "balance" : "amount";
    const beforeAmt = (before?.[amountField] as number) ?? 0;
    const afterAmt = (after?.[amountField] as number) ?? 0;
    const currency =
      (after?.currency as string) ?? (before?.currency as string) ?? "USD";

    let delta: number;
    if (action === "created") delta = afterAmt;
    else if (action === "removed") delta = -beforeAmt;
    else delta = afterAmt - beforeAmt; // updated

    const txDate = date.split("T")[0];
    return toUsdAndEur(delta, currency, txDate);
  }

  // Position entities — need historical price lookup
  if (entityType === "crypto_position" || entityType === "stock_position") {
    const beforeQty = (before?.quantity as number) ?? 0;
    const afterQty = (after?.quantity as number) ?? 0;

    let qtyDelta: number;
    if (action === "created") qtyDelta = afterQty;
    else if (action === "removed") qtyDelta = -beforeQty;
    else qtyDelta = afterQty - beforeQty;

    if (Math.abs(qtyDelta) < 1e-12) return { usd: 0, eur: 0 };

    if (entityType === "crypto_position") {
      // Look up crypto asset for coingecko_id
      const assetId =
        (after?.crypto_asset_id as string) ??
        (before?.crypto_asset_id as string);
      if (!assetId) return { usd: 0, eur: 0 };

      const supabase = supabaseOverride ?? (await createServerSupabaseClient());
      const { data: asset } = await supabase
        .from("crypto_assets")
        .select("coingecko_id")
        .eq("id", assetId)
        .single();
      if (!asset?.coingecko_id) return { usd: 0, eur: 0 };

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
      // Find closest price on or before the date
      let priceUsd = 0;
      for (const h of history) {
        if (h.date <= txDate) priceUsd = h.price;
        else break;
      }
      if (priceUsd === 0 && history.length > 0) priceUsd = history[0].price;

      const deltaUsd = qtyDelta * priceUsd;
      // Convert to EUR
      const rates = await getFXRates("USD", ["EUR"], txDate);
      return { usd: deltaUsd, eur: deltaUsd * (rates.EUR ?? 1) };
    }

    if (entityType === "stock_position") {
      // Look up stock asset for yahoo_ticker and currency
      const assetId =
        (after?.stock_asset_id as string) ??
        (before?.stock_asset_id as string);
      if (!assetId) return { usd: 0, eur: 0 };

      const supabase = supabaseOverride ?? (await createServerSupabaseClient());
      const { data: asset } = await supabase
        .from("stock_assets")
        .select("yahoo_ticker, currency")
        .eq("id", assetId)
        .single();
      if (!asset?.yahoo_ticker) return { usd: 0, eur: 0 };

      const { fetchIndexHistory } = await import("@/lib/prices/yahoo");
      const txDate = date.split("T")[0];
      const daysSince = Math.ceil(
        (Date.now() - new Date(txDate).getTime()) / 86_400_000
      );
      const history = await fetchIndexHistory(
        asset.yahoo_ticker,
        Math.max(daysSince + 5, 30)
      );
      let priceNative = 0;
      for (const h of history) {
        if (h.date <= txDate) priceNative = h.close;
        else break;
      }
      if (priceNative === 0 && history.length > 0)
        priceNative = history[0].close;

      const deltaNative = qtyDelta * priceNative;
      return toUsdAndEur(deltaNative, asset.currency ?? "USD", txDate);
    }
  }

  return { usd: 0, eur: 0 };
}

// ─── Toggle adjustment flag ─────────────────────────────
// When toggling ON: compute deltas from snapshots and store.
// When toggling OFF: clear deltas.

export async function toggleActivityAdjustment(
  logId: string,
  isAdjustment: boolean
): Promise<void> {
  const supabase = await createServerSupabaseClient();

  let deltaUsd: number | null = null;
  let deltaEur: number | null = null;

  if (isAdjustment) {
    // Fetch full row to access snapshots
    const { data: row, error: fetchErr } = await supabase
      .from("activity_log")
      .select("*")
      .eq("id", logId)
      .single();
    if (fetchErr) throw new Error(fetchErr.message);

    if (row) {
      const deltas = await computeDeltaFromSnapshots(
        row.entity_type,
        row.action,
        row.created_at,
        row.before_snapshot as Record<string, unknown> | null,
        row.after_snapshot as Record<string, unknown> | null
      );
      deltaUsd = Math.round(deltas.usd * 100) / 100;
      deltaEur = Math.round(deltas.eur * 100) / 100;
    }
  }

  const { error } = await supabase
    .from("activity_log")
    .update({ is_adjustment: isAdjustment, delta_usd: deltaUsd, delta_eur: deltaEur })
    .eq("id", logId);
  if (error) throw new Error(error.message);
}

// ─── Adjustment deltas for chart ────────────────────────
// Returns cumulative adjustment deltas by date for the chart.

export interface AdjustmentDelta {
  date: string;
  cumulative_usd: number;
  cumulative_eur: number;
}

export async function getAdjustmentDeltas(
  userId?: string
): Promise<AdjustmentDelta[]> {
  // Use admin client when userId provided (share page), otherwise authenticated
  const supabase = userId
    ? createAdminClient()
    : await createServerSupabaseClient();

  let query = supabase
    .from("activity_log")
    .select("created_at, delta_usd, delta_eur")
    .eq("is_adjustment", true)
    .is("undone_at", null)
    .not("delta_usd", "is", null)
    .order("created_at", { ascending: true });

  if (userId) {
    query = query.eq("user_id", userId);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  if (!data?.length) return [];

  // Build cumulative sums by date
  const byDate = new Map<string, { usd: number; eur: number }>();
  let cumUsd = 0;
  let cumEur = 0;

  for (const row of data) {
    cumUsd += (row.delta_usd as number) ?? 0;
    cumEur += (row.delta_eur as number) ?? 0;
    const date = (row.created_at as string).split("T")[0];
    byDate.set(date, { usd: cumUsd, eur: cumEur });
  }

  return Array.from(byDate.entries()).map(([date, { usd, eur }]) => ({
    date,
    cumulative_usd: usd,
    cumulative_eur: eur,
  }));
}

// ─── Backfill existing adjustment rows ──────────────────
// Computes deltas for all adjustment rows that lack them.

export async function backfillAdjustmentDeltas(): Promise<number> {
  // Use admin client to bypass RLS — backfill needs to process all users' rows
  const supabase = createAdminClient();

  const { data: rows, error } = await supabase
    .from("activity_log")
    .select("*")
    .eq("is_adjustment", true)
    .is("delta_usd", null)
    .order("created_at", { ascending: true })
    .limit(10);

  if (error) throw new Error(error.message);
  if (!rows?.length) return 0;

  // Verify caller is admin before processing cross-user data
  const authClient = await createServerSupabaseClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  const { data: profile } = await authClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") throw new Error("Admin access required");

  let count = 0;
  for (const row of rows) {
    try {
      const deltas = await computeDeltaFromSnapshots(
        row.entity_type,
        row.action,
        row.created_at,
        row.before_snapshot as Record<string, unknown> | null,
        row.after_snapshot as Record<string, unknown> | null,
        supabase // pass admin client for cross-user asset lookups
      );
      const deltaUsd = Math.round(deltas.usd * 100) / 100;
      const deltaEur = Math.round(deltas.eur * 100) / 100;

      await supabase
        .from("activity_log")
        .update({ delta_usd: deltaUsd, delta_eur: deltaEur })
        .eq("id", row.id);
      count++;
    } catch (err) {
      console.error(
        `Backfill failed for ${row.entity_type}/${row.action}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return count;
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

  // CSV header
  const lines = [
    "Date,Action,Type,Name,Description,Adjustment,Delta USD,Delta EUR,Undone At",
  ];

  for (const row of rows) {
    const date = new Date(row.created_at).toISOString();
    const escapeCsv = (s: string) =>
      s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;

    lines.push(
      [
        date,
        row.action,
        row.entity_type,
        escapeCsv(row.entity_name),
        escapeCsv(row.description),
        row.is_adjustment ? "Yes" : "No",
        row.delta_usd ?? "",
        row.delta_eur ?? "",
        row.undone_at ?? "",
      ].join(",")
    );
  }

  return lines.join("\n");
}
