import { describe, it, expect, vi, afterEach } from "vitest";
import { convertToBase, getFXRates, getFXRatesSafe } from "@/lib/prices/fx";

describe("convertToBase", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns amount unchanged when currencies match", () => {
    expect(convertToBase(100, "USD", "USD", { USD: 1 })).toBe(100);
  });

  it("converts correctly with valid rate", () => {
    // rates[EUR] = 0.92 means 0.92 EUR per 1 USD
    // So 92 EUR = 92 / 0.92 = 100 USD
    expect(convertToBase(92, "EUR", "USD", { EUR: 0.92, USD: 1 })).toBeCloseTo(100, 2);
  });

  it("returns unconverted amount when rate is missing", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = convertToBase(100, "GBP", "USD", { USD: 1 });
    expect(result).toBe(100);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("No rate for GBP"));
  });

  it("returns unconverted amount when rate is zero", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = convertToBase(100, "GBP", "USD", { GBP: 0, USD: 1 });
    expect(result).toBe(100);
  });
});

describe("getFXRates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns { base: 1 } when no other currencies requested", async () => {
    const result = await getFXRates("USD", []);
    expect(result).toEqual({ USD: 1 });
  });

  it("returns { base: 1 } when only base currency requested", async () => {
    const result = await getFXRates("USD", ["USD"]);
    expect(result).toEqual({ USD: 1 });
  });

  it("fetches rates from Frankfurter API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rates: { EUR: 0.92 } }),
    }));

    const result = await getFXRates("USD", ["EUR"]);
    expect(result).toEqual({ EUR: 0.92, USD: 1 });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("base=USD&symbols=EUR"),
      expect.any(Object)
    );
  });

  it("throws on API error after retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));

    await expect(getFXRates("USD", ["EUR"])).rejects.toThrow("returned 500");
  });

  it("throws when response is missing a requested rate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rates: {} }),
    }));

    await expect(getFXRates("USD", ["EUR"])).rejects.toThrow("no rate for");
  });
});

describe("getFXRatesSafe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns rates on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rates: { EUR: 0.92 } }),
    }));

    const result = await getFXRatesSafe("USD", ["EUR"]);
    expect(result).toEqual({ EUR: 0.92, USD: 1 });
  });

  it("returns fallback { base: 1 } on API error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));

    const result = await getFXRatesSafe("USD", ["EUR"]);
    expect(result).toEqual({ USD: 1 });
  });

  it("returns fallback { base: 1 } on network error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network error")));

    const result = await getFXRatesSafe("USD", ["EUR"]);
    expect(result).toEqual({ USD: 1 });
  });
});
