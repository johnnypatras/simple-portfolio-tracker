import { describe, it, expect } from "vitest";
import { findSnapshotAt } from "@/lib/portfolio/snapshot-utils";
import type { PortfolioSnapshot } from "@/lib/types";

function mkSnap(date: string): PortfolioSnapshot {
  return {
    id: `s-${date}`,
    user_id: "u1",
    snapshot_date: date,
    total_value_usd: 1000,
    total_value_eur: 920,
    crypto_value_usd: 300,
    stocks_value_usd: 400,
    cash_value_usd: 300,
    crypto_value_eur: 276,
    stocks_value_eur: 368,
    cash_value_eur: 276,
    stocks_eur_denominated_value: null,
    cash_eur_denominated_value: null,
    created_at: `${date}T00:00:00Z`,
  };
}

describe("findSnapshotAt", () => {
  const now = new Date("2026-04-17T12:00:00Z");

  it("returns null for an empty snapshot array", () => {
    expect(findSnapshotAt([], 7, now)).toBe(null);
  });

  it("returns null when daysAgo is before earliest snapshot", () => {
    // Earliest snapshot is 2026-04-15 — asking for 10 days ago (2026-04-07) should return null
    const snaps = [mkSnap("2026-04-15"), mkSnap("2026-04-16")];
    expect(findSnapshotAt(snaps, 10, now)).toBe(null);
  });

  it("returns the latest snapshot when daysAgo is well past latest (0 days ago)", () => {
    // Target = 2026-04-17 (today) — should match 2026-04-17 or latest on-or-before
    const snaps = [mkSnap("2026-04-10"), mkSnap("2026-04-14"), mkSnap("2026-04-17")];
    expect(findSnapshotAt(snaps, 0, now)?.snapshot_date).toBe("2026-04-17");
  });

  it("returns exact-match snapshot when target date exists", () => {
    // 7 days ago from 2026-04-17 = 2026-04-10
    const snaps = [mkSnap("2026-04-10"), mkSnap("2026-04-14"), mkSnap("2026-04-17")];
    expect(findSnapshotAt(snaps, 7, now)?.snapshot_date).toBe("2026-04-10");
  });

  it("returns most-recent-on-or-before when exact target date missing", () => {
    // 5 days ago from 2026-04-17 = 2026-04-12 — not in array
    // Should return 2026-04-10 (largest snapshot_date <= 2026-04-12)
    const snaps = [mkSnap("2026-04-10"), mkSnap("2026-04-14"), mkSnap("2026-04-17")];
    expect(findSnapshotAt(snaps, 5, now)?.snapshot_date).toBe("2026-04-10");
  });

  it("handles single-element array correctly", () => {
    const snaps = [mkSnap("2026-04-15")];
    expect(findSnapshotAt(snaps, 2, now)?.snapshot_date).toBe("2026-04-15");
    expect(findSnapshotAt(snaps, 10, now)).toBe(null);
  });

  it("works without an explicit `now` (uses current time)", () => {
    // With daysAgo=0, target = today; a long-ago snap is always on-or-before,
    // so this verifies the default-param path returns a match (no throw).
    const snaps = [mkSnap("2020-01-01")];
    expect(findSnapshotAt(snaps, 0)?.snapshot_date).toBe("2020-01-01");
  });

  it("returns latest snapshot when target is strictly after every snapshot", () => {
    // Genuine "after latest" case: target > max(snapshot_date)
    // daysAgo=-3 with now=2026-04-17 → target=2026-04-20, all snaps are 2026-04-10..17
    const snaps = [mkSnap("2026-04-10"), mkSnap("2026-04-14"), mkSnap("2026-04-17")];
    expect(findSnapshotAt(snaps, -3, now)?.snapshot_date).toBe("2026-04-17");
  });

  it("returns last snapshot for duplicate dates (pins rightmost-equal behavior)", () => {
    // Binary search lo=mid+1 on equal → returns rightmost match index.
    // If DB secondary-orders by created_at, the newest duplicate wins. Pin it.
    const snaps = [
      mkSnap("2026-04-10"),
      { ...mkSnap("2026-04-10"), id: "s-dup", total_value_usd: 2000 },
      mkSnap("2026-04-17"),
    ];
    const match = findSnapshotAt(snaps, 7, now);
    expect(match?.snapshot_date).toBe("2026-04-10");
    expect(match?.id).toBe("s-dup"); // rightmost duplicate
  });
});
