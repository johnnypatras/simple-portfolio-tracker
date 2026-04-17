import type { PortfolioSnapshot } from "@/lib/types";

/**
 * Find the most recent snapshot on-or-before a target date N days ago.
 *
 * Requires `snapshots` to be sorted ascending by `snapshot_date` (the DB
 * query in `getSharedPortfolio` already enforces this). Uses binary search
 * for O(log n) lookup — the previous inline implementation filtered the
 * full array 5× per request. Negligible at ~52-snapshot scale today, but
 * future-proofs the 100k-snapshot ceiling.
 *
 * @param snapshots  Array of snapshots, sorted ascending by snapshot_date
 * @param daysAgo    Target date offset in days before `now`
 * @param now        Reference "now" (injectable for deterministic tests)
 * @returns The matching snapshot, or null if none exists on-or-before the target
 *
 * @example
 *   const snap7d = findSnapshotAt(snapshots, 7);
 *   const snap30d = findSnapshotAt(snapshots, 30);
 */
export function findSnapshotAt(
  snapshots: PortfolioSnapshot[],
  daysAgo: number,
  now: Date = new Date(),
): PortfolioSnapshot | null {
  if (snapshots.length === 0) return null;
  const target = new Date(now);
  target.setDate(target.getDate() - daysAgo);
  const targetStr = target.toISOString().split("T")[0];
  // Largest index i such that snapshots[i].snapshot_date <= targetStr
  let lo = 0;
  let hi = snapshots.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (snapshots[mid].snapshot_date <= targetStr) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result >= 0 ? snapshots[result] : null;
}
