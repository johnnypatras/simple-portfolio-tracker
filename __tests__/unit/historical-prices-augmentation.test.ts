import { describe, it, expect } from "vitest";
import {
  findPriceAtOrBefore,
  buildPriceIndex,
  cumulativeAtDate,
  lotContributionAtDate,
  usdPerUnit,
  type HistoricalPriceRow,
  type HistoricalLot,
  type QtyDelta,
} from "@/lib/portfolio/historical-prices-augmentation";

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
