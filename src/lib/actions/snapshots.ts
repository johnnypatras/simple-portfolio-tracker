"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { PortfolioSnapshot } from "@/lib/types";

/** Round to 2 decimal places (matching Edge Function's round2) */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

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

  // ── Validation: component sum must match total ────────
  const componentSum = round2(cryptoUsd + stocksUsd + cashUsd);
  const drift = Math.abs(totalUsd - componentSum);
  if (drift > 1) {
    console.error(
      `[snapshots] VALIDATION FAILED: total_usd ($${totalUsd}) ≠ crypto ($${cryptoUsd}) + stocks ($${stocksUsd}) + cash ($${cashUsd}) = $${componentSum} (drift: $${drift})`
    );
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
    const changePct = Math.abs((totalUsd - prev.total_value_usd) / prev.total_value_usd) * 100;
    if (changePct > 15) {
      console.warn(
        `[snapshots] LARGE CHANGE: ${changePct.toFixed(1)}% from $${prev.total_value_usd} (${prev.snapshot_date}) to $${totalUsd} (${today})`
      );
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
    },
    { onConflict: "user_id,snapshot_date" }
  );

  if (error) {
    console.error("[snapshots] Failed to save snapshot:", error.message);
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

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split("T")[0];

  const { data, error } = await supabase
    .from("portfolio_snapshots")
    .select("*")
    .gte("snapshot_date", sinceStr)
    .order("snapshot_date", { ascending: true });

  if (error) {
    console.error("[snapshots] Failed to fetch snapshots:", error.message);
    return [];
  }

  return data ?? [];
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
    return null;
  }

  return data;
}
