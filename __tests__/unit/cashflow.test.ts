import { describe, it, expect, vi } from "vitest";
import {
  computeCashflowFromPrices,
  classifyAssetClass,
} from "@/lib/cashflow";

describe("computeCashflowFromPrices", () => {
  it("crypto buy — positive cashflow (money entered portfolio)", () => {
    const result = computeCashflowFromPrices({
      action: "created",
      beforeQty: 0,
      afterQty: 0.5,
      priceUsd: 100000,
      priceEur: 92000,
    });
    expect(result).toEqual({ usd: 50000, eur: 46000 });
  });

  it("crypto sell — negative cashflow (money left portfolio)", () => {
    const result = computeCashflowFromPrices({
      action: "removed",
      beforeQty: 0.5,
      afterQty: 0,
      priceUsd: 100000,
      priceEur: 92000,
    });
    expect(result).toEqual({ usd: -50000, eur: -46000 });
  });

  it("crypto update — difference in qty × price", () => {
    const result = computeCashflowFromPrices({
      action: "updated",
      beforeQty: 0.3,
      afterQty: 0.5,
      priceUsd: 100000,
      priceEur: 92000,
    });
    expect(result).toEqual({ usd: 20000, eur: 18400 });
  });

  it("cash entity EUR — uses fxRate for conversion", () => {
    const result = computeCashflowFromPrices({
      action: "created",
      beforeQty: 0,
      afterQty: 1000,
      entityCurrency: "EUR",
      fxRate: 1.08,
    });
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.usd).toBeCloseTo(1080);
    expect(r.eur).toBe(1000);
  });

  it("cash entity USD — uses fxRate for EUR conversion", () => {
    const result = computeCashflowFromPrices({
      action: "created",
      beforeQty: 0,
      afterQty: 1000,
      entityCurrency: "USD",
      fxRate: 1.08,
    });
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.usd).toBe(1000);
    expect(r.eur).toBeCloseTo(925.93, 1);
  });

  it("zero qty change — returns zero", () => {
    const result = computeCashflowFromPrices({
      action: "updated",
      beforeQty: 5,
      afterQty: 5,
      priceUsd: 100,
      priceEur: 92,
    });
    expect(result).toEqual({ usd: 0, eur: 0 });
  });

  it("unsupported currency (GBP) — returns null", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = computeCashflowFromPrices({
      action: "created",
      beforeQty: 0,
      afterQty: 1000,
      entityCurrency: "GBP",
      fxRate: 1.08,
    });
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unsupported currency "GBP"'),
    );
    warnSpy.mockRestore();
  });

  it("zero fxRate with USD entity — guards against Infinity", () => {
    // Source: fxRate > 0 check on line 54 of cashflow.ts
    // When fxRate is 0, the guard makes it fall back to `delta` (raw USD amount)
    const result = computeCashflowFromPrices({
      action: "created",
      beforeQty: 0,
      afterQty: 1000,
      entityCurrency: "USD",
      fxRate: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.usd).toBe(1000);
    // fxRate 0 → guard triggers → eur = delta (1000) instead of Infinity
    expect(result!.eur).toBe(1000);
    expect(Number.isFinite(result!.eur)).toBe(true);
  });

  it("undefined fxRate — falls back to 1", () => {
    // Source: `const fxRate = params.fxRate ?? 1;` on line 47
    const resultEur = computeCashflowFromPrices({
      action: "created",
      beforeQty: 0,
      afterQty: 1000,
      entityCurrency: "EUR",
      fxRate: undefined,
    });
    // EUR mode with fxRate=1: usd = delta * 1 = 1000, eur = delta = 1000
    expect(resultEur).toEqual({ usd: 1000, eur: 1000 });

    const resultUsd = computeCashflowFromPrices({
      action: "created",
      beforeQty: 0,
      afterQty: 1000,
      entityCurrency: "USD",
      fxRate: undefined,
    });
    // USD mode with fxRate=1 (> 0 so division path): usd = 1000, eur = 1000 / 1 = 1000
    expect(resultUsd).toEqual({ usd: 1000, eur: 1000 });
  });
});

describe("classifyAssetClass", () => {
  it("crypto_position → crypto", () => {
    expect(classifyAssetClass("crypto_position")).toBe("crypto");
  });

  it("crypto_position with stablecoin → cash", () => {
    expect(classifyAssetClass("crypto_position", true)).toBe("cash");
  });

  it("stock_position → stocks", () => {
    expect(classifyAssetClass("stock_position")).toBe("stocks");
  });

  it("bank_account → cash", () => {
    expect(classifyAssetClass("bank_account")).toBe("cash");
  });

  it("exchange_deposit → cash", () => {
    expect(classifyAssetClass("exchange_deposit")).toBe("cash");
  });

  it("broker_deposit → cash", () => {
    expect(classifyAssetClass("broker_deposit")).toBe("cash");
  });

  it("cash_account → cash", () => {
    expect(classifyAssetClass("cash_account")).toBe("cash");
  });

  it("crypto_asset → null (no cashflow)", () => {
    expect(classifyAssetClass("crypto_asset")).toBeNull();
  });

  it("wallet → null", () => {
    expect(classifyAssetClass("wallet")).toBeNull();
  });
});
