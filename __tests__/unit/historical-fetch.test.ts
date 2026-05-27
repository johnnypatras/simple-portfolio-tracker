import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchYahooDailyHistory,
  fetchFxUsdPivotHistory,
} from "@/lib/prices/historical";

afterEach(() => vi.restoreAllMocks());

function mockFetchOnce(body: unknown, ok = true, contentType = "application/json") {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
    ok,
    status: ok ? 200 : 500,
    headers: { get: () => contentType },
    json: async () => body,
  } as unknown as Response);
}

describe("fetchYahooDailyHistory", () => {
  it("parses timestamps + closes into {date, price} rows, dropping nulls", async () => {
    mockFetchOnce({
      chart: {
        result: [
          {
            meta: { dataGranularity: "1d" },
            timestamp: [1609459200, 1609545600], // 2021-01-01, 2021-01-02
            indicators: { quote: [{ close: [29000, null] }] },
          },
        ],
      },
    });
    const rows = await fetchYahooDailyHistory("BTC-USD", "2021-01-01", "2021-01-02");
    expect(rows).toEqual([{ date: "2021-01-01", price: 29000 }]);
  });

  it("returns [] on HTTP error (graceful degradation)", async () => {
    mockFetchOnce({}, false);
    expect(await fetchYahooDailyHistory("BTC-USD", "2021-01-01", "2021-01-02")).toEqual([]);
  });

  it("returns [] on non-JSON (captcha) response", async () => {
    mockFetchOnce("<html>", true, "text/html");
    expect(await fetchYahooDailyHistory("BTC-USD", "2021-01-01", "2021-01-02")).toEqual([]);
  });

  it("drops non-positive / non-finite closes", async () => {
    mockFetchOnce({
      chart: {
        result: [
          {
            meta: { dataGranularity: "1d" },
            timestamp: [1609459200, 1609545600, 1609632000],
            indicators: { quote: [{ close: [29000, 0, -5] }] },
          },
        ],
      },
    });
    const rows = await fetchYahooDailyHistory("BTC-USD", "2021-01-01", "2021-01-03");
    expect(rows).toEqual([{ date: "2021-01-01", price: 29000 }]);
  });

  it("returns [] and does not cache when Yahoo downsamples (granularity != 1d)", async () => {
    mockFetchOnce({
      chart: {
        result: [
          {
            meta: { dataGranularity: "3mo" },
            timestamp: [1609459200],
            indicators: { quote: [{ close: [29000] }] },
          },
        ],
      },
    });
    expect(await fetchYahooDailyHistory("BTC-USD", "2021-01-01", "2021-06-01")).toEqual([]);
  });

  it("passes through rows before startDate (the lookback pad is not filtered out)", async () => {
    mockFetchOnce({
      chart: {
        result: [
          {
            meta: { dataGranularity: "1d" },
            timestamp: [1608940800, 1609459200], // 2020-12-26, 2021-01-01
            indicators: { quote: [{ close: [28000, 29000] }] },
          },
        ],
      },
    });
    const rows = await fetchYahooDailyHistory("BTC-USD", "2021-01-01", "2021-01-02");
    // The pad window returns rows before startDate; callers store ALL rows.
    expect(rows.map((r) => r.date)).toContain("2020-12-26");
  });
});

describe("fetchFxUsdPivotHistory", () => {
  it("converts Frankfurter base=USD timeseries to USD-per-1-unit rows", async () => {
    // Frankfurter base=USD gives 'EUR per 1 USD'; we store USD per 1 EUR = 1/that.
    mockFetchOnce({
      base: "USD",
      rates: {
        "2021-01-01": { EUR: 0.8 }, // 0.8 EUR per USD → 1.25 USD per EUR
        "2021-01-02": { EUR: 0.82 }, // → 1.2195 USD per EUR
      },
    });
    const rows = await fetchFxUsdPivotHistory("EUR", "2021-01-01", "2021-01-02");
    expect(rows[0]).toEqual({ date: "2021-01-01", price: expect.closeTo(1.25, 4) });
    expect(rows[1].price).toBeCloseTo(1 / 0.82, 4);
  });

  it("returns [] when Frankfurter omits the symbol", async () => {
    mockFetchOnce({ base: "USD", rates: { "2021-01-01": {} } });
    expect(await fetchFxUsdPivotHistory("EUR", "2021-01-01", "2021-01-02")).toEqual([]);
  });

  it("returns [] on HTTP error", async () => {
    mockFetchOnce({}, false);
    expect(await fetchFxUsdPivotHistory("EUR", "2021-01-01", "2021-01-02")).toEqual([]);
  });

  it("returns [] for USD (the pivot is never stored/fetched)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await fetchFxUsdPivotHistory("USD", "2021-01-01", "2021-01-02")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("pads the fetch range backward so forward-fill has a prior rate at startDate", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ base: "USD", rates: { "2021-01-04": { EUR: 0.8 } } }),
    } as unknown as Response);
    await fetchFxUsdPivotHistory("EUR", "2021-01-04", "2021-01-10");
    const url = String(spy.mock.calls[0][0]);
    const m = url.match(/\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/);
    expect(m).not.toBeNull();
    // Requested start was 2021-01-04; the actual fetch must start strictly earlier.
    expect(m![1] < "2021-01-04").toBe(true);
    expect(m![2]).toBe("2021-01-10"); // end unchanged
  });
});
