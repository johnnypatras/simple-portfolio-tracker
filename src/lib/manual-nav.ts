/**
 * Pure helpers for manual NAV-priced stock assets (kind='manual').
 *
 * Non-"use server" module so it can be imported from server components like
 * assemble.ts without going through the Next.js server-action machinery.
 * Wraps the `get_latest_manual_navs_at` SQL function from migration 016.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { StockAssetWithPositions, YahooStockPriceData, LatestManualNav } from "@/lib/types";

// LatestManualNav is re-exported for backward compatibility with previous
// import paths. Canonical home is now @/lib/types.
export type { LatestManualNav } from "@/lib/types";

/**
 * Returns the latest NAV at-or-before `asOfDate` for each kind='manual'
 * stock_asset visible to the caller.
 *
 * Auth context resolution:
 *   - Authenticated client + omitted `userId`: RLS scopes to auth.uid()
 *   - Service-role client: must pass `userId` explicitly (no JWT context)
 *
 * SQL function is STABLE + SECURITY INVOKER so RLS naturally protects the
 * lookup. Index-only scan via idx_manual_nav_updates_asset_date (migration 015).
 */
export async function getLatestManualNavsAt(
  supabase: SupabaseClient<Database>,
  asOfDate: string,
  userId?: string,
): Promise<LatestManualNav[]> {
  const { data, error } = await supabase.rpc("get_latest_manual_navs_at", {
    p_as_of: asOfDate,
    p_user_id: userId,
  });
  if (error) throw new Error(`Failed to fetch manual NAVs: ${error.message}`);
  // Normalize at the boundary instead of casting. The generated type widens
  // `note` to non-nullable because PG's RETURNS TABLE doesn't reflect column
  // nullability — RLS-scoped data can legitimately return NULL notes.
  return (data ?? []).map<LatestManualNav>((r) => ({
    asset_id: r.asset_id,
    nav: Number(r.nav),
    effective_date: r.effective_date,
    note: r.note ?? null,
  }));
}

/**
 * Splits stock assets into the Yahoo batch (kind='yahoo') and the manual
 * NAV-priced list (kind='manual'). Returns the Yahoo ticker list ready for
 * `getStockAndIndexPrices`. Used by every page that displays stock prices
 * to keep the kind='yahoo' filter consistent + DRY.
 *
 * Generic so callers can pass the full StockAssetWithPositions or a narrower
 * shape — the helper threads the same type through both partitions.
 */
export function partitionStockAssetsForPricing<
  T extends Pick<StockAssetWithPositions, "id" | "kind" | "ticker" | "yahoo_ticker" | "currency" | "name">,
>(
  stockAssets: T[],
): {
  yahooStockAssets: T[];
  manualStockAssets: T[];
  yahooTickers: string[];
} {
  const yahooStockAssets: T[] = [];
  const manualStockAssets: T[] = [];
  for (const a of stockAssets) {
    // Exhaustive dispatch — DB CHECK (migration 015 + 018) enforces this at
    // the data layer, but defense-in-depth: any unknown kind (e.g. corrupted
    // row, future migration drift) emits a warning and goes to the Yahoo
    // bucket so the asset doesn't silently disappear from the dashboard.
    switch (a.kind) {
      case "yahoo":
        yahooStockAssets.push(a);
        break;
      case "manual":
        manualStockAssets.push(a);
        break;
      default: {
        const _exhaustive: never = a.kind;
        void _exhaustive;
        console.warn(`[partitionStockAssetsForPricing] Unknown kind="${a.kind}" on asset ${a.id} (${a.ticker}); defaulting to yahoo partition`);
        yahooStockAssets.push(a);
      }
    }
  }
  const yahooTickers = yahooStockAssets
    .map((a) => a.yahoo_ticker || a.ticker)
    .filter(Boolean);
  return { yahooStockAssets, manualStockAssets, yahooTickers };
}

/**
 * Mutates `stockPrices` in place to add synthesized quote entries for
 * kind='manual' assets, keyed by `asset.ticker` (since yahoo_ticker is null
 * for them). Downstream readers use `stockPrices[asset.yahoo_ticker || asset.ticker]`
 * — manual assets resolve via the ticker fallback. Assets with no NAV history
 * yet are skipped (contribute value=0 to portfolio totals).
 */
export function injectManualNavPrices(
  manualStockAssets: Pick<StockAssetWithPositions, "id" | "ticker" | "currency" | "name">[],
  manualNavs: LatestManualNav[],
  stockPrices: YahooStockPriceData,
): void {
  const navByAssetId = new Map(manualNavs.map((n) => [n.asset_id, n]));
  for (const asset of manualStockAssets) {
    const nav = navByAssetId.get(asset.id);
    if (!nav) continue;
    stockPrices[asset.ticker] = {
      price: nav.nav,
      previousClose: nav.nav,
      change24h: 0,
      currency: asset.currency,
      name: asset.name,
    };
  }
}

/**
 * Formats a date string as "X days ago" / "today" / "yesterday" for the
 * NAV staleness indicator. Returns `{label, daysAgo}` so callers can apply
 * a stale-banner threshold (e.g. > STALE_NAV_DAYS_THRESHOLD days).
 *
 * Edge cases:
 * - Invalid date string ("not-a-date", malformed) → `{label: "unknown",
 *   daysAgo: Number.POSITIVE_INFINITY}`. The infinite daysAgo triggers any
 *   stale-threshold check downstream so the UI surfaces the anomaly.
 * - Future effective_date → `{label: "future date", daysAgo: -daysFromNow}`
 *   distinguishable from "today" so the UI can render an error state.
 *   Server-side validatePastOrTodayDate rejects future dates at write time,
 *   but this branch is defense-in-depth: a pre-existing future-dated row
 *   (e.g. from an older backup or pre-validator import) shouldn't render
 *   as "Updated today".
 */
export function navStaleness(effectiveDate: string, now = new Date()): { label: string; daysAgo: number } {
  const d = new Date(effectiveDate + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) {
    return { label: "unknown", daysAgo: Number.POSITIVE_INFINITY };
  }
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const rawDays = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  if (rawDays < 0) {
    return { label: "future date", daysAgo: rawDays };
  }
  if (rawDays === 0) return { label: "today", daysAgo: 0 };
  if (rawDays === 1) return { label: "yesterday", daysAgo: 1 };
  return { label: `${rawDays} days ago`, daysAgo: rawDays };
}
