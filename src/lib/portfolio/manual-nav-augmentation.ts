import type { PortfolioSnapshot } from "@/lib/types";

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
 * no external historical FX lookup required. Falls back to 1.0 only when the
 * snapshot has zero or null totals (early-import edge case), in which case
 * the surrounding cross-currency arithmetic is moot anyway.
 */
export function snapshotEurPerUsd(snap: PortfolioSnapshot): number {
  const usd = snap.total_value_usd ?? 0;
  const eur = snap.total_value_eur ?? 0;
  return usd > 0 && eur > 0 ? eur / usd : 1;
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
      const contribution = Number(pos.quantity) * nav;
      const prev = byCurrency.get(pos.currency) ?? 0;
      byCurrency.set(pos.currency, prev + contribution);
    }
    if (byCurrency.size === 0) return snap;

    const eurPerUsd = snapshotEurPerUsd(snap);
    let manualUsd = 0;
    let manualEur = 0;
    for (const [currency, amount] of byCurrency) {
      if (currency === "USD") {
        manualUsd += amount;
        manualEur += amount * eurPerUsd;
      } else if (currency === "EUR") {
        manualEur += amount;
        manualUsd += eurPerUsd > 0 ? amount / eurPerUsd : amount;
      } else {
        manualUsd += amount;
        manualEur += amount * eurPerUsd;
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
