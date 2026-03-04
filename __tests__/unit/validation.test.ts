import { describe, it, expect } from "vitest";
import {
  validateAmount,
  validateQuantity,
  validateCurrency,
  validateName,
  validateUUID,
} from "@/lib/validation";

describe("validateAmount", () => {
  it("accepts positive numbers", () => {
    expect(() => validateAmount(100)).not.toThrow();
    expect(() => validateAmount(0)).not.toThrow();
    expect(() => validateAmount(0.01)).not.toThrow();
  });

  it("rejects negative numbers", () => {
    expect(() => validateAmount(-1)).toThrow("cannot be negative");
  });

  it("rejects NaN", () => {
    expect(() => validateAmount(NaN)).toThrow("valid number");
  });

  it("rejects Infinity", () => {
    expect(() => validateAmount(Infinity)).toThrow("valid number");
  });

  it("rejects unreasonably large amounts", () => {
    expect(() => validateAmount(2_000_000_000)).toThrow("unreasonably large");
  });
});

describe("validateQuantity", () => {
  it("accepts positive numbers", () => {
    expect(() => validateQuantity(0.000001)).not.toThrow();
  });

  it("rejects negative", () => {
    expect(() => validateQuantity(-5)).toThrow("cannot be negative");
  });

  it("rejects NaN", () => {
    expect(() => validateQuantity(NaN)).toThrow("valid number");
  });
});

describe("validateCurrency", () => {
  it("accepts valid ISO 4217 codes", () => {
    expect(() => validateCurrency("USD")).not.toThrow();
    expect(() => validateCurrency("EUR")).not.toThrow();
    expect(() => validateCurrency("GBP")).not.toThrow();
  });

  it("rejects lowercase", () => {
    expect(() => validateCurrency("usd")).toThrow("Invalid currency");
  });

  it("rejects too short", () => {
    expect(() => validateCurrency("US")).toThrow("Invalid currency");
  });

  it("rejects too long", () => {
    expect(() => validateCurrency("USDD")).toThrow("Invalid currency");
  });

  it("rejects empty", () => {
    expect(() => validateCurrency("")).toThrow("Invalid currency");
  });
});

describe("validateName", () => {
  it("accepts normal strings", () => {
    expect(() => validateName("My Portfolio")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateName("")).toThrow("cannot be empty");
  });

  it("rejects whitespace-only", () => {
    expect(() => validateName("   ")).toThrow("cannot be empty");
  });

  it("rejects strings exceeding maxLen", () => {
    expect(() => validateName("a".repeat(101))).toThrow("too long");
  });

  it("respects custom maxLen", () => {
    expect(() => validateName("abcdef", 5)).toThrow("too long");
  });
});

describe("validateUUID", () => {
  it("accepts valid UUID", () => {
    expect(() =>
      validateUUID("550e8400-e29b-41d4-a716-446655440000")
    ).not.toThrow();
  });

  it("rejects invalid format", () => {
    expect(() => validateUUID("not-a-uuid")).toThrow("not a valid UUID");
  });

  it("rejects empty", () => {
    expect(() => validateUUID("")).toThrow("not a valid UUID");
  });
});
