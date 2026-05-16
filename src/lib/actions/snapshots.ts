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
  fetchManualNavInputsFor,
} from "@/lib/portfolio/manual-nav-augmentation";

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
    Sentry.captureMessage(msg, {
      level: "warning",
      tags: { action: "snapshots.saveSnapshot", channel: "on_demand", probe: "validation_drift" },
      extra: { totalUsd, cryptoUsd, stocksUsd, cashUsd, componentSum, drift },
    });
  }

  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  // ── Sanity check: compare with previous snapshot ──────
  const { data: prev } = await supabase
    .from("portfolio_snapshots")
    .select("total_value_usd, snapshot_date")
    .eq("user_id", user.id)
    .lt("snapshot_date", today)
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (prev?.total_value_usd && prev.total_value_usd > 0) {
    if (totalUsd === 0) {
      const msg = `[snapshots] SKIPPING: $0 total but previous snapshot was $${prev.total_value_usd} (${prev.snapshot_date}) — likely API failure`;
      console.warn(msg);
      Sentry.captureMessage(msg, {
        level: "warning",
        tags: { action: "snapshots.saveSnapshot", channel: "on_demand", probe: "zero_total_with_prev" },
        extra: { prevTotalUsd: prev.total_value_usd, prevSnapshotDate: prev.snapshot_date },
      });
      return;
    }
    const changePct = Math.abs((totalUsd - prev.total_value_usd) / prev.total_value_usd) * 100;
    if (changePct > 15) {
      const msg = `[snapshots] LARGE CHANGE: ${changePct.toFixed(1)}% from $${prev.total_value_usd} (${prev.snapshot_date}) to $${totalUsd} (${today})`;
      console.warn(msg);
      Sentry.captureMessage(msg, {
        level: "warning",
        tags: { action: "snapshots.saveSnapshot", channel: "on_demand", probe: "large_day_over_day" },
        extra: { prevTotalUsd: prev.total_value_usd, prevSnapshotDate: prev.snapshot_date, totalUsd, changePct },
      });
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

  // Fetch snapshots + manual NAV inputs in parallel. Past snapshots from
  // before the daily-snapshot cron started including manual assets won't
  // have them in stocks_value; without augmentation the chart shows an
  // artificial jump between the last cron snapshot and today's live value
  // (assemble.ts injection lives only for the live point).
  const [snapshotsRes, manualInputs] = await Promise.all([
    supabase
      .from("portfolio_snapshots")
      .select("*")
      .eq("user_id", user.id)
      .gte("snapshot_date", sinceStr)
      .order("snapshot_date", { ascending: true })
      .limit(MAX_SNAPSHOTS_LIMIT),
    fetchManualNavInputsFor(supabase, user.id),
  ]);

  if (snapshotsRes.error) {
    console.error("[snapshots] Failed to fetch snapshots:", snapshotsRes.error.message);
    throw new Error(`Failed to load portfolio history: ${snapshotsRes.error.message}`);
  }

  const raw = (snapshotsRes.data ?? []).map<PortfolioSnapshot>(normalizeSnapshot);
  return augmentSnapshotsWithManualNavs(raw, manualInputs.positions, manualInputs.navs);
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

