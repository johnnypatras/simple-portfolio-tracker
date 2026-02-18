"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { PortfolioSnapshot } from "@/lib/types";

/**
 * Save (upsert) today's portfolio snapshot.
 *
 * The DB has a UNIQUE(user_id, snapshot_date) constraint,
 * so repeated calls on the same day just update the values.
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

  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  const { error } = await supabase.from("portfolio_snapshots").upsert(
    {
      user_id: user.id,
      snapshot_date: today,
      total_value_usd: values.totalValueUsd,
      total_value_eur: values.totalValueEur,
      crypto_value_usd: values.cryptoValueUsd,
      stocks_value_usd: values.stocksValueUsd,
      cash_value_usd: values.cashValueUsd,
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
