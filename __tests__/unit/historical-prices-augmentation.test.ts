import { describe, it, expect } from "vitest";
import {
  findPriceAtOrBefore,
  buildPriceIndex,
  cumulativeAtDate,
  lotContributionAtDate,
  usdPerUnit,
  augmentAndExtendSnapshots,
  buildHistoricalLots,
  buildBenchmarkCashFlows,
  type HistoricalPriceRow,
  type HistoricalLot,
  type QtyDelta,
  type ActivityForLot,
} from "@/lib/portfolio/historical-prices-augmentation";
import type { PortfolioSnapshot } from "@/lib/types";

const px = (
  asset_kind: HistoricalPriceRow["asset_kind"],
  asset_key: string,
  price_date: string,
  price: number,
  currency = "USD",
): HistoricalPriceRow => ({ asset_kind, asset_key, price_date, price, currency });

describe("findPriceAtOrBefore", () => {
  it("returns null for an empty list", () => {
    expect(findPriceAtOrBefore([], "2026-01-01")).toBeNull();
  });

  it("returns null when the target precedes the earliest price", () => {
    const rows = [px("crypto", "bitcoin", "2021-01-10", 30000)];
    expect(findPriceAtOrBefore(rows, "2021-01-09")).toBeNull();
  });

  it("returns the exact price when the target equals a price_date", () => {
    const rows = [
      px("crypto", "bitcoin", "2021-01-01", 29000),
      px("crypto", "bitcoin", "2021-02-01", 33000),
    ];
    expect(findPriceAtOrBefore(rows, "2021-02-01")).toBe(33000);
  });

  it("forward-fills: returns the most-recent price strictly before the target (weekend/holiday gap)", () => {
    const rows = [
      px("crypto", "bitcoin", "2021-01-01", 29000),
      px("crypto", "bitcoin", "2021-01-04", 31000),
    ];
    // 2021-01-02 and 03 are a weekend with no row → forward-fill from Jan 1.
    expect(findPriceAtOrBefore(rows, "2021-01-03")).toBe(29000);
  });

  it("returns the price when the only element exactly matches the target", () => {
    const rows = [px("crypto", "bitcoin", "2021-01-01", 29000)];
    expect(findPriceAtOrBefore(rows, "2021-01-01")).toBe(29000);
  });
});

describe("buildPriceIndex", () => {
  it("groups by asset_kind:asset_key and sorts each group ascending by date", () => {
    const rows = [
      px("crypto", "bitcoin", "2021-03-01", 50000),
      px("stock", "AAPL", "2021-01-01", 130),
      px("crypto", "bitcoin", "2021-01-01", 29000),
      px("crypto", "bitcoin", "2021-02-01", 38000),
    ];
    const idx = buildPriceIndex(rows);
    expect(idx.get("crypto:bitcoin")!.map((r) => r.price_date)).toEqual([
      "2021-01-01",
      "2021-02-01",
      "2021-03-01",
    ]);
    expect(idx.get("stock:AAPL")).toHaveLength(1);
  });
});

describe("cumulativeAtDate", () => {
  const deltas: QtyDelta[] = [
    { effective_date: "2021-01-01", qty_delta: 5 },   // buy 5
    { effective_date: "2023-06-01", qty_delta: -2 },  // partial sell
    { effective_date: "2024-01-01", qty_delta: -3 },  // full sell
  ];

  it("is 0 before the first effective_date ($0-before-purchase building block)", () => {
    expect(cumulativeAtDate(deltas, "2020-12-31")).toBe(0);
  });

  it("replays buys and partial sells in date order", () => {
    expect(cumulativeAtDate(deltas, "2021-01-01")).toBe(5);
    expect(cumulativeAtDate(deltas, "2023-06-01")).toBe(3);
    expect(cumulativeAtDate(deltas, "2023-12-31")).toBe(3);
  });

  it("returns 0 after a full sell", () => {
    expect(cumulativeAtDate(deltas, "2024-01-01")).toBe(0);
    expect(cumulativeAtDate(deltas, "2025-01-01")).toBe(0);
  });

  it("ignores deltas given out of order (does not assume sorted input)", () => {
    const unordered: QtyDelta[] = [
      { effective_date: "2023-06-01", qty_delta: -2 },
      { effective_date: "2021-01-01", qty_delta: 5 },
    ];
    expect(cumulativeAtDate(unordered, "2022-01-01")).toBe(5);
  });
});

const lot = (overrides: Partial<HistoricalLot> = {}): HistoricalLot => ({
  position_id: "pos-1",
  asset_kind: "crypto",
  asset_key: "bitcoin",
  fetch_symbol: "BTC-USD",
  native_currency: "USD",
  asset_class: "crypto",
  capture_date: "2026-05-01",
  deltas: [{ effective_date: "2021-01-01", qty_delta: 2 }],
  ...overrides,
});

describe("usdPerUnit", () => {
  it("returns 1 for USD without consulting the index", () => {
    expect(usdPerUnit(new Map(), "USD", "2021-01-01")).toBe(1);
  });

  it("looks up USD-per-unit for a foreign currency, forward-filled", () => {
    const fxIndex = buildPriceIndex([
      px("fx", "EUR", "2021-01-01", 1.21), // USD per 1 EUR
    ]);
    expect(usdPerUnit(fxIndex, "EUR", "2021-03-01")).toBeCloseTo(1.21, 5);
  });

  it("returns null when no fx rate is available at-or-before the date", () => {
    const fxIndex = buildPriceIndex([px("fx", "EUR", "2021-06-01", 1.19)]);
    expect(usdPerUnit(fxIndex, "EUR", "2021-01-01")).toBeNull();
  });
});

describe("lotContributionAtDate", () => {
  it("returns {usd:0,eur:0} before the lot's effective_date ($0-BEFORE-PURCHASE INVARIANT)", () => {
    const prices = buildPriceIndex([px("crypto", "bitcoin", "2020-06-01", 9000)]);
    const fx = buildPriceIndex([px("fx", "EUR", "2020-06-01", 1.12)]);
    // Lot bought 2021-01-01; ask for 2020-12-31 — must contribute nothing
    // even though a BTC price exists for that date.
    const c = lotContributionAtDate(lot(), "2020-12-31", prices, fx);
    expect(c).toEqual({ usd: 0, eur: 0 });
  });

  it("crypto (USD-native): qty × BTC price, EUR via 1/usdPerUnit(EUR)", () => {
    const prices = buildPriceIndex([px("crypto", "bitcoin", "2021-01-01", 30000)]);
    const fx = buildPriceIndex([px("fx", "EUR", "2021-01-01", 1.2)]); // USD per EUR
    const c = lotContributionAtDate(lot(), "2021-01-01", prices, fx);
    expect(c!.usd).toBeCloseTo(2 * 30000, 2); // 60000
    // eurPerUsd = 1/1.2 = 0.8333 → 60000 × 0.8333 = 50000
    expect(c!.eur).toBeCloseTo(60000 / 1.2, 2);
  });

  it("returns null contribution when no price exists yet (pre-listing)", () => {
    const prices = buildPriceIndex([px("crypto", "bitcoin", "2021-06-01", 35000)]);
    const fx = buildPriceIndex([px("fx", "EUR", "2021-06-01", 1.18)]);
    // qty>0 at this date, but no price on-or-before 2021-03-01 → null (skip).
    expect(lotContributionAtDate(lot(), "2021-03-01", prices, fx)).toBeNull();
  });

  it("stock in native EUR: value is EUR-direct, USD via usdPerUnit(EUR)", () => {
    const stock = lot({
      asset_kind: "stock",
      asset_key: "SAP.DE",
      fetch_symbol: "SAP.DE",
      native_currency: "EUR",
      asset_class: "stocks",
      deltas: [{ effective_date: "2022-01-01", qty_delta: 10 }],
    });
    const prices = buildPriceIndex([px("stock", "SAP.DE", "2022-01-01", 100, "EUR")]);
    const fx = buildPriceIndex([px("fx", "EUR", "2022-01-01", 1.13)]); // USD per EUR
    const c = lotContributionAtDate(stock, "2022-01-01", prices, fx);
    expect(c!.eur).toBeCloseTo(10 * 100, 2); // 1000 EUR
    expect(c!.usd).toBeCloseTo(10 * 100 * 1.13, 2); // → USD
  });

  it("skips EUR mirror (eur=0) when fx is unavailable, never fabricates 1:1", () => {
    const prices = buildPriceIndex([px("crypto", "bitcoin", "2021-01-01", 30000)]);
    const fx = buildPriceIndex([]); // no fx at all
    const c = lotContributionAtDate(lot(), "2021-01-01", prices, fx);
    expect(c!.usd).toBeCloseTo(60000, 2);
    expect(c!.eur).toBe(0); // mirror skipped, not contaminated
  });

  it("guards against NaN/Infinity in price or qty", () => {
    const prices = buildPriceIndex([px("crypto", "bitcoin", "2021-01-01", 30000)]);
    const fx = buildPriceIndex([px("fx", "EUR", "2021-01-01", 1.2)]);
    const bad = lot({ deltas: [{ effective_date: "2021-01-01", qty_delta: NaN }] });
    expect(lotContributionAtDate(bad, "2021-01-01", prices, fx)).toBeNull();
  });

  it("returns {usd:0,eur:0} after a full sell (qty nets to zero at the date)", () => {
    const sold = lot({
      deltas: [
        { effective_date: "2021-01-01", qty_delta: 2 },
        { effective_date: "2023-01-01", qty_delta: -2 },
      ],
    });
    const prices = buildPriceIndex([
      px("crypto", "bitcoin", "2021-01-01", 30000),
      px("crypto", "bitcoin", "2023-01-01", 27000),
    ]);
    const fx = buildPriceIndex([px("fx", "EUR", "2021-01-01", 1.2)]);
    expect(lotContributionAtDate(sold, "2023-06-01", prices, fx)).toEqual({ usd: 0, eur: 0 });
  });

  it("stock in native GBP: USD via usdPerUnit(GBP), EUR via usdPerUnit(EUR)", () => {
    const gbpStock = lot({
      asset_kind: "stock",
      asset_key: "VOD.L",
      fetch_symbol: "VOD.L",
      native_currency: "GBP",
      asset_class: "stocks",
      deltas: [{ effective_date: "2022-01-01", qty_delta: 10 }],
    });
    const prices = buildPriceIndex([px("stock", "VOD.L", "2022-01-01", 50, "GBP")]);
    const fx = buildPriceIndex([
      px("fx", "GBP", "2022-01-01", 1.3), // USD per GBP
      px("fx", "EUR", "2022-01-01", 1.1), // USD per EUR
    ]);
    const c = lotContributionAtDate(gbpStock, "2022-01-01", prices, fx);
    // valueNative = 10 × 50 = 500 GBP → usd = 500 × 1.3 = 650
    expect(c!.usd).toBeCloseTo(650, 2);
    // eur = usd / (USD per EUR) = 650 / 1.1
    expect(c!.eur).toBeCloseTo(650 / 1.1, 2);
  });
});

function snap(overrides: Partial<PortfolioSnapshot>): PortfolioSnapshot {
  return {
    id: "s",
    user_id: "u",
    snapshot_date: "2026-03-01",
    total_value_usd: 0,
    total_value_eur: 0,
    crypto_value_usd: 0,
    stocks_value_usd: 0,
    cash_value_usd: 0,
    crypto_value_eur: 0,
    stocks_value_eur: 0,
    cash_value_eur: 0,
    stocks_eur_denominated_value: 0,
    cash_eur_denominated_value: 0,
    created_at: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

// 2 BTC bought 2021-01-01, captured by cron 2026-03-01. Prices: 30k @2021,
// 60k @2026-02. FX 1.2 USD/EUR throughout.
const btcLot: HistoricalLot = {
  position_id: "btc-1",
  asset_kind: "crypto",
  asset_key: "bitcoin",
  fetch_symbol: "BTC-USD",
  native_currency: "USD",
  asset_class: "crypto",
  capture_date: "2026-03-01",
  deltas: [{ effective_date: "2021-01-01", qty_delta: 2 }],
};
const priceRows: HistoricalPriceRow[] = [
  px("crypto", "bitcoin", "2021-01-01", 30000),
  px("crypto", "bitcoin", "2026-02-01", 60000),
  px("fx", "EUR", "2021-01-01", 1.2),
  px("fx", "EUR", "2026-02-01", 1.2),
];

describe("augmentAndExtendSnapshots", () => {
  it("returns input unchanged when there are no lots", () => {
    const snaps = [snap({ snapshot_date: "2026-03-01" })];
    expect(augmentAndExtendSnapshots(snaps, [], [])).toEqual(snaps);
  });

  it("synthesizes pre-first-snapshot rows AND extends back to effective_date", () => {
    const real = snap({
      snapshot_date: "2026-03-01",
      crypto_value_usd: 120000, // cron already priced 2 BTC @ 60k
      total_value_usd: 120000,
      crypto_value_eur: 100000,
      total_value_eur: 100000,
    });
    const out = augmentAndExtendSnapshots([real], [btcLot], priceRows);

    expect(out[0].snapshot_date).toBe("2021-01-01");
    expect(out[0].crypto_value_usd).toBeCloseTo(60000, 2);
    expect(out[0].total_value_usd).toBeCloseTo(60000, 2);
    expect(out[0].crypto_value_eur).toBeCloseTo(60000 / 1.2, 2);

    expect(out[out.length - 1].snapshot_date).toBe("2026-03-01");
    for (let i = 1; i < out.length; i++) {
      expect(out[i].snapshot_date >= out[i - 1].snapshot_date).toBe(true);
    }
  });

  it("does NOT touch the real snapshot on/after capture_date (no double-count)", () => {
    const real = snap({
      snapshot_date: "2026-03-01", // == capture_date → already includes the lot
      crypto_value_usd: 120000,
      total_value_usd: 120000,
    });
    const out = augmentAndExtendSnapshots([real], [btcLot], priceRows);
    const captured = out.find((s) => s.snapshot_date === "2026-03-01")!;
    expect(captured.crypto_value_usd).toBe(120000); // unchanged
  });

  it("AUGMENTS an in-window snapshot before capture_date that is missing the lot", () => {
    const before = snap({
      snapshot_date: "2026-02-15",
      crypto_value_usd: 0,
      total_value_usd: 0,
    });
    const captured = snap({
      snapshot_date: "2026-03-01",
      crypto_value_usd: 120000,
      total_value_usd: 120000,
    });
    const out = augmentAndExtendSnapshots([before, captured], [btcLot], priceRows);

    const aug = out.find((s) => s.snapshot_date === "2026-02-15")!;
    // 2 BTC × 60k (forward-filled from 2026-02-01) = 120000 added.
    expect(aug.crypto_value_usd).toBeCloseTo(120000, 2);
    expect(out.find((s) => s.snapshot_date === "2026-03-01")!.crypto_value_usd).toBe(120000);
  });

  it("never synthesizes before the earliest effective_date (far-back cap)", () => {
    const real = snap({ snapshot_date: "2026-03-01", crypto_value_usd: 120000, total_value_usd: 120000 });
    const out = augmentAndExtendSnapshots([real], [btcLot], priceRows);
    expect(out.every((s) => s.snapshot_date >= "2021-01-01")).toBe(true);
  });

  it("is pure — does not mutate the input snapshots", () => {
    const real = snap({ snapshot_date: "2026-03-01", crypto_value_usd: 120000, total_value_usd: 120000 });
    const frozen = JSON.parse(JSON.stringify(real));
    augmentAndExtendSnapshots([real], [btcLot], priceRows);
    expect(real).toEqual(frozen);
  });

  it("handles the no-real-snapshots case (brand-new user, all history synthesized)", () => {
    const out = augmentAndExtendSnapshots([], [btcLot], priceRows);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].snapshot_date).toBe("2021-01-01");
    expect(out[0].crypto_value_usd).toBeCloseTo(60000, 2);
  });

  it("synthesized EUR is 0 when no FX rate covers the date (fetch layer must guarantee FX coverage)", () => {
    const real = snap({ snapshot_date: "2021-02-01", crypto_value_usd: 60000, total_value_usd: 60000 });
    const pricesNoFx: HistoricalPriceRow[] = [
      px("crypto", "bitcoin", "2021-01-01", 30000),
      // intentionally NO fx:EUR rows → eur mirror cannot be computed
    ];
    const out = augmentAndExtendSnapshots(
      [real],
      [{ ...btcLot, capture_date: "2021-02-01" }],
      pricesNoFx,
    );
    expect(out[0].snapshot_date).toBe("2021-01-01");
    expect(out[0].crypto_value_usd).toBeCloseTo(60000, 2);
    // Honest no-fabrication: eur stays 0 when FX is absent. The fetch layer
    // pads FX backward to avoid this in practice.
    expect(out[0].crypto_value_eur).toBe(0);
  });

  it("synthesizes zero rows when earliest effective_date is after the first snapshot (augment-only)", () => {
    const real = snap({ snapshot_date: "2026-01-01", crypto_value_usd: 0, total_value_usd: 0 });
    const recentLot: HistoricalLot = {
      ...btcLot,
      capture_date: "2026-05-01",
      deltas: [{ effective_date: "2026-02-01", qty_delta: 2 }],
    };
    const prices: HistoricalPriceRow[] = [
      px("crypto", "bitcoin", "2026-02-01", 60000),
      px("fx", "EUR", "2026-02-01", 1.2),
    ];
    const out = augmentAndExtendSnapshots([real], [recentLot], prices);
    // earliestEffective (2026-02-01) is after the first snapshot → no synthesis.
    expect(out.length).toBe(1);
    expect(out[0].snapshot_date).toBe("2026-01-01");
    // At 2026-01-01 the lot doesn't exist yet (qty 0) → real row untouched.
    expect(out[0].crypto_value_usd).toBe(0);
  });

  it("clamps synthesis to MAX_SYNTHESIS_DAYS for pathologically old effective dates", () => {
    const ancient: HistoricalLot = {
      ...btcLot,
      capture_date: "2026-03-01",
      deltas: [{ effective_date: "1996-01-01", qty_delta: 2 }],
    };
    const prices: HistoricalPriceRow[] = [
      px("crypto", "bitcoin", "1996-01-01", 1),
      px("fx", "EUR", "1996-01-01", 1.2),
    ];
    const real = snap({ snapshot_date: "2026-03-01", crypto_value_usd: 120000, total_value_usd: 120000 });
    const out = augmentAndExtendSnapshots([real], [ancient], prices);
    // Earliest synthesized date must be ~25y ago, far later than 1996.
    expect(out[0].snapshot_date > "2000-01-01").toBe(true);
  });

  it("synthesizes a combined crypto + stock row (multi-lot)", () => {
    const stockLot: HistoricalLot = {
      position_id: "aapl-1",
      asset_kind: "stock",
      asset_key: "AAPL",
      fetch_symbol: "AAPL",
      native_currency: "USD",
      asset_class: "stocks",
      capture_date: "2026-03-01",
      deltas: [{ effective_date: "2021-01-01", qty_delta: 10 }],
    };
    const prices: HistoricalPriceRow[] = [
      px("crypto", "bitcoin", "2021-01-01", 30000),
      px("stock", "AAPL", "2021-01-01", 130),
      px("fx", "EUR", "2021-01-01", 1.2),
    ];
    const real = snap({ snapshot_date: "2021-02-01" });
    const out = augmentAndExtendSnapshots(
      [real],
      [{ ...btcLot, capture_date: "2021-02-01" }, stockLot],
      prices,
    );
    // out[0] = 2021-01-01: crypto 2×30000=60000, stocks 10×130=1300.
    expect(out[0].crypto_value_usd).toBeCloseTo(60000, 2);
    expect(out[0].stocks_value_usd).toBeCloseTo(1300, 2);
    expect(out[0].total_value_usd).toBeCloseTo(61300, 2);
  });

  it("augment boundary: capture-1 augmented, capture and capture+1 untouched", () => {
    const lot1 = { ...btcLot, capture_date: "2026-03-01" };
    const snaps = [
      snap({ snapshot_date: "2026-02-28", crypto_value_usd: 0, total_value_usd: 0 }),       // capture-1 → augment
      snap({ snapshot_date: "2026-03-01", crypto_value_usd: 120000, total_value_usd: 120000 }), // capture → untouched
      snap({ snapshot_date: "2026-03-02", crypto_value_usd: 120000, total_value_usd: 120000 }), // capture+1 → untouched
    ];
    const out = augmentAndExtendSnapshots(snaps, [lot1], priceRows);
    const m = new Map(out.map((s) => [s.snapshot_date, s]));
    expect(m.get("2026-02-28")!.crypto_value_usd).toBeCloseTo(120000, 2); // 2 × 60000 forward-filled
    expect(m.get("2026-03-01")!.crypto_value_usd).toBe(120000); // untouched
    expect(m.get("2026-03-02")!.crypto_value_usd).toBe(120000); // untouched
  });
});

describe("buildHistoricalLots", () => {
  it("groups activity by position, derives capture_date (min created_at) + deltas, flags backdated", () => {
    const rows: ActivityForLot[] = [
      {
        entity_id: "btc-1",
        entity_type: "crypto_position",
        action: "created",
        effective_date: "2021-01-01",
        created_at: "2026-05-20T10:00:00Z",
        before_quantity: null,
        after_quantity: 2,
        is_adjustment: false,
        asset_kind: "crypto",
        asset_key: "bitcoin",
        fetch_symbol: "BTC-USD",
        native_currency: "USD",
        asset_class: "crypto",
      },
    ];
    const lots = buildHistoricalLots(rows);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({
      position_id: "btc-1",
      capture_date: "2026-05-20",
      asset_key: "bitcoin",
      deltas: [{ effective_date: "2021-01-01", qty_delta: 2 }],
    });
  });

  it("excludes non-backdated positions (effective_date == capture date → empty augment range)", () => {
    const rows: ActivityForLot[] = [
      {
        entity_id: "btc-2",
        entity_type: "crypto_position",
        action: "created",
        effective_date: "2026-05-20",
        created_at: "2026-05-20T10:00:00Z",
        before_quantity: null,
        after_quantity: 1,
        is_adjustment: false,
        asset_kind: "crypto",
        asset_key: "bitcoin",
        fetch_symbol: "BTC-USD",
        native_currency: "USD",
        asset_class: "crypto",
      },
    ];
    expect(buildHistoricalLots(rows)).toEqual([]);
  });

  it("reconstructs a split-child quantity from qty_delta_override (before/after snapshots are null)", () => {
    const rows: ActivityForLot[] = [
      {
        entity_id: "btc-3",
        entity_type: "crypto_position",
        action: "created",
        effective_date: "2021-01-01",
        created_at: "2026-05-20T10:00:00Z",
        before_quantity: null,
        after_quantity: null,
        qty_delta_override: 3, // from details.split_quantity
        is_adjustment: false,
        asset_kind: "crypto",
        asset_key: "bitcoin",
        fetch_symbol: "BTC-USD",
        native_currency: "USD",
        asset_class: "crypto",
      },
    ];
    const lots = buildHistoricalLots(rows);
    expect(lots).toHaveLength(1);
    expect(lots[0].deltas).toEqual([{ effective_date: "2021-01-01", qty_delta: 3, is_adjustment: false }]);
  });
});

describe("buildHistoricalLots — is_adjustment threading (Phase 2)", () => {
  it("propagates is_adjustment from activity rows onto each delta", () => {
    const rows: ActivityForLot[] = [
      {
        entity_id: "btc-1",
        entity_type: "crypto_position",
        action: "created",
        effective_date: "2021-01-01",
        created_at: "2026-05-20T10:00:00Z",
        before_quantity: null,
        after_quantity: 2,
        is_adjustment: true,
        asset_kind: "crypto",
        asset_key: "bitcoin",
        fetch_symbol: "BTC-USD",
        native_currency: "USD",
        asset_class: "crypto",
      },
    ];
    const lots = buildHistoricalLots(rows);
    expect(lots[0].deltas[0].is_adjustment).toBe(true);
  });
});

describe("buildBenchmarkCashFlows", () => {
  const benchPrices: HistoricalPriceRow[] = [
    px("crypto", "bitcoin", "2021-01-01", 30000),
    px("crypto", "bitcoin", "2023-06-01", 27000),
    px("fx", "EUR", "2021-01-01", 1.2),
    px("fx", "EUR", "2023-06-01", 1.08),
  ];

  it("emits a positive flow for an is_adjustment buy, valued qty × price × usdRate", () => {
    const lots: HistoricalLot[] = [
      { position_id: "btc-1", asset_kind: "crypto", asset_key: "bitcoin", fetch_symbol: "BTC-USD", native_currency: "USD", asset_class: "crypto", capture_date: "2026-05-01", deltas: [{ effective_date: "2021-01-01", qty_delta: 2, is_adjustment: true }] },
    ];
    const flows = buildBenchmarkCashFlows(lots, benchPrices);
    expect(flows).toHaveLength(1);
    expect(flows[0].date).toBe("2021-01-01");
    expect(flows[0].amount_usd).toBeCloseTo(2 * 30000, 2);
    expect(flows[0].amount_eur).toBeCloseTo((2 * 30000) / 1.2, 2);
    expect(flows[0].asset_class).toBe("crypto");
  });

  it("emits a negative flow for an is_adjustment sell", () => {
    const lots: HistoricalLot[] = [
      { position_id: "btc-1", asset_kind: "crypto", asset_key: "bitcoin", fetch_symbol: "BTC-USD", native_currency: "USD", asset_class: "crypto", capture_date: "2026-05-01", deltas: [ { effective_date: "2021-01-01", qty_delta: 2, is_adjustment: true }, { effective_date: "2023-06-01", qty_delta: -1, is_adjustment: true } ] },
    ];
    const flows = buildBenchmarkCashFlows(lots, benchPrices).sort((a, b) => a.date.localeCompare(b.date));
    expect(flows[1].amount_usd).toBeCloseTo(-1 * 27000, 2);
  });

  it("ignores non-adjustment deltas (already in deriveCashFlows — no double-count)", () => {
    const lots: HistoricalLot[] = [
      { position_id: "btc-1", asset_kind: "crypto", asset_key: "bitcoin", fetch_symbol: "BTC-USD", native_currency: "USD", asset_class: "crypto", capture_date: "2026-05-01", deltas: [{ effective_date: "2021-01-01", qty_delta: 2, is_adjustment: false }] },
    ];
    expect(buildBenchmarkCashFlows(lots, benchPrices)).toEqual([]);
  });

  it("skips a delta when no historical price exists at-or-before its date", () => {
    const lots: HistoricalLot[] = [
      { position_id: "btc-1", asset_kind: "crypto", asset_key: "bitcoin", fetch_symbol: "BTC-USD", native_currency: "USD", asset_class: "crypto", capture_date: "2026-05-01", deltas: [{ effective_date: "2020-01-01", qty_delta: 2, is_adjustment: true }] },
    ];
    expect(buildBenchmarkCashFlows(lots, benchPrices)).toEqual([]);
  });
});

describe("lotContributionAtDate — CASH absolute truth", () => {
  const cashLot = (overrides: Partial<HistoricalLot> = {}): HistoricalLot => ({
    position_id: "cash-1",
    asset_kind: "cash",
    asset_key: "cash-1",
    fetch_symbol: "",
    native_currency: "EUR",
    asset_class: "cash",
    capture_date: "2026-05-01",
    deltas: [{ effective_date: "2021-06-01", qty_delta: 1000, is_adjustment: true }],
    ...overrides,
  });

  it("returns $0 STRICTLY BEFORE the cash effective_date (absolute-truth invariant)", () => {
    const prices = buildPriceIndex([px("fx", "EUR", "2021-06-01", 1.2)]);
    expect(lotContributionAtDate(cashLot(), "2021-05-31", new Map(), prices))
      .toEqual({ usd: 0, eur: 0 });
  });

  it("face value × FX from effective_date onward — NO price lookup", () => {
    const fx = buildPriceIndex([px("fx", "EUR", "2021-06-01", 1.2)]); // 1.2 USD per EUR
    const c = lotContributionAtDate(cashLot(), "2021-06-01", new Map(), fx);
    expect(c!.eur).toBeCloseTo(1000, 2);   // face value in native EUR
    expect(c!.usd).toBeCloseTo(1200, 2);   // 1000 EUR × 1.2 USD/EUR
  });

  it("USD-native cash skips FX (usdPerUnit('USD') = 1)", () => {
    const usdCash = cashLot({ native_currency: "USD" });
    const c = lotContributionAtDate(usdCash, "2021-06-01", new Map(), new Map());
    expect(c!.usd).toBe(1000);
    // No EUR rate available → eur stays 0 (no 1:1 fabrication — honest)
    expect(c!.eur).toBe(0);
  });

  it("balance changes over time replay correctly (cumulativeAtDate primitive)", () => {
    const grow = cashLot({
      deltas: [
        { effective_date: "2021-06-01", qty_delta: 1000, is_adjustment: true },
        { effective_date: "2022-01-01", qty_delta: 500,  is_adjustment: true },
        { effective_date: "2023-06-01", qty_delta: -200, is_adjustment: true },
      ],
    });
    const fx = buildPriceIndex([
      px("fx", "EUR", "2021-06-01", 1.2), px("fx", "EUR", "2022-01-01", 1.13),
      px("fx", "EUR", "2023-06-01", 1.08),
    ]);
    expect(lotContributionAtDate(grow, "2021-05-31", new Map(), fx)).toEqual({ usd: 0, eur: 0 });
    expect(lotContributionAtDate(grow, "2021-06-01", new Map(), fx)!.eur).toBeCloseTo(1000, 2);
    expect(lotContributionAtDate(grow, "2022-01-01", new Map(), fx)!.eur).toBeCloseTo(1500, 2);
    expect(lotContributionAtDate(grow, "2023-06-01", new Map(), fx)!.eur).toBeCloseTo(1300, 2);
  });
});

describe("augmentAndExtendSnapshots — CASH routing", () => {
  it("routes cash contribution to cash_value_* (NOT crypto/stocks)", () => {
    const cashLot: HistoricalLot = {
      position_id: "cash-1", asset_kind: "cash", asset_key: "cash-1", fetch_symbol: "",
      native_currency: "EUR", asset_class: "cash", capture_date: "2026-05-01",
      deltas: [{ effective_date: "2021-06-01", qty_delta: 1000, is_adjustment: true }],
    };
    const prices: HistoricalPriceRow[] = [
      px("fx", "EUR", "2021-06-01", 1.2),
    ];
    const real: PortfolioSnapshot = {
      id: "s", user_id: "u", snapshot_date: "2026-05-01",
      total_value_usd: 0, total_value_eur: 0,
      crypto_value_usd: 0, stocks_value_usd: 0, cash_value_usd: 0,
      crypto_value_eur: 0, stocks_value_eur: 0, cash_value_eur: 0,
      stocks_eur_denominated_value: 0, cash_eur_denominated_value: 0,
      created_at: "2026-05-01T00:00:00Z",
    };
    const out = augmentAndExtendSnapshots([real], [cashLot], prices);
    const synth = out[0]; // earliest synthesized day = 2021-06-01
    expect(synth.snapshot_date).toBe("2021-06-01");
    expect(synth.cash_value_eur).toBeCloseTo(1000, 2);
    expect(synth.crypto_value_eur).toBe(0);   // routing: cash → cash_*, NOT crypto
    expect(synth.stocks_value_eur).toBe(0);
  });
});
