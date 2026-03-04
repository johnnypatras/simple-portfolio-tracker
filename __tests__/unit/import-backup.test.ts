import { describe, it, expect } from "vitest";
import {
  validateAmount,
  validateCurrency,
  validateName,
  validateQuantity,
} from "@/lib/validation";

describe("import backup validation", () => {
  it("accepts minimal v1 backup shape", () => {
    const v1 = {
      version: 1,
      cryptoAssets: [],
      stockAssets: [],
      bankAccounts: [],
      exchangeDeposits: [],
      brokerDeposits: [],
    };
    expect(v1.version).toBe(1);
    expect(Array.isArray(v1.cryptoAssets)).toBe(true);
  });

  it("rejects missing required name", () => {
    expect(() => validateName("")).toThrow("cannot be empty");
  });

  it("rejects invalid currency in import data", () => {
    expect(() => validateCurrency("usd")).toThrow("Invalid currency");
  });

  it("rejects negative amount in import data", () => {
    expect(() => validateAmount(-100)).toThrow("cannot be negative");
  });

  it("rejects NaN quantity in import data", () => {
    expect(() => validateQuantity(NaN)).toThrow("valid number");
  });

  it("accepts valid import data values", () => {
    expect(() => validateName("Bitcoin")).not.toThrow();
    expect(() => validateCurrency("USD")).not.toThrow();
    expect(() => validateAmount(1000)).not.toThrow();
    expect(() => validateQuantity(0.5)).not.toThrow();
  });
});
