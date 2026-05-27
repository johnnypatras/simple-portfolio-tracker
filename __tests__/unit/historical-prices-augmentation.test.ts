import { describe, it, expect } from "vitest";
import {
  findPriceAtOrBefore,
  buildPriceIndex,
  cumulativeAtDate,
  type HistoricalPriceRow,
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
