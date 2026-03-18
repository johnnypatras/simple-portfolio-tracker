import { describe, it, expect } from "vitest";
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
    expect(result.usd).toBeCloseTo(1080);
    expect(result.eur).toBe(1000);
  });

  it("cash entity USD — uses fxRate for EUR conversion", () => {
    const result = computeCashflowFromPrices({
      action: "created",
      beforeQty: 0,
      afterQty: 1000,
      entityCurrency: "USD",
      fxRate: 1.08,
    });
    expect(result.usd).toBe(1000);
    expect(result.eur).toBeCloseTo(925.93, 1);
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
