import { describe, it, expect, vi, afterEach } from "vitest";
import {
  partitionStockAssetsForPricing,
  injectManualNavPrices,
  navStaleness,
} from "@/lib/manual-nav";
import type { StockAssetWithPositions, YahooStockPriceData } from "@/lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function asset(overrides: Partial<StockAssetWithPositions>): StockAssetWithPositions {
  return {
    id: "asset-1",
    user_id: "user-1",
    ticker: "AAPL",
    name: "Apple",
    isin: null,
    yahoo_ticker: "AAPL",
    kind: "yahoo",
    category: "individual_stock",
    subcategory: null,
    tags: null,
    currency: "USD",
    last_was_adjustment: false,
    last_was_transfer: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    positions: [],
    ...overrides,
  } as StockAssetWithPositions;
}

describe("partitionStockAssetsForPricing", () => {
  it("partitions all-yahoo input", () => {
    const r = partitionStockAssetsForPricing([
      asset({ id: "a", ticker: "AAPL", yahoo_ticker: "AAPL", kind: "yahoo" }),
      asset({ id: "b", ticker: "VWCE", yahoo_ticker: "VWCE.DE", kind: "yahoo" }),
    ]);
    expect(r.yahooStockAssets).toHaveLength(2);
    expect(r.manualStockAssets).toHaveLength(0);
    expect(r.yahooTickers).toEqual(["AAPL", "VWCE.DE"]);
  });

  it("partitions all-manual input", () => {
    const r = partitionStockAssetsForPricing([
      asset({ id: "a", ticker: "ENXF", yahoo_ticker: null, kind: "manual" }),
      asset({ id: "b", ticker: "SICAV", yahoo_ticker: null, kind: "manual" }),
    ]);
    expect(r.manualStockAssets).toHaveLength(2);
    expect(r.yahooStockAssets).toHaveLength(0);
    expect(r.yahooTickers).toEqual([]);
  });

  it("falls back to ticker when yahoo_ticker is null/empty", () => {
    const r = partitionStockAssetsForPricing([
      asset({ id: "a", ticker: "AAPL", yahoo_ticker: null, kind: "yahoo" }),
      asset({ id: "b", ticker: "MSFT", yahoo_ticker: "", kind: "yahoo" }),
    ]);
    expect(r.yahooTickers).toEqual(["AAPL", "MSFT"]);
  });

  it("warns and routes unknown kind to yahoo partition (defense-in-depth)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const weird = asset({ id: "x", ticker: "WEIRD", kind: "rogue-value" as "yahoo" });
    const r = partitionStockAssetsForPricing([weird]);
    expect(r.yahooStockAssets).toEqual([weird]);
    expect(r.manualStockAssets).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Unknown kind=\"rogue-value\""),
    );
  });

  it("handles empty input", () => {
    const r = partitionStockAssetsForPricing([]);
    expect(r.yahooStockAssets).toEqual([]);
    expect(r.manualStockAssets).toEqual([]);
    expect(r.yahooTickers).toEqual([]);
  });
});

describe("injectManualNavPrices", () => {
  it("writes a synthesized quote keyed by ticker for each manual asset with a NAV", () => {
    const prices: YahooStockPriceData = {};
    injectManualNavPrices(
      [
        { id: "a", ticker: "ENXF", currency: "EUR", name: "EQT" },
        { id: "b", ticker: "SICAV", currency: "USD", name: "SICAV Fund" },
      ],
      [
        { asset_id: "a", nav: 105.5, effective_date: "2026-04-01", note: null },
        { asset_id: "b", nav: 1000, effective_date: "2026-03-15", note: "Q1" },
      ],
      prices,
    );
    expect(prices["ENXF"]).toEqual({
      price: 105.5,
      previousClose: 105.5,
      change24h: 0,
      currency: "EUR",
      name: "EQT",
    });
    expect(prices["SICAV"].price).toBe(1000);
  });

  it("skips assets without a matching NAV", () => {
    const prices: YahooStockPriceData = {};
    injectManualNavPrices(
      [{ id: "a", ticker: "ENXF", currency: "EUR", name: "EQT" }],
      [],
      prices,
    );
    expect(prices["ENXF"]).toBeUndefined();
  });

  it("does not overwrite existing entries for tickers not in manual list", () => {
    const prices: YahooStockPriceData = {
      AAPL: { price: 200, previousClose: 199, change24h: 0.5, currency: "USD", name: "Apple" },
    };
    injectManualNavPrices(
      [{ id: "a", ticker: "ENXF", currency: "EUR", name: "EQT" }],
      [{ asset_id: "a", nav: 105.5, effective_date: "2026-04-01", note: null }],
      prices,
    );
    expect(prices["AAPL"].price).toBe(200);
    expect(prices["ENXF"].price).toBe(105.5);
  });
});

describe("navStaleness", () => {
  const NOW = new Date("2026-05-14T12:00:00Z");

  it("returns today for the same day", () => {
    expect(navStaleness("2026-05-14", NOW)).toEqual({ label: "today", daysAgo: 0 });
  });

  it("returns yesterday for the day before", () => {
    expect(navStaleness("2026-05-13", NOW)).toEqual({ label: "yesterday", daysAgo: 1 });
  });

  it("returns N days ago for older dates", () => {
    expect(navStaleness("2026-04-14", NOW)).toEqual({
      label: "30 days ago",
      daysAgo: 30,
    });
  });

  it("handles exact 45-day boundary", () => {
    expect(navStaleness("2026-03-30", NOW)).toEqual({ label: "45 days ago", daysAgo: 45 });
  });

  it("handles 46-day past-boundary", () => {
    expect(navStaleness("2026-03-29", NOW)).toEqual({ label: "46 days ago", daysAgo: 46 });
  });

  it("returns future date marker for dates after now", () => {
    const r = navStaleness("2027-01-01", NOW);
    expect(r.label).toBe("future date");
    expect(r.daysAgo).toBeLessThan(0);
  });

  it("returns unknown for malformed input", () => {
    const r = navStaleness("not-a-date", NOW);
    expect(r.label).toBe("unknown");
    expect(r.daysAgo).toBe(Number.POSITIVE_INFINITY);
  });

  it("returns unknown for empty input", () => {
    const r = navStaleness("", NOW);
    expect(r.label).toBe("unknown");
    expect(r.daysAgo).toBe(Number.POSITIVE_INFINITY);
  });

  it("leap year boundary — Feb 29 to Mar 1 is 1 day", () => {
    const ly = new Date("2024-03-01T00:00:00Z");
    expect(navStaleness("2024-02-29", ly)).toEqual({ label: "yesterday", daysAgo: 1 });
  });

  it("uses UTC-only arithmetic (no TZ skew)", () => {
    // Same input across different `now` times within the same UTC day → same daysAgo
    const morning = new Date("2026-05-14T00:00:00Z");
    const evening = new Date("2026-05-14T23:59:59Z");
    expect(navStaleness("2026-05-13", morning).daysAgo).toBe(1);
    expect(navStaleness("2026-05-13", evening).daysAgo).toBe(1);
  });
});
