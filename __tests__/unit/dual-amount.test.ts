import { describe, it, expect } from "vitest";
import { deriveDualAmount } from "@/lib/dual-amount";

/**
 * THE VERBATIM-LEG RULE — shared by all 6 cost boundaries (addTransaction,
 * editTransaction, crypto upsertPosition, upsertStockPosition, split per-leg
 * costs, transfer conversion cost). The per-site behavior is pinned by
 * cost-currency-validation.test.ts + the transfer integration tests; this
 * pins the extracted helper itself.
 */
describe("deriveDualAmount", () => {
  it("EUR-typed: eur leg is the typed amount BYTE-EXACT, usd derived + round2'd", () => {
    const out = deriveDualAmount(100.123456, "EUR", { usd: 108.5678901, eur: 100.123456 });
    expect(out.eur).toBe(100.123456); // verbatim — all decimals preserved
    expect(out.usd).toBe(108.57); // derived sibling round2'd
  });

  it("USD-typed: usd leg is the typed amount BYTE-EXACT, eur derived + round2'd", () => {
    const out = deriveDualAmount(250.987654, "USD", { usd: 250.987654, eur: 231.2345678 });
    expect(out.usd).toBe(250.987654); // verbatim — all decimals preserved
    expect(out.eur).toBe(231.23); // derived sibling round2'd
  });

  it("any other ISO (GBP): BOTH legs derived + round2'd — no verbatim leg", () => {
    const out = deriveDualAmount(100, "GBP", { usd: 127.456789, eur: 117.128901 });
    expect(out).toEqual({ usd: 127.46, eur: 117.13 });
  });

  it("rounding is round2 (half-up to 2 dp), applied ONLY to derived legs", () => {
    // Derived legs snap float dust to clean money…
    expect(deriveDualAmount(10, "GBP", { usd: 12.005, eur: 11.994999999 })).toEqual({
      usd: 12.01,
      eur: 11.99,
    });
    // …while a typed EUR leg with >2dp passes through untouched.
    expect(deriveDualAmount(200.555, "EUR", { usd: 220.6105, eur: 200.555 }).eur).toBe(200.555);
  });
});
