import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import type { Database } from "@/types/database";
import type { PortfolioSnapshot } from "@/lib/types";
import { pickJoinedRecord } from "@/lib/supabase/join-utils";

/**
 * Inputs for snapshot augmentation. Kept in this pure module (no "use server")
 * so the augmentation logic can be exercised by unit tests independent of
 * Supabase, Next.js request context, or RLS.
 */
export type ManualNavRow = {
  asset_id: string;
  effective_date: string;
  nav: number;
};

export type ManualPositionRow = {
  stock_asset_id: string;
  quantity: number;
  currency: string;
};

/**
 * Binary search for the largest-date NAV at-or-before `targetDate` for a
 * given asset. Mirrors `findSnapshotAt()`'s shape so the codebase has one
 * canonical pattern for date-keyed lookups.
 *
 * `navsAsc` MUST be sorted ascending by `effective_date`.
 *
 * O(log n) per lookup. Replaces the previous O(n) walk that the DESC-sorted
 * query encouraged — fine at today's scale, but converging on one pattern
 * prevents the same shortcut from being copied into Phase 2's cash/stablecoin
 * augmentation.
 */
export function findNavAtOrBefore(
  navsAsc: ManualNavRow[],
  targetDate: string,
): number | null {
  if (navsAsc.length === 0) return null;
  let lo = 0;
  let hi = navsAsc.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (navsAsc[mid].effective_date <= targetDate) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result >= 0 ? navsAsc[result].nav : null;
}

/**
 * Build the per-asset NAV index used by `augmentSnapshotsWithManualNavs`.
 * Sorts ASC for binary search regardless of caller-supplied order.
 */
export function buildNavIndex(navs: ManualNavRow[]): Map<string, ManualNavRow[]> {
  const index = new Map<string, ManualNavRow[]>();
  for (const row of navs) {
    if (!index.has(row.asset_id)) index.set(row.asset_id, []);
    index.get(row.asset_id)!.push(row);
  }
  for (const list of index.values()) {
    list.sort((a, b) => a.effective_date.localeCompare(b.effective_date));
  }
  return index;
}

/**
 * Derive the snapshot's own implied EUR/USD rate from its stored values.
 *
 * The daily-snapshot cron writes `total_value_eur` and `total_value_usd` at
 * the same instant, so their ratio captures the exact FX rate at that date —
 * no external historical FX lookup required.
 *
 * Resilient to single-zero snapshots (an early signup with only USD assets
 * has `total_value_eur: 0, total_value_usd: 1100` — without this fallback
 * the cross-currency math would treat 1000 USD as 1000 EUR, off by 18%).
 * Falls through three layers:
 *   1. `total_value_eur / total_value_usd` — primary, exact date FX
 *   2. `crypto_value_eur / crypto_value_usd` — CoinGecko returns both
 *      currencies directly, so this ratio is reliable when crypto is held
 *   3. `cash_value_eur / cash_value_usd` — same idea for cash positions
 *   4. `null` — no determinable rate. Audit R1 Phase 5 changed this from
 *      identity-fallback (`1`) to null because the old behaviour silently
 *      corrupted the cross-currency mirror: a EUR ELTIF on a zero-total
 *      pre-positions snapshot got written into `stocks_value_usd` as a 1:1
 *      copy (e.g. €1000 NAV → $1000 USD instead of $1080). Callers now
 *      skip the cross-currency mirror entirely when null is returned.
 */
export function snapshotEurPerUsd(snap: PortfolioSnapshot): number | null {
  const totalUsd = snap.total_value_usd ?? 0;
  const totalEur = snap.total_value_eur ?? 0;
  if (totalUsd > 0 && totalEur > 0) return totalEur / totalUsd;

  const cryptoUsd = snap.crypto_value_usd ?? 0;
  const cryptoEur = snap.crypto_value_eur ?? 0;
  if (cryptoUsd > 0 && cryptoEur > 0) return cryptoEur / cryptoUsd;

  const cashUsd = snap.cash_value_usd ?? 0;
  const cashEur = snap.cash_value_eur ?? 0;
  if (cashUsd > 0 && cashEur > 0) return cashEur / cashUsd;

  return null;
}

/**
 * Augment past snapshots with the historical value of each kind='manual'
 * stock position, computed as `qty × NAV-at-or-before(snapshot_date)`.
 *
 * FX policy:
 *   - USD-denominated NAVs add directly to stocks_value_usd; the EUR mirror
 *     uses the snapshot's own implied EUR/USD rate.
 *   - EUR-denominated NAVs add directly to stocks_value_eur; the USD mirror
 *     uses the inverse of that rate.
 *   - Non-USD/EUR currencies (rare for ELTIFs/SICAVs) treat the amount as
 *     USD-equivalent and cross-convert via the snapshot rate. Off by the
 *     foreign-currency-to-USD drift; full historical-FX correction belongs
 *     to Phase 3 of the chart correctness rollout.
 *
 * Pure function: no DB access, no clock dependency, fully deterministic.
 * Caller is responsible for filtering `positions` to kind='manual' rows and
 * for the user-scoped fetch of both positions and navs.
 */
export function augmentSnapshotsWithManualNavs(
  snapshots: PortfolioSnapshot[],
  positions: ManualPositionRow[],
  navs: ManualNavRow[],
): PortfolioSnapshot[] {
  if (positions.length === 0) return snapshots;

  const navIndex = buildNavIndex(navs);

  return snapshots.map<PortfolioSnapshot>((snap) => {
    const byCurrency = new Map<string, number>();
    for (const pos of positions) {
      const navList = navIndex.get(pos.stock_asset_id);
      if (!navList) continue;
      const nav = findNavAtOrBefore(navList, snap.snapshot_date);
      if (nav === null) continue;
      // Defense-in-depth: guard against NaN/Infinity propagation. The DB
      // schema constrains nav > 0 (migration 015) and quantity columns are
      // NUMERIC, but supabase-js can deliver string-formatted numerics for
      // high-precision values. Number("abc") → NaN, which would silently
      // poison every snapshot total.
      const qty = Number(pos.quantity);
      if (!Number.isFinite(qty) || !Number.isFinite(nav)) continue;
      const contribution = qty * nav;
      if (!Number.isFinite(contribution)) continue;
      const prev = byCurrency.get(pos.currency) ?? 0;
      byCurrency.set(pos.currency, prev + contribution);
    }
    if (byCurrency.size === 0) return snap;

    const eurPerUsd = snapshotEurPerUsd(snap);
    // Defense-in-depth: when snapshotEurPerUsd returns a real number it is
    // guaranteed strictly-positive by construction (each branch divides only
    // when both numerator AND denominator are > 0). The check below catches
    // a future regression that allowed zero/negative through any branch.
    if (eurPerUsd !== null && eurPerUsd <= 0) {
      throw new Error(
        `Invariant violation: snapshotEurPerUsd returned non-positive value ${eurPerUsd}`,
      );
    }
    let manualUsd = 0;
    let manualEur = 0;
    for (const [currency, amount] of byCurrency) {
      if (currency === "USD") {
        manualUsd += amount;
        // Skip the EUR mirror when no real FX rate is available — better to
        // leave the foreign column at 0 than corrupt it with a 1:1 identity
        // copy of the USD amount. Affects zero-total pre-positions snapshots.
        if (eurPerUsd !== null) manualEur += amount * eurPerUsd;
      } else if (currency === "EUR") {
        manualEur += amount;
        if (eurPerUsd !== null) manualUsd += amount / eurPerUsd;
      } else {
        // Non-USD/EUR currencies (rare for ELTIFs). When no FX rate is
        // available we can't determine either column accurately; skip
        // entirely rather than write the worst-case 1:1 approximation.
        if (eurPerUsd !== null) {
          manualUsd += amount;
          manualEur += amount * eurPerUsd;
        }
      }
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

/**
 * Fetch a user's manual NAV positions + NAV history in parallel.
 *
 * Single source of truth for the augmentation inputs. Used by getSnapshots
 * (chart + period-change cards via findSnapshotAt) and getSharedPortfolio
 * (cross-user share-page chart). Pass the appropriate client + userId:
 *
 *   - Authenticated server client + omitted userId → RLS scopes to auth.uid()
 *   - Admin client + explicit userId → service-role for cross-user reads
 *     (share/comparison paths where viewer ≠ owner)
 *
 * Defense-in-depth: both joined queries carry an explicit user_id filter on
 * top of RLS. Errors throw with descriptive messages (no silent failure).
 */
export async function fetchManualNavInputsFor(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<{ positions: ManualPositionRow[]; navs: ManualNavRow[] }> {
  const [manualPositionsRes, manualNavsRes] = await Promise.all([
    supabase
      .from("stock_positions")
      .select("stock_asset_id, quantity, stock_assets!inner(kind, currency, user_id, deleted_at)")
      .eq("stock_assets.user_id", userId)
      .eq("stock_assets.kind", "manual")
      .is("stock_assets.deleted_at", null)
      .is("deleted_at", null),
    supabase
      .from("manual_nav_updates")
      .select("asset_id, effective_date, nav")
      .eq("user_id", userId)
      .order("effective_date", { ascending: true }),
  ]);

  if (manualPositionsRes.error) {
    throw new Error(`Failed to load manual positions: ${manualPositionsRes.error.message}`);
  }
  if (manualNavsRes.error) {
    throw new Error(`Failed to load manual NAV history: ${manualNavsRes.error.message}`);
  }

  const positions: ManualPositionRow[] = (manualPositionsRes.data ?? []).map((p) => {
    const sa = pickJoinedRecord<{ currency: string }>(p.stock_assets);
    return {
      stock_asset_id: p.stock_asset_id as string,
      quantity: Number(p.quantity),
      currency: sa?.currency ?? "USD",
    };
  });

  const navs: ManualNavRow[] = (manualNavsRes.data ?? []).map((n) => ({
    asset_id: n.asset_id as string,
    effective_date: n.effective_date as string,
    nav: Number(n.nav),
  }));

  // Breadcrumb on every NAV fetch so any later Sentry event in the same
  // request surfaces NAV scope context. `level: "debug"` when there's no
  // manual data keeps the dashboard hot path quiet for the 99% case where
  // users don't hold ELTIFs/SICAVs; "info" only when augmentation will
  // actually run downstream. User IDs are internal UUIDs (no PII).
  Sentry.addBreadcrumb({
    category: "manual-nav",
    message: "Manual NAV inputs fetched",
    data: {
      positions: positions.length,
      navHistoryRows: navs.length,
    },
    level: positions.length > 0 ? "info" : "debug",
  });

  return { positions, navs };
}
