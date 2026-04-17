"use server";

import * as Sentry from "@sentry/nextjs";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { PortfolioSnapshot } from "@/lib/types";
import type { Database } from "@/types/database";

/** Round to 2 decimal places (matching Edge Function's round2) */
import { round2 } from "@/lib/format";
import { MAX_SNAPSHOTS_LIMIT } from "@/lib/constants";

/**
 * Save (upsert) today's portfolio snapshot.
 *
 * The DB has a UNIQUE(user_id, snapshot_date) constraint,
 * so repeated calls on the same day just update the values.
 *
 * Includes:
 * - Rounding to 2dp (matching cron Edge Function for deterministic UPSERTs)
 * - Component sum validation (total ≈ crypto + stocks + cash ±$1)
 * - Sanity check vs previous snapshot (>15% change logged as warning)
 */
export async function saveSnapshot(values: {
  totalValueUsd: number;
  totalValueEur: number;
  cryptoValueUsd: number;
  stocksValueUsd: number;
  cashValueUsd: number;
  cryptoValueEur: number;
  stocksValueEur: number;
  cashValueEur: number;
  stocksHomeCurrencyEur: number;
  cashHomeCurrencyEur: number;
}): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  // Round all values to 2dp (matching Edge Function's round2)
  const totalUsd = round2(values.totalValueUsd);
  const totalEur = round2(values.totalValueEur);
  const cryptoUsd = round2(values.cryptoValueUsd);
  const stocksUsd = round2(values.stocksValueUsd);
  const cashUsd = round2(values.cashValueUsd);
  const cryptoEur = round2(values.cryptoValueEur);
  const stocksEur = round2(values.stocksValueEur);
  const cashEur = round2(values.cashValueEur);
  const stocksHomeCurEur = round2(values.stocksHomeCurrencyEur);
  const cashHomeCurEur = round2(values.cashHomeCurrencyEur);

  // ── Validation: component sum must match total ────────
  const componentSum = round2(cryptoUsd + stocksUsd + cashUsd);
  const drift = Math.abs(totalUsd - componentSum);
  if (drift > 1) {
    const msg = `[snapshots] VALIDATION FAILED: total_usd ($${totalUsd}) ≠ crypto ($${cryptoUsd}) + stocks ($${stocksUsd}) + cash ($${cashUsd}) = $${componentSum} (drift: $${drift})`;
    console.error(msg);
    Sentry.captureMessage(msg, "warning");
  }

  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  // ── Sanity check: compare with previous snapshot ──────
  const { data: prev } = await supabase
    .from("portfolio_snapshots")
    .select("total_value_usd, snapshot_date")
    .lt("snapshot_date", today)
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (prev?.total_value_usd && prev.total_value_usd > 0) {
    if (totalUsd === 0) {
      const msg = `[snapshots] SKIPPING: $0 total but previous snapshot was $${prev.total_value_usd} (${prev.snapshot_date}) — likely API failure`;
      console.warn(msg);
      Sentry.captureMessage(msg, "warning");
      return;
    }
    const changePct = Math.abs((totalUsd - prev.total_value_usd) / prev.total_value_usd) * 100;
    if (changePct > 15) {
      const msg = `[snapshots] LARGE CHANGE: ${changePct.toFixed(1)}% from $${prev.total_value_usd} (${prev.snapshot_date}) to $${totalUsd} (${today})`;
      console.warn(msg);
      Sentry.captureMessage(msg, "warning");
    }
  }

  const { error } = await supabase.from("portfolio_snapshots").upsert(
    {
      user_id: user.id,
      snapshot_date: today,
      total_value_usd: totalUsd,
      total_value_eur: totalEur,
      crypto_value_usd: cryptoUsd,
      stocks_value_usd: stocksUsd,
      cash_value_usd: cashUsd,
      crypto_value_eur: cryptoEur,
      stocks_value_eur: stocksEur,
      cash_value_eur: cashEur,
      stocks_eur_denominated_value: stocksHomeCurEur,
      cash_eur_denominated_value: cashHomeCurEur,
    },
    { onConflict: "user_id,snapshot_date" }
  );

  if (error) {
    console.error("[snapshots] Failed to save snapshot:", error.message);
    throw new Error(`Failed to save snapshot: ${error.message}`);
  }
}

/**
 * Get snapshots for the last N days (for the chart).
 * Returns them in chronological order.
 */
export async function getSnapshots(
  days: number
): Promise<PortfolioSnapshot[]> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split("T")[0];

  // Explicit limit overrides PostgREST's 1000-row default, so callers
  // requesting ALL_SNAPSHOTS_DAYS (99999) actually get all rows.
  const { data, error } = await supabase
    .from("portfolio_snapshots")
    .select("*")
    .gte("snapshot_date", sinceStr)
    .order("snapshot_date", { ascending: true })
    .limit(MAX_SNAPSHOTS_LIMIT);

  if (error) {
    console.error("[snapshots] Failed to fetch snapshots:", error.message);
    throw new Error(`Failed to load portfolio history: ${error.message}`);
  }

  // Legacy snapshots may have null USD value columns; coerce to 0 so UI can
  // treat them as numeric. EUR-side columns are genuinely nullable (pre-multi-currency).
  return (data ?? []).map<PortfolioSnapshot>(normalizeSnapshot);
}

type PortfolioSnapshotRow = Database["public"]["Tables"]["portfolio_snapshots"]["Row"];

function normalizeSnapshot(row: PortfolioSnapshotRow): PortfolioSnapshot {
  return {
    ...row,
    total_value_usd: row.total_value_usd ?? 0,
    total_value_eur: row.total_value_eur ?? 0,
    crypto_value_usd: row.crypto_value_usd ?? 0,
    stocks_value_usd: row.stocks_value_usd ?? 0,
    cash_value_usd: row.cash_value_usd ?? 0,
  };
}

/**
 * Get the snapshot closest to N days ago.
 * Used for computing "change vs X days ago".
 *
 * Looks for the most recent snapshot on or before the target date.
 */
export async function getSnapshotAt(
  daysAgo: number
): Promise<PortfolioSnapshot | null> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const target = new Date();
  target.setDate(target.getDate() - daysAgo);
  const targetStr = target.toISOString().split("T")[0];

  const { data, error } = await supabase
    .from("portfolio_snapshots")
    .select("*")
    .lte("snapshot_date", targetStr)
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[snapshots] Failed to fetch snapshot:", error.message);
    throw new Error(`Failed to load snapshot: ${error.message}`);
  }

  return data ? normalizeSnapshot(data) : null;
}
