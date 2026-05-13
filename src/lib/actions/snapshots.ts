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

  // Explicit limit overrides PostgREST's 1000-row default. In parallel: fetch
  // the user's kind='manual' positions + NAV history so we can augment each
  // snapshot with the manual-asset contribution. Past snapshots from before
  // the daily-snapshot cron started including manual assets won't have them in
  // stocks_value; without augmentation the chart shows an artificial jump
  // between the last cron snapshot and today's live value (assemble.ts
  // injection lives only for the live point).
  const [snapshotsRes, manualPositionsRes, manualNavsRes] = await Promise.all([
    supabase
      .from("portfolio_snapshots")
      .select("*")
      .gte("snapshot_date", sinceStr)
      .order("snapshot_date", { ascending: true })
      .limit(MAX_SNAPSHOTS_LIMIT),
    supabase
      .from("stock_positions")
      .select("stock_asset_id, quantity, stock_assets!inner(kind, currency, deleted_at)")
      .is("stock_assets.deleted_at", null),
    supabase
      .from("manual_nav_updates")
      .select("asset_id, effective_date, nav")
      .order("effective_date", { ascending: false }),
  ]);

  if (snapshotsRes.error) {
    console.error("[snapshots] Failed to fetch snapshots:", snapshotsRes.error.message);
    throw new Error(`Failed to load portfolio history: ${snapshotsRes.error.message}`);
  }

  const raw = (snapshotsRes.data ?? []).map<PortfolioSnapshot>(normalizeSnapshot);

  // Filter joined rows to kind='manual' only. supabase-js returns the joined
  // relation as either an object or single-element array depending on the
  // PostgREST shape — normalize both.
  const manualPositions = (manualPositionsRes.data ?? [])
    .filter((p) => {
      const sa = Array.isArray(p.stock_assets) ? p.stock_assets[0] : p.stock_assets;
      return sa?.kind === "manual";
    });

  if (manualPositions.length === 0) return raw;
  return augmentSnapshotsWithManualNavs(raw, manualPositions as ManualPositionRow[], manualNavsRes.data ?? []);
}

/**
 * In-memory augmentation: for each past snapshot, add `qty × (latest NAV
 * at-or-before snapshot_date)` for every kind='manual' stock_position the
 * user owns. Native NAV currency is the asset's `currency` field.
 *
 * FX policy: same-currency contributions add directly to stocks_value_*. For
 * cross-currency (rare — manual assets in USD on EUR primary or vice versa)
 * we currently add the native amount to both USD and EUR columns as a 1:1
 * approximation. The chart's display currency selects from these so the
 * EUR-ELTIF-on-EUR-primary case (the common one) is exact; cross-currency
 * cases land within a few percent. A historical-FX lookup would be the
 * thorough fix but is out of scope until the volume justifies the complexity.
 */
type ManualPositionRow = {
  stock_asset_id: string;
  quantity: number;
  stock_assets: { kind: string; currency: string; deleted_at: string | null } | { kind: string; currency: string; deleted_at: string | null }[] | null;
};

function augmentSnapshotsWithManualNavs(
  snapshots: PortfolioSnapshot[],
  manualPositions: ManualPositionRow[],
  navs: { asset_id: string; effective_date: string; nav: number }[],
): PortfolioSnapshot[] {
  // Index NAVs by asset_id; already sorted DESC by the query.
  const navsByAsset = new Map<string, { date: string; nav: number }[]>();
  for (const row of navs) {
    if (!navsByAsset.has(row.asset_id)) navsByAsset.set(row.asset_id, []);
    navsByAsset.get(row.asset_id)!.push({ date: row.effective_date, nav: Number(row.nav) });
  }
  const navAtOrBefore = (assetId: string, snapshotDate: string): number | null => {
    const list = navsByAsset.get(assetId) ?? [];
    for (const n of list) if (n.date <= snapshotDate) return n.nav;
    return null;
  };

  return snapshots.map<PortfolioSnapshot>((snap) => {
    const byCurrency = new Map<string, number>();
    for (const pos of manualPositions) {
      const nav = navAtOrBefore(pos.stock_asset_id, snap.snapshot_date);
      if (nav === null) continue;
      const sa = Array.isArray(pos.stock_assets) ? pos.stock_assets[0] : pos.stock_assets;
      const currency = sa?.currency ?? "USD";
      const contribution = Number(pos.quantity) * nav;
      byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + contribution);
    }
    if (byCurrency.size === 0) return snap;

    let manualUsd = 0;
    let manualEur = 0;
    for (const [currency, amount] of byCurrency) {
      if (currency === "USD") manualUsd += amount;
      else if (currency === "EUR") manualEur += amount;
      else { manualUsd += amount; manualEur += amount; }  // 1:1 fallback for other currencies
    }

    return {
      ...snap,
      stocks_value_usd: (snap.stocks_value_usd ?? 0) + manualUsd,
      stocks_value_eur: (snap.stocks_value_eur ?? 0) + manualEur,
      total_value_usd: (snap.total_value_usd ?? 0) + manualUsd,
      total_value_eur: (snap.total_value_eur ?? 0) + manualEur,
    };
  });
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
