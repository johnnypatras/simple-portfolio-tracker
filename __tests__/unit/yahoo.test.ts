import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prices/fetch-with-timeout", () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from "@/lib/prices/fetch-with-timeout";
import {
  searchStocks,
  getStockQuote,
  getStockPrices,
  fetchQuotesBatch,
  fetchIndexHistory,
  getStockAndIndexPrices,
  _resetCrumbForTesting,
} from "@/lib/prices/yahoo";

const mockFetch = fetchWithTimeout as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch.mockReset();
  _resetCrumbForTesting();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── searchStocks ───────────────────────────────────────────

describe("searchStocks", () => {
  it("returns mapped results for valid response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          quotes: [
            {
              symbol: "AAPL",
              shortname: "Apple Inc.",
              longname: "Apple Inc.",
              quoteType: "EQUITY",
              exchDisp: "NASDAQ",
              exchange: "NMS",
              isYahooFinance: true,
            },
          ],
        }),
    });

    const result = await searchStocks("AAPL");
    expect(result).toEqual([
      {
        symbol: "AAPL",
        shortname: "Apple Inc.",
        longname: "Apple Inc.",
        quoteType: "EQUITY",
        exchDisp: "NASDAQ",
        exchange: "NMS",
      },
    ]);
  });

  it("returns empty array on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const result = await searchStocks("AAPL");
    expect(result).toEqual([]);
  });

  it("returns empty array when quotes is empty", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ quotes: [] }),
    });

    const result = await searchStocks("AAPL");
    expect(result).toEqual([]);
  });

  it("returns empty array when quotes is not an array", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ quotes: null }),
    });

    const result = await searchStocks("AAPL");
    expect(result).toEqual([]);
  });

  it("returns empty array when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await searchStocks("AAPL");
    expect(result).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Search error"),
      expect.any(Error),
    );
  });

  it("filters out non-EQUITY/ETF results", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          quotes: [
            {
              symbol: "AAPL",
              shortname: "Apple",
              quoteType: "EQUITY",
              isYahooFinance: true,
              exchDisp: "NASDAQ",
              exchange: "NMS",
            },
            {
              symbol: "BTC-USD",
              shortname: "Bitcoin",
              quoteType: "CRYPTOCURRENCY",
              isYahooFinance: true,
              exchDisp: "",
              exchange: "CCC",
            },
            {
              symbol: "VWCE.DE",
              shortname: "Vanguard FTSE",
              quoteType: "ETF",
              isYahooFinance: true,
              exchDisp: "XETRA",
              exchange: "GER",
            },
          ],
        }),
    });

    const result = await searchStocks("test");
    expect(result).toHaveLength(2);
    expect(result[0].symbol).toBe("AAPL");
    expect(result[1].symbol).toBe("VWCE.DE");
  });

  it("filters out non-Yahoo results", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          quotes: [
            {
              symbol: "AAPL",
              shortname: "Apple",
              quoteType: "EQUITY",
              isYahooFinance: false,
              exchDisp: "NASDAQ",
              exchange: "NMS",
            },
          ],
        }),
    });

    const result = await searchStocks("AAPL");
    expect(result).toEqual([]);
  });
});

// ── getStockQuote ──────────────────────────────────────────

describe("getStockQuote", () => {
  it("returns quote data on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          chart: {
            result: [
              {
                meta: {
                  currency: "EUR",
                  longName: "Vanguard FTSE All-World",
                  regularMarketPrice: 115.5,
                },
              },
            ],
          },
        }),
    });

    const result = await getStockQuote("VWCE.DE");
    expect(result).toEqual({
      currency: "EUR",
      name: "Vanguard FTSE All-World",
      price: 115.5,
    });
  });

  it("returns null on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await getStockQuote("INVALID");
    expect(result).toBeNull();
  });

  it("returns null when response has invalid JSON (captcha page)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.reject(new SyntaxError("Unexpected token <")),
    });

    const result = await getStockQuote("AAPL");
    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it("returns null when meta is missing from result", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ chart: { result: [{}] } }),
    });

    const result = await getStockQuote("AAPL");
    expect(result).toBeNull();
  });

  it("returns null when result array is empty", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ chart: { result: [] } }),
    });

    const result = await getStockQuote("AAPL");
    expect(result).toBeNull();
  });

  it("returns null when chart.result is undefined", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ chart: {} }),
    });

    const result = await getStockQuote("AAPL");
    expect(result).toBeNull();
  });

  it("defaults currency to USD and price to 0 when meta fields are missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          chart: {
            result: [{ meta: {} }],
          },
        }),
    });

    const result = await getStockQuote("AAPL");
    expect(result).toEqual({
      currency: "USD",
      name: "AAPL",
      price: 0,
    });
  });

  it("returns null when fetch throws (network error)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Abort"));

    const result = await getStockQuote("AAPL");
    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("getStockQuote failed"),
      expect.any(Error),
    );
  });
});

// ── fetchQuotesBatch ───────────────────────────────────────

describe("fetchQuotesBatch", () => {
  it("returns empty map for empty symbols list", async () => {
    const result = await fetchQuotesBatch([]);
    expect(result.size).toBe(0);
  });

  it("returns empty map when crumb auth fails (no cookies)", async () => {
    // getYahooCrumb: Step 1 — fc.yahoo.com returns no cookies
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { getSetCookie: () => [] },
    });

    const result = await fetchQuotesBatch(["AAPL"]);
    expect(result.size).toBe(0);
  });

  it("returns empty map when crumb fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("DNS failure"));

    const result = await fetchQuotesBatch(["AAPL"]);
    expect(result.size).toBe(0);
  });

  it("returns empty map when batch returns non-JSON content-type", async () => {
    // Crumb auth succeeds
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        headers: {
          getSetCookie: () => ["A=val1; Path=/", "B=val2; Path=/"],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("valid-crumb"),
      })
      // Batch quote returns HTML (captcha)
      .mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (h: string) =>
            h === "content-type" ? "text/html" : null,
        },
      });

    const result = await fetchQuotesBatch(["AAPL"]);
    expect(result.size).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("non-JSON"),
    );
  });

  it("returns empty map and invalidates crumb on 401", async () => {
    // Crumb auth succeeds
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        headers: {
          getSetCookie: () => ["session=abc; Path=/"],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("crumb-token"),
      })
      // Batch returns 401
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: { get: () => null },
      });

    const result = await fetchQuotesBatch(["AAPL"]);
    expect(result.size).toBe(0);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Batch quote fetch failed"),
    );
  });

  it("returns empty map when quoteResponse.result is not an array", async () => {
    // Crumb auth succeeds
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        headers: {
          getSetCookie: () => ["session=abc; Path=/"],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("crumb-token"),
      })
      // Batch returns unexpected structure
      .mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (h: string) =>
            h === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ quoteResponse: { result: null } }),
      });

    const result = await fetchQuotesBatch(["AAPL"]);
    expect(result.size).toBe(0);
  });
});

// ── getStockPrices ─────────────────────────────────────────

describe("getStockPrices", () => {
  it("returns empty object for empty ticker list", async () => {
    const result = await getStockPrices([]);
    expect(result).toEqual({});
  });

  it("falls back to individual fetches when batch returns empty", async () => {
    // Crumb auth fails (no cookies) → batch returns empty map
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { getSetCookie: () => [] },
    });

    // Individual v8/chart fallback for the missing ticker
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (h: string) =>
          h === "content-type" ? "application/json" : null,
      },
      json: () =>
        Promise.resolve({
          chart: {
            result: [
              {
                meta: {
                  regularMarketPrice: 180,
                  chartPreviousClose: 175,
                  currency: "USD",
                  longName: "Apple Inc.",
                },
              },
            ],
          },
        }),
    });

    const result = await getStockPrices(["AAPL"]);
    expect(result["AAPL"]).toBeDefined();
    expect(result["AAPL"].price).toBe(180);
    expect(result["AAPL"].currency).toBe("USD");
    expect(result["AAPL"].change24h).toBeCloseTo(((180 - 175) / 175) * 100, 2);
  });

  it("returns partial results when some individual fallbacks fail", async () => {
    // Crumb auth fails → empty batch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { getSetCookie: () => [] },
    });

    // AAPL fallback succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (h: string) =>
          h === "content-type" ? "application/json" : null,
      },
      json: () =>
        Promise.resolve({
          chart: {
            result: [
              {
                meta: {
                  regularMarketPrice: 180,
                  currency: "USD",
                  longName: "Apple",
                },
              },
            ],
          },
        }),
    });

    // INVALID fallback fails
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await getStockPrices(["AAPL", "INVALID"]);
    expect(result["AAPL"]).toBeDefined();
    expect(result["INVALID"]).toBeUndefined();
  });
});

// ── fetchIndexHistory ──────────────────────────────────────

describe("fetchIndexHistory", () => {
  it("returns mapped daily closes on success", async () => {
    const ts1 = Math.floor(new Date("2024-01-15T00:00:00Z").getTime() / 1000);
    const ts2 = Math.floor(new Date("2024-01-16T00:00:00Z").getTime() / 1000);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          chart: {
            result: [
              {
                timestamp: [ts1, ts2],
                indicators: {
                  quote: [{ close: [4800.5, 4825.3] }],
                },
              },
            ],
          },
        }),
    });

    const result = await fetchIndexHistory("^GSPC", 30);
    expect(result).toEqual([
      { date: "2024-01-15", close: 4800.5 },
      { date: "2024-01-16", close: 4825.3 },
    ]);
  });

  it("returns empty array on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await fetchIndexHistory("^GSPC", 30);
    expect(result).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  it("returns empty array when result is missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ chart: { result: [] } }),
    });

    const result = await fetchIndexHistory("^GSPC", 30);
    expect(result).toEqual([]);
  });

  it("returns empty array when chart.result is undefined", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ chart: {} }),
    });

    const result = await fetchIndexHistory("^GSPC", 30);
    expect(result).toEqual([]);
  });

  it("skips null close values", async () => {
    const ts1 = Math.floor(new Date("2024-01-15T00:00:00Z").getTime() / 1000);
    const ts2 = Math.floor(new Date("2024-01-16T00:00:00Z").getTime() / 1000);
    const ts3 = Math.floor(new Date("2024-01-17T00:00:00Z").getTime() / 1000);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          chart: {
            result: [
              {
                timestamp: [ts1, ts2, ts3],
                indicators: {
                  quote: [{ close: [4800, null, 4825] }],
                },
              },
            ],
          },
        }),
    });

    const result = await fetchIndexHistory("^GSPC", 7);
    expect(result).toHaveLength(2);
    expect(result[0].close).toBe(4800);
    expect(result[1].close).toBe(4825);
  });

  it("returns empty array when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network timeout"));

    const result = await fetchIndexHistory("^GSPC", 30);
    expect(result).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Index history error"),
      expect.any(Error),
    );
  });

  it("handles missing timestamps and indicators gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          chart: {
            result: [
              {
                // no timestamp or indicators
              },
            ],
          },
        }),
    });

    const result = await fetchIndexHistory("^GSPC", 30);
    expect(result).toEqual([]);
  });

  it("selects correct range string for different day values", async () => {
    // 7 days → "7d"
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ chart: { result: [{ timestamp: [], indicators: { quote: [{ close: [] }] } }] } }),
    });
    await fetchIndexHistory("^GSPC", 7);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("range=7d"),
      expect.any(Object),
    );

    // 30 days → "1mo"
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ chart: { result: [{ timestamp: [], indicators: { quote: [{ close: [] }] } }] } }),
    });
    await fetchIndexHistory("^GSPC", 30);
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("range=1mo"),
      expect.any(Object),
    );

    // 90 days → "3mo"
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ chart: { result: [{ timestamp: [], indicators: { quote: [{ close: [] }] } }] } }),
    });
    await fetchIndexHistory("^GSPC", 90);
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("range=3mo"),
      expect.any(Object),
    );

    // 365 days → "1y"
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ chart: { result: [{ timestamp: [], indicators: { quote: [{ close: [] }] } }] } }),
    });
    await fetchIndexHistory("^GSPC", 365);
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("range=1y"),
      expect.any(Object),
    );

    // 500 days → "max"
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ chart: { result: [{ timestamp: [], indicators: { quote: [{ close: [] }] } }] } }),
    });
    await fetchIndexHistory("^GSPC", 500);
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("range=max"),
      expect.any(Object),
    );
  });
});

// ── getStockAndIndexPrices ─────────────────────────────────

describe("getStockAndIndexPrices", () => {
  it("returns split results from a single combined batch", async () => {
    // Crumb auth succeeds
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        headers: {
          getSetCookie: () => ["session=abc; Path=/"],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("crumb123"),
      })
      // Combined batch returns both stock and index data
      .mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (h: string) =>
            h === "content-type" ? "application/json" : null,
        },
        json: () =>
          Promise.resolve({
            quoteResponse: {
              result: [
                {
                  symbol: "AAPL",
                  regularMarketPrice: 180,
                  regularMarketPreviousClose: 175,
                  regularMarketChangePercent: 2.86,
                  currency: "USD",
                  longName: "Apple Inc.",
                  trailingAnnualDividendYield: 0.005,
                  trailingAnnualDividendRate: 0.96,
                },
                {
                  symbol: "^GSPC",
                  regularMarketPrice: 5200,
                  regularMarketPreviousClose: 5180,
                  regularMarketChangePercent: 0.39,
                  currency: "USD",
                  longName: "S&P 500",
                },
              ],
            },
          }),
      });

    const result = await getStockAndIndexPrices(["AAPL"]);

    expect(result.stockPrices["AAPL"]).toBeDefined();
    expect(result.stockPrices["AAPL"].price).toBe(180);

    expect(result.indexPrices["^GSPC"]).toBeDefined();
    expect(result.indexPrices["^GSPC"].price).toBe(5200);

    expect(result.dividends["AAPL"]).toBeDefined();
    expect(result.dividends["AAPL"].trailingYield).toBeCloseTo(0.5);
    expect(result.dividends["AAPL"].annualDividend).toBe(0.96);
  });

  it("returns empty results when batch completely fails", async () => {
    // Crumb auth fails
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { getSetCookie: () => [] },
    });

    // Fallback for AAPL also fails
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await getStockAndIndexPrices(["AAPL"]);
    expect(result.stockPrices).toEqual({});
    expect(result.indexPrices).toEqual({});
    expect(result.dividends).toEqual({});
  });
});
