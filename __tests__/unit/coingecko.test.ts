import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prices/fetch-with-timeout", () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from "@/lib/prices/fetch-with-timeout";
import {
  getPrices,
  searchCoins,
  getCoinDetail,
  getCoinImage,
  fetchCoinHistory,
} from "@/lib/prices/coingecko";

const mockFetch = fetchWithTimeout as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── getPrices ──────────────────────────────────────────────

describe("getPrices", () => {
  it("returns empty object for empty coin list", async () => {
    const result = await getPrices([]);
    expect(result).toEqual({});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns prices on success", async () => {
    const priceData = {
      bitcoin: { usd: 65000, eur: 60000, usd_24h_change: 2.5, eur_24h_change: 2.3 },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(priceData),
    });

    const result = await getPrices(["bitcoin"]);
    expect(result).toEqual(priceData);
  });

  it("retries on 429 then returns prices on success", async () => {
    const priceData = {
      bitcoin: { usd: 65000, eur: 60000 },
    };

    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(priceData),
      });

    const result = await getPrices(["bitcoin"]);
    expect(result).toEqual(priceData);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns empty object when both attempts return 429", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: false, status: 429 });

    const result = await getPrices(["bitcoin"]);
    expect(result).toEqual({});
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns empty object on non-429 HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await getPrices(["bitcoin"]);
    expect(result).toEqual({});
  });

  it("returns empty object when fetch throws (network error)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network failure"));

    const result = await getPrices(["bitcoin"]);
    expect(result).toEqual({});
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Fetch failed"),
      expect.any(Error),
    );
  });

  it("returns empty object when json() throws (invalid JSON)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    });

    const result = await getPrices(["bitcoin"]);
    expect(result).toEqual({});
  });

  it("returns empty object when response body is {}", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });

    const result = await getPrices(["nonexistent-coin"]);
    expect(result).toEqual({});
  });
});

// ── searchCoins ────────────────────────────────────────────

describe("searchCoins", () => {
  it("returns empty array for blank query", async () => {
    const result = await searchCoins("  ");
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns mapped results on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          coins: [
            {
              id: "bitcoin",
              name: "Bitcoin",
              symbol: "btc",
              thumb: "thumb.png",
              large: "large.png",
              market_cap_rank: 1,
            },
          ],
        }),
    });

    const result = await searchCoins("bitcoin");
    expect(result).toEqual([
      {
        id: "bitcoin",
        name: "Bitcoin",
        symbol: "btc",
        thumb: "thumb.png",
        large: "large.png",
        market_cap_rank: 1,
      },
    ]);
  });

  it("returns empty array on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: () => Promise.resolve("Service unavailable"),
    });

    const result = await searchCoins("bitcoin");
    expect(result).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  it("returns empty array when coins field is missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const result = await searchCoins("bitcoin");
    expect(result).toEqual([]);
  });

  it("propagates fetch errors", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Timeout"));

    await expect(searchCoins("bitcoin")).rejects.toThrow("Timeout");
  });

  it("limits results to 10", async () => {
    const coins = Array.from({ length: 15 }, (_, i) => ({
      id: `coin-${i}`,
      name: `Coin ${i}`,
      symbol: `C${i}`,
      thumb: "",
      large: "",
      market_cap_rank: i,
    }));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ coins }),
    });

    const result = await searchCoins("coin");
    expect(result).toHaveLength(10);
  });

  it("handles null market_cap_rank gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          coins: [
            {
              id: "test",
              name: "Test",
              symbol: "TST",
              thumb: "",
              large: "",
              // no market_cap_rank field
            },
          ],
        }),
    });

    const result = await searchCoins("test");
    expect(result[0].market_cap_rank).toBeNull();
  });
});

// ── getCoinDetail ──────────────────────────────────────────

describe("getCoinDetail", () => {
  it("returns parsed detail on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          name: "Bitcoin",
          asset_platform_id: null,
          categories: ["Layer 1 (L1)", "Cryptocurrency"],
          platforms: { "": "" },
          image: { thumb: "https://example.com/thumb.png" },
        }),
    });

    const result = await getCoinDetail("bitcoin");
    expect(result).toEqual({
      name: "Bitcoin",
      asset_platform_id: null,
      categories: ["Layer 1 (L1)", "Cryptocurrency"],
      platforms: {}, // empty-key platforms filtered out
      image_thumb: "https://example.com/thumb.png",
    });
  });

  it("returns null on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await getCoinDetail("nonexistent");
    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Coin detail failed"),
      404,
    );
  });

  it("returns null when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Abort"));

    const result = await getCoinDetail("bitcoin");
    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Coin detail error"),
      expect.any(Error),
    );
  });

  it("handles missing/incomplete data gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const result = await getCoinDetail("bitcoin");
    expect(result).toEqual({
      name: "",
      asset_platform_id: null,
      categories: [],
      platforms: {},
      image_thumb: null,
    });
  });

  it("filters empty-key platforms from response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          name: "Tether",
          asset_platform_id: "ethereum",
          categories: ["Stablecoin"],
          platforms: {
            "": "",
            ethereum: "0xdac17f958d2ee523a2206206994597c13d831ec7",
            "binance-smart-chain": "0x55d398326f99059ff775485246999027b3197955",
          },
          image: { thumb: "tether-thumb.png" },
        }),
    });

    const result = await getCoinDetail("tether");
    expect(result!.platforms).toEqual({
      ethereum: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "binance-smart-chain": "0x55d398326f99059ff775485246999027b3197955",
    });
    expect(result!.platforms[""]).toBeUndefined();
  });
});

// ── getCoinImage ───────────────────────────────────────────

describe("getCoinImage", () => {
  it("returns image URL from detail", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          name: "Bitcoin",
          image: { thumb: "https://cdn.example.com/btc.png" },
        }),
    });

    const result = await getCoinImage("bitcoin");
    expect(result).toBe("https://cdn.example.com/btc.png");
  });

  it("returns null when detail fetch fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await getCoinImage("bitcoin");
    expect(result).toBeNull();
  });
});

// ── fetchCoinHistory ───────────────────────────────────────

describe("fetchCoinHistory", () => {
  it("returns mapped daily prices on success", async () => {
    const ts1 = new Date("2024-01-15T00:00:00Z").getTime();
    const ts2 = new Date("2024-01-16T00:00:00Z").getTime();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          prices: [
            [ts1, 42000],
            [ts2, 43500],
          ],
        }),
    });

    const result = await fetchCoinHistory("bitcoin", 7);
    expect(result).toEqual([
      { date: "2024-01-15", price: 42000 },
      { date: "2024-01-16", price: 43500 },
    ]);
  });

  it("returns empty array on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });

    const result = await fetchCoinHistory("bitcoin", 30);
    expect(result).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  it("returns empty array when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Timeout"));

    const result = await fetchCoinHistory("bitcoin", 30);
    expect(result).toEqual([]);
  });

  it("returns empty array when prices field is missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const result = await fetchCoinHistory("bitcoin", 7);
    expect(result).toEqual([]);
  });
});
