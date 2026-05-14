"use server";

import * as Sentry from "@sentry/nextjs";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { PortfolioSnapshot } from "@/lib/types";
import type { Database } from "@/types/database";

/** Round to 2 decimal places (matching Edge Function's round2) */
import { round2 } from "@/lib/format";
import { MAX_SNAPSHOTS_LIMIT } from "@/lib/constants";
import {
  augmentSnapshotsWithManualNavs,
  type ManualPositionRow,
  type ManualNavRow,
} from "@/lib/portfolio/manual-nav-augmentation";
import { pickJoinedRecord } from "@/lib/supabase/join-utils";

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

  // Explicit limit overrides PostgREST's 1000-row default. In parallel: fetch
  // the user's kind='manual' positions + NAV history so we can augment each
  // snapshot with the manual-asset contribution. Past snapshots from before
  // the daily-snapshot cron started including manual assets won't have them in
  // stocks_value; without augmentation the chart shows an artificial jump
  // between the last cron snapshot and today's live value (assemble.ts
  // injection lives only for the live point).
  //
  // Defense-in-depth: both joined queries carry an explicit user_id filter on
  // top of RLS, so a misconfigured policy can't widen the result set.
  const [snapshotsRes, manualPositionsRes, manualNavsRes] = await Promise.all([
    supabase
      .from("portfolio_snapshots")
      .select("*")
      .gte("snapshot_date", sinceStr)
      .order("snapshot_date", { ascending: true })
      .limit(MAX_SNAPSHOTS_LIMIT),
    supabase
      .from("stock_positions")
      .select("stock_asset_id, quantity, stock_assets!inner(kind, currency, user_id, deleted_at)")
      .eq("stock_assets.user_id", user.id)
      .eq("stock_assets.kind", "manual")
      .is("stock_assets.deleted_at", null),
    supabase
      .from("manual_nav_updates")
      .select("asset_id, effective_date, nav")
      .eq("user_id", user.id)
      .order("effective_date", { ascending: true }),
  ]);

  if (snapshotsRes.error) {
    console.error("[snapshots] Failed to fetch snapshots:", snapshotsRes.error.message);
    throw new Error(`Failed to load portfolio history: ${snapshotsRes.error.message}`);
  }

  const raw = (snapshotsRes.data ?? []).map<PortfolioSnapshot>(normalizeSnapshot);

  // Project joined-relation rows into the pure-module shape. supabase-js
  // returns the joined relation as either an object or a single-element array
  // depending on the PostgREST relationship metadata — `pickJoinedRecord`
  // normalizes both. Done at this boundary so the augmentation module never
  // has to know about the PostgREST quirk.
  const manualPositions: ManualPositionRow[] = (manualPositionsRes.data ?? []).map((p) => {
    const sa = pickJoinedRecord<{ currency: string }>(p.stock_assets);
    return {
      stock_asset_id: p.stock_asset_id as string,
      quantity: Number(p.quantity),
      currency: sa?.currency ?? "USD",
    };
  });

  const manualNavs: ManualNavRow[] = (manualNavsRes.data ?? []).map((n) => ({
    asset_id: n.asset_id as string,
    effective_date: n.effective_date as string,
    nav: Number(n.nav),
  }));

  return augmentSnapshotsWithManualNavs(raw, manualPositions, manualNavs);
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
