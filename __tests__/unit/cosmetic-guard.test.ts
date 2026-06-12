import { describe, it, expect, vi, afterEach } from "vitest";
import { approxDeltaValueEur, needsCosmeticConfirm } from "@/lib/cosmetic-guard";
import { COSMETIC_GUARD_THRESHOLD_EUR } from "@/lib/constants";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("approxDeltaValueEur", () => {
  it("crypto: absDelta × priceEur", () => {
    expect(
      approxDeltaValueEur({ kind: "crypto", absDelta: 10, priceEur: 0.87 }),
    ).toBeCloseTo(8.7);
  });

  it("crypto: missing price → null (unknown value)", () => {
    expect(
      approxDeltaValueEur({ kind: "crypto", absDelta: 10, priceEur: undefined }),
    ).toBeNull();
  });

  it("crypto: NaN price → null", () => {
    expect(
      approxDeltaValueEur({ kind: "crypto", absDelta: 10, priceEur: Number.NaN }),
    ).toBeNull();
  });

  it("crypto: zero price values to 0 (quiet) — pin against a null-refactor", () => {
    expect(approxDeltaValueEur({ kind: "crypto", absDelta: 10, priceEur: 0 })).toBe(0);
    expect(needsCosmeticConfirm(0)).toBe(false);
  });

  it("stock: EUR-native needs no conversion", () => {
    expect(
      approxDeltaValueEur({
        kind: "stock", absDelta: 2, priceNative: 50, currency: "EUR", fxRates: {},
      }),
    ).toBe(100);
  });

  it("stock: converts native→EUR via fxRates (rates[X] = X per 1 base)", () => {
    // EUR-based rates: 1 EUR = 1.08 USD → $108 ≙ €100.
    expect(
      approxDeltaValueEur({
        kind: "stock", absDelta: 1, priceNative: 108, currency: "USD", fxRates: { USD: 1.08 },
      }),
    ).toBeCloseTo(100);
  });

  it("stock: missing rate falls back 1:1 (built into convertToBase, warns)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      approxDeltaValueEur({
        kind: "stock", absDelta: 1, priceNative: 80, currency: "SEK", fxRates: {},
      }),
    ).toBe(80);
  });

  it("stock: missing price → null", () => {
    expect(
      approxDeltaValueEur({
        kind: "stock", absDelta: 1, priceNative: undefined, currency: "USD", fxRates: {},
      }),
    ).toBeNull();
  });

  it("cash: EUR account is exact", () => {
    expect(
      approxDeltaValueEur({ kind: "cash", absDelta: 250, currency: "EUR", fxRates: undefined }),
    ).toBe(250);
  });

  it("cash: foreign with no rates → 1:1 (over-warns — the safe direction)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      approxDeltaValueEur({ kind: "cash", absDelta: 1000, currency: "SEK", fxRates: undefined }),
    ).toBe(1000);
  });

  it("cash: converts with a provided rate (happy path)", () => {
    // EUR-based rates: 1 EUR = 11 SEK → 1100 SEK ≙ €100.
    expect(
      approxDeltaValueEur({ kind: "cash", absDelta: 1100, currency: "SEK", fxRates: { SEK: 11 } }),
    ).toBeCloseTo(100);
  });
});

describe("needsCosmeticConfirm", () => {
  it("just below the threshold stays quiet", () => {
    expect(needsCosmeticConfirm(COSMETIC_GUARD_THRESHOLD_EUR - 0.01)).toBe(false);
  });

  it("exactly the threshold warns", () => {
    expect(needsCosmeticConfirm(COSMETIC_GUARD_THRESHOLD_EUR)).toBe(true);
  });

  it("well above warns", () => {
    expect(needsCosmeticConfirm(5000)).toBe(true);
  });

  it("unknown value (null) warns — fail-safe", () => {
    expect(needsCosmeticConfirm(null)).toBe(true);
  });

  it("the user-set threshold is €10", () => {
    expect(COSMETIC_GUARD_THRESHOLD_EUR).toBe(10);
  });
});
