import { describe, it, expect } from "vitest";
import { normalizeCategory } from "@/lib/stock-categories";

describe("normalizeCategory", () => {
  it("maps legacy 'stock' to 'individual_stock'", () => {
    expect(normalizeCategory("stock")).toBe("individual_stock");
  });

  it("maps legacy 'etf_ucits' to 'etf'", () => {
    expect(normalizeCategory("etf_ucits")).toBe("etf");
  });

  it("maps legacy 'etf_non_ucits' to 'etf'", () => {
    expect(normalizeCategory("etf_non_ucits")).toBe("etf");
  });

  it("maps legacy 'bond' to 'bond_fixed_income'", () => {
    expect(normalizeCategory("bond")).toBe("bond_fixed_income");
  });

  it("passes through current valid categories unchanged", () => {
    expect(normalizeCategory("individual_stock")).toBe("individual_stock");
    expect(normalizeCategory("etf")).toBe("etf");
    expect(normalizeCategory("bond_fixed_income")).toBe("bond_fixed_income");
    expect(normalizeCategory("other")).toBe("other");
  });

  it("defaults null to 'individual_stock'", () => {
    expect(normalizeCategory(null)).toBe("individual_stock");
  });

  it("defaults undefined to 'individual_stock'", () => {
    expect(normalizeCategory(undefined)).toBe("individual_stock");
  });

  it("defaults empty string to 'individual_stock'", () => {
    expect(normalizeCategory("")).toBe("individual_stock");
  });
});
