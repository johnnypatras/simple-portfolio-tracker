import { describe, it, expect } from "vitest";
import {
  augmentSnapshotsWithManualNavs,
  buildNavIndex,
  findNavAtOrBefore,
  snapshotEurPerUsd,
  type ManualNavRow,
  type ManualPositionRow,
} from "@/lib/portfolio/manual-nav-augmentation";
import type { PortfolioSnapshot } from "@/lib/types";

const ASSET_A = "11111111-1111-1111-1111-111111111111";
const ASSET_B = "22222222-2222-2222-2222-222222222222";

function makeSnapshot(overrides: Partial<PortfolioSnapshot>): PortfolioSnapshot {
  return {
    id: "snap",
    user_id: "user",
    snapshot_date: "2026-03-15",
    total_value_usd: 1000,
    total_value_eur: 900,
    crypto_value_usd: 0,
    stocks_value_usd: 500,
    cash_value_usd: 500,
    crypto_value_eur: 0,
    stocks_value_eur: 450,
    cash_value_eur: 450,
    stocks_eur_denominated_value: 0,
    cash_eur_denominated_value: 0,
    created_at: "2026-03-15T00:00:00Z",
    ...overrides,
  } as PortfolioSnapshot;
}

describe("findNavAtOrBefore", () => {
  it("returns null for an empty list", () => {
    expect(findNavAtOrBefore([], "2026-03-15")).toBeNull();
  });

  it("returns null when target date precedes the earliest NAV", () => {
    const navs: ManualNavRow[] = [
      { asset_id: ASSET_A, effective_date: "2026-04-01", nav: 100 },
    ];
    expect(findNavAtOrBefore(navs, "2026-03-31")).toBeNull();
  });

  it("returns the exact NAV when target equals an effective_date", () => {
    const navs: ManualNavRow[] = [
      { asset_id: ASSET_A, effective_date: "2026-01-01", nav: 100 },
      { asset_id: ASSET_A, effective_date: "2026-04-01", nav: 110 },
    ];
    expect(findNavAtOrBefore(navs, "2026-04-01")).toBe(110);
    expect(findNavAtOrBefore(navs, "2026-01-01")).toBe(100);
  });

  it("returns the most-recent NAV strictly before target", () => {
    const navs: ManualNavRow[] = [
      { asset_id: ASSET_A, effective_date: "2026-01-01", nav: 100 },
      { asset_id: ASSET_A, effective_date: "2026-04-01", nav: 110 },
      { asset_id: ASSET_A, effective_date: "2026-07-01", nav: 120 },
    ];
    expect(findNavAtOrBefore(navs, "2026-03-15")).toBe(100);
    expect(findNavAtOrBefore(navs, "2026-06-30")).toBe(110);
    expect(findNavAtOrBefore(navs, "2026-12-31")).toBe(120);
  });

  it("handles large lists in O(log n) — sanity-check 1000 entries", () => {
    const navs: ManualNavRow[] = Array.from({ length: 1000 }, (_, i) => ({
      asset_id: ASSET_A,
      effective_date: `2020-01-${String((i % 28) + 1).padStart(2, "0")}`,
      nav: i,
    })).sort((a, b) => a.effective_date.localeCompare(b.effective_date));
    expect(findNavAtOrBefore(navs, "2020-01-15")).not.toBeNull();
  });
});

describe("buildNavIndex", () => {
  it("sorts NAVs ascending by effective_date regardless of input order", () => {
    const navs: ManualNavRow[] = [
      { asset_id: ASSET_A, effective_date: "2026-07-01", nav: 120 },
      { asset_id: ASSET_A, effective_date: "2026-01-01", nav: 100 },
      { asset_id: ASSET_A, effective_date: "2026-04-01", nav: 110 },
    ];
    const idx = buildNavIndex(navs);
    const listA = idx.get(ASSET_A)!;
    expect(listA.map((n) => n.effective_date)).toEqual([
      "2026-01-01",
      "2026-04-01",
      "2026-07-01",
    ]);
  });

  it("groups by asset_id", () => {
    const navs: ManualNavRow[] = [
      { asset_id: ASSET_A, effective_date: "2026-01-01", nav: 100 },
      { asset_id: ASSET_B, effective_date: "2026-01-01", nav: 200 },
      { asset_id: ASSET_A, effective_date: "2026-04-01", nav: 110 },
    ];
    const idx = buildNavIndex(navs);
    expect(idx.get(ASSET_A)).toHaveLength(2);
    expect(idx.get(ASSET_B)).toHaveLength(1);
  });
});

describe("snapshotEurPerUsd", () => {
  it("derives the rate from total_value_eur / total_value_usd", () => {
    const snap = makeSnapshot({ total_value_eur: 850, total_value_usd: 1000 });
    expect(snapshotEurPerUsd(snap)).toBe(0.85);
  });

  it("returns null when stocks/total/crypto/cash ratios are all single-zero", () => {
    // total_value_eur=0 but total_value_usd=1000 means the snapshot has USD
    // but no EUR aggregation. With crypto AND cash also single-zero, no tier
    // can derive a real rate. Audit R1 Phase 5 changed the contract from
    // `1` fallback to `null` so callers explicitly skip cross-currency mirror
    // instead of contaminating the foreign column with a 1:1 identity copy.
    expect(
      snapshotEurPerUsd(
        makeSnapshot({
          total_value_eur: 0,
          total_value_usd: 1000,
          crypto_value_eur: 0,
          crypto_value_usd: 0,
          cash_value_eur: 0,
          cash_value_usd: 0,
        }),
      ),
    ).toBeNull();
  });

  it("prefers crypto totals ratio when total ratio is unusable", () => {
    // Real-world case: USD-only snapshot has total_value_eur=0 but crypto
    // values from CoinGecko provide both currencies. Use the crypto ratio.
    const r = snapshotEurPerUsd(
      makeSnapshot({
        total_value_eur: 0,
        total_value_usd: 1000,
        crypto_value_eur: 850,
        crypto_value_usd: 1000,
        cash_value_eur: 0,
        cash_value_usd: 0,
      }),
    );
    expect(r).toBeCloseTo(0.85, 5);
  });

  it("returns null when ALL ratios are unavailable (totals/crypto/cash all single-zero or null)", () => {
    // Pre-positions snapshot with everything zero/null → no determinable FX
    // rate. Audit R1 Phase 5: returning `null` (not `1`) prevents the
    // augmentSnapshotsWithManualNavs cross-currency mirror from corrupting
    // the foreign column (e.g. EUR ELTIF NAV written 1:1 into stocks_value_usd).
    expect(
      snapshotEurPerUsd(
        makeSnapshot({
          total_value_eur: undefined,
          total_value_usd: undefined,
          crypto_value_eur: 0,
          crypto_value_usd: 0,
          cash_value_eur: 0,
          cash_value_usd: 0,
        }),
      ),
    ).toBeNull();
  });

  it("augmentation skips USD mirror when eurPerUsd is null (EUR ELTIF on zero-total snapshot)", () => {
    // Direct test of the audit R1 Phase 5 contract change: with no FX rate
    // determinable, EUR contribution adds to stocks_value_eur as usual but
    // stocks_value_usd is NOT polluted by a 1:1 identity copy.
    const positions: ManualPositionRow[] = [
      { stock_asset_id: ASSET_A, quantity: 1, currency: "EUR" },
    ];
    const navs: ManualNavRow[] = [
      { asset_id: ASSET_A, effective_date: "2026-04-01", nav: 1000 },
    ];
    const result = augmentSnapshotsWithManualNavs(
      [
        makeSnapshot({
          snapshot_date: "2026-04-15",
          total_value_eur: 0,
          total_value_usd: 0,
          crypto_value_eur: 0,
          crypto_value_usd: 0,
          cash_value_eur: 0,
          cash_value_usd: 0,
          stocks_value_eur: 0,
          stocks_value_usd: 0,
        }),
      ],
      positions,
      navs,
    );
    expect(result[0].stocks_value_eur).toBeCloseTo(1000, 2);
    // Old behaviour would have written 1000 here (1:1 identity contamination);
    // new behaviour correctly leaves it at 0 because no FX rate is known.
    expect(result[0].stocks_value_usd).toBe(0);
  });
});

describe("augmentSnapshotsWithManualNavs", () => {
  it("returns input unchanged when there are no manual positions", () => {
    const snaps = [makeSnapshot({ snapshot_date: "2026-03-15" })];
    expect(augmentSnapshotsWithManualNavs(snaps, [], [])).toEqual(snaps);
  });

  it("returns snapshot unchanged when no NAV exists at-or-before its date", () => {
    const snap = makeSnapshot({ snapshot_date: "2026-02-01" });
    const positions: ManualPositionRow[] = [
      { stock_asset_id: ASSET_A, quantity: 50, currency: "EUR" },
    ];
    const navs: ManualNavRow[] = [
      { asset_id: ASSET_A, effective_date: "2026-03-01", nav: 100 },
    ];
    const result = augmentSnapshotsWithManualNavs([snap], positions, navs);
    expect(result[0].stocks_value_eur).toBe(snap.stocks_value_eur);
    expect(result[0].total_value_eur).toBe(snap.total_value_eur);
  });

  it("adds qty × NAV to a same-currency snapshot (EUR-on-EUR)", () => {
    const snap = makeSnapshot({
      snapshot_date: "2026-04-15",
      stocks_value_eur: 1000,
      total_value_eur: 1000,
      stocks_value_usd: 1100,
      total_value_usd: 1100,
    });
    const positions: ManualPositionRow[] = [
      { stock_asset_id: ASSET_A, quantity: 50, currency: "EUR" },
    ];
    const navs: ManualNavRow[] = [
      { asset_id: ASSET_A, effective_date: "2026-04-01", nav: 110 },
    ];
    const result = augmentSnapshotsWithManualNavs([snap], positions, navs);

    expect(result[0].stocks_value_eur).toBeCloseTo(1000 + 50 * 110, 2);
    expect(result[0].total_value_eur).toBeCloseTo(1000 + 50 * 110, 2);

    const eurPerUsd = 1000 / 1100;
    const expectedUsdMirror = (50 * 110) / eurPerUsd;
    expect(result[0].stocks_value_usd).toBeCloseTo(1100 + expectedUsdMirror, 2);
  });

  it("uses snapshot's own EUR/USD rate for cross-currency conversion (USD asset on EUR snapshot)", () => {
    const snap = makeSnapshot({
      snapshot_date: "2026-04-15",
      stocks_value_eur: 850,
      total_value_eur: 850,
      stocks_value_usd: 1000,
      total_value_usd: 1000,
    });
    const positions: ManualPositionRow[] = [
      { stock_asset_id: ASSET_A, quantity: 10, currency: "USD" },
    ];
    const navs: ManualNavRow[] = [
      { asset_id: ASSET_A, effective_date: "2026-04-01", nav: 100 },
    ];
    const result = augmentSnapshotsWithManualNavs([snap], positions, navs);

    const usdContribution = 10 * 100;
    const eurPerUsd = 850 / 1000;

    expect(result[0].stocks_value_usd).toBeCloseTo(1000 + usdContribution, 2);
    expect(result[0].stocks_value_eur).toBeCloseTo(850 + usdContribution * eurPerUsd, 2);
  });

  it("handles non-USD/EUR currencies via best-effort cross-conversion", () => {
    const snap = makeSnapshot({
      snapshot_date: "2026-04-15",
      total_value_eur: 850,
      total_value_usd: 1000,
      stocks_value_eur: 850,
      stocks_value_usd: 1000,
    });
    const positions: ManualPositionRow[] = [
      { stock_asset_id: ASSET_A, quantity: 1, currency: "CHF" },
    ];
    const navs: ManualNavRow[] = [
      { asset_id: ASSET_A, effective_date: "2026-04-01", nav: 100 },
    ];
    const result = augmentSnapshotsWithManualNavs([snap], positions, navs);

    const eurPerUsd = 850 / 1000;
    expect(result[0].stocks_value_usd).toBeCloseTo(1100, 2);
    expect(result[0].stocks_value_eur).toBeCloseTo(850 + 100 * eurPerUsd, 2);
  });

  it("forward-fills NAVs (step function) — uses earlier NAV until a later one becomes effective", () => {
    const positions: ManualPositionRow[] = [
      { stock_asset_id: ASSET_A, quantity: 100, currency: "EUR" },
    ];
    const navs: ManualNavRow[] = [
      { asset_id: ASSET_A, effective_date: "2026-01-01", nav: 100 },
      { asset_id: ASSET_A, effective_date: "2026-04-01", nav: 110 },
    ];
    const snapshots = [
      makeSnapshot({ snapshot_date: "2026-02-01", stocks_value_eur: 0, total_value_eur: 0, stocks_value_usd: 0, total_value_usd: 0 }),
      makeSnapshot({ snapshot_date: "2026-03-31", stocks_value_eur: 0, total_value_eur: 0, stocks_value_usd: 0, total_value_usd: 0 }),
      makeSnapshot({ snapshot_date: "2026-04-01", stocks_value_eur: 0, total_value_eur: 0, stocks_value_usd: 0, total_value_usd: 0 }),
      makeSnapshot({ snapshot_date: "2026-04-15", stocks_value_eur: 0, total_value_eur: 0, stocks_value_usd: 0, total_value_usd: 0 }),
    ];
    const result = augmentSnapshotsWithManualNavs(snapshots, positions, navs);

    expect(result[0].stocks_value_eur).toBeCloseTo(10000, 2);
    expect(result[1].stocks_value_eur).toBeCloseTo(10000, 2);
    expect(result[2].stocks_value_eur).toBeCloseTo(11000, 2);
    expect(result[3].stocks_value_eur).toBeCloseTo(11000, 2);
  });

  it("aggregates contributions across multiple manual positions", () => {
    const snap = makeSnapshot({
      snapshot_date: "2026-04-15",
      stocks_value_eur: 0,
      total_value_eur: 0,
      stocks_value_usd: 0,
      total_value_usd: 0,
    });
    const positions: ManualPositionRow[] = [
      { stock_asset_id: ASSET_A, quantity: 50, currency: "EUR" },
      { stock_asset_id: ASSET_B, quantity: 25, currency: "EUR" },
    ];
    const navs: ManualNavRow[] = [
      { asset_id: ASSET_A, effective_date: "2026-04-01", nav: 110 },
      { asset_id: ASSET_B, effective_date: "2026-04-01", nav: 200 },
    ];
    const result = augmentSnapshotsWithManualNavs([snap], positions, navs);
    expect(result[0].stocks_value_eur).toBeCloseTo(50 * 110 + 25 * 200, 2);
  });

  it("is pure — does not mutate the input snapshots array or its rows", () => {
    const snap = makeSnapshot({ snapshot_date: "2026-04-15" });
    const original = JSON.parse(JSON.stringify(snap));
    const positions: ManualPositionRow[] = [
      { stock_asset_id: ASSET_A, quantity: 1, currency: "EUR" },
    ];
    const navs: ManualNavRow[] = [
      { asset_id: ASSET_A, effective_date: "2026-04-01", nav: 100 },
    ];
    augmentSnapshotsWithManualNavs([snap], positions, navs);
    expect(snap).toEqual(original);
  });
});
