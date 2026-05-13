/**
 * Pure helpers for manual NAV-priced stock assets (kind='manual').
 *
 * Non-"use server" module so it can be imported from server components like
 * assemble.ts without going through the Next.js server-action machinery.
 * Wraps the `get_latest_manual_navs_at` SQL function from migration 016.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { StockAssetWithPositions, YahooStockPriceData } from "@/lib/types";

export interface LatestManualNav {
  asset_id: string;
  nav: number;
  effective_date: string;
  note: string | null;
}

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
  return (data ?? []) as LatestManualNav[];
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
  const yahooStockAssets = stockAssets.filter((a) => a.kind === "yahoo");
  const manualStockAssets = stockAssets.filter((a) => a.kind === "manual");
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
 * NAV staleness indicator. Returns a tuple [label, daysAgo] so callers can
 * apply a stale-banner threshold (e.g. >45 days for the audit-driven UX).
 */
export function navStaleness(effectiveDate: string, now = new Date()): { label: string; daysAgo: number } {
  const d = new Date(effectiveDate + "T00:00:00Z");
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysAgo = Math.max(0, Math.round((today.getTime() - d.getTime()) / 86_400_000));
  if (daysAgo === 0) return { label: "today", daysAgo };
  if (daysAgo === 1) return { label: "yesterday", daysAgo };
  return { label: `${daysAgo} days ago`, daysAgo };
}
