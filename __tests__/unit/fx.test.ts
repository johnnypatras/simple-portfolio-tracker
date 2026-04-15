import { describe, it, expect, vi, afterEach } from "vitest";
import { convertToBase, getFXRates, getFXRatesSafe, fxChangeForCurrency } from "@/lib/prices/fx";

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

  it("converts GBP → EUR when GBP rate is present (tiered non-USD/EUR base)", () => {
    // rates[GBP] = 0.85 (GBP per 1 EUR) — so 500 GBP = 500 / 0.85 ≈ 588.24 EUR
    const result = convertToBase(500, "GBP", "EUR", { EUR: 1, GBP: 0.85, USD: 1.09 });
    expect(result).toBeCloseTo(500 / 0.85, 2);
  });
});

describe("fxChangeForCurrency", () => {
  it("returns 0 when asset currency matches primary currency", () => {
    expect(fxChangeForCurrency("USD", "USD", 1.5)).toBe(0);
    expect(fxChangeForCurrency("EUR", "EUR", 1.5)).toBe(0);
  });

  it("EUR primary + USD asset returns -eurUsdChange24h", () => {
    // EUR weakens vs USD (EUR/USD +1.5%) means USD-denominated holdings
    // translate to fewer EUR — negative impact for the EUR user.
    expect(fxChangeForCurrency("USD", "EUR", 1.5)).toBe(-1.5);
    expect(fxChangeForCurrency("USD", "EUR", -0.8)).toBe(0.8);
  });

  it("USD primary + EUR asset returns +eurUsdChange24h", () => {
    // EUR strengthens vs USD (EUR/USD +1.5%) means EUR-denominated holdings
    // translate to more USD — positive impact for the USD user.
    expect(fxChangeForCurrency("EUR", "USD", 1.5)).toBe(1.5);
    expect(fxChangeForCurrency("EUR", "USD", -0.8)).toBe(-0.8);
  });

  it("returns 0 for unsupported currency pairs", () => {
    // No 24h FX data for GBP, JPY, CHF, etc.
    expect(fxChangeForCurrency("GBP", "USD", 1.5)).toBe(0);
    expect(fxChangeForCurrency("JPY", "EUR", 1.5)).toBe(0);
    expect(fxChangeForCurrency("EUR", "GBP", 1.5)).toBe(0);
  });

  it("handles eurUsdChange24h = 0 (no FX move) for every pair", () => {
    // `-eurUsdChange24h` when input is 0 yields -0, which is `!== 0` under
    // Object.is equality. toBeCloseTo normalizes the sign.
    expect(fxChangeForCurrency("USD", "EUR", 0)).toBeCloseTo(0, 10);
    expect(fxChangeForCurrency("EUR", "USD", 0)).toBe(0);
    expect(fxChangeForCurrency("GBP", "USD", 0)).toBe(0);
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
