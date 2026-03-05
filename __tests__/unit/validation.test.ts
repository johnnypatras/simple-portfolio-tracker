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

  it("rejects -Infinity", () => {
    expect(() => validateAmount(-Infinity)).toThrow("valid number");
  });

  it("rejects unreasonably large amounts", () => {
    expect(() => validateAmount(2_000_000_000)).toThrow("unreasonably large");
  });

  // Boundary: exactly at the 1B threshold
  it("accepts exactly 1 billion (threshold)", () => {
    expect(() => validateAmount(1_000_000_000)).not.toThrow();
  });

  it("rejects just above 1 billion", () => {
    expect(() => validateAmount(1_000_000_001)).toThrow("unreasonably large");
  });

  it("accepts exactly zero", () => {
    expect(() => validateAmount(0)).not.toThrow();
  });

  it("uses custom label in error message", () => {
    expect(() => validateAmount(-1, "Balance")).toThrow("Balance cannot be negative");
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

  it("rejects Infinity", () => {
    expect(() => validateQuantity(Infinity)).toThrow("valid number");
  });

  it("accepts zero", () => {
    expect(() => validateQuantity(0)).not.toThrow();
  });

  it("rejects unreasonably large quantities", () => {
    expect(() => validateQuantity(1_000_000_001)).toThrow("unreasonably large");
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

  it("rejects mixed case", () => {
    expect(() => validateCurrency("Usd")).toThrow("Invalid currency");
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

  it("rejects numeric strings", () => {
    expect(() => validateCurrency("123")).toThrow("Invalid currency");
  });

  it("rejects special characters", () => {
    expect(() => validateCurrency("U$D")).toThrow("Invalid currency");
  });

  // SQL injection attempt
  it("rejects SQL injection payload", () => {
    expect(() => validateCurrency("'; DROP TABLE--")).toThrow("Invalid currency");
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

  it("accepts exactly at maxLen", () => {
    expect(() => validateName("a".repeat(100))).not.toThrow();
  });

  it("respects custom maxLen", () => {
    expect(() => validateName("abcdef", 5)).toThrow("too long");
  });

  it("accepts at custom maxLen boundary", () => {
    expect(() => validateName("abcde", 5)).not.toThrow();
  });

  // Security: SQL injection
  it("accepts SQL injection payload (defense is parameterized queries)", () => {
    expect(() => validateName("'; DROP TABLE users; --")).not.toThrow();
  });

  // Security: XSS
  it("accepts XSS payload (defense is React escaping)", () => {
    expect(() => validateName('<script>alert("xss")</script>')).not.toThrow();
  });

  // Unicode
  it("accepts Unicode characters", () => {
    expect(() => validateName("Ελληνικά 🏦")).not.toThrow();
  });

  it("trims before length check", () => {
    // 100 chars + surrounding spaces should pass (trimmed = 100)
    expect(() => validateName("  " + "a".repeat(100) + "  ")).not.toThrow();
  });

  it("uses custom label in error message", () => {
    expect(() => validateName("", 100, "Ticker")).toThrow("Ticker cannot be empty");
  });
});

describe("validateUUID", () => {
  it("accepts valid UUID v4", () => {
    expect(() =>
      validateUUID("550e8400-e29b-41d4-a716-446655440000")
    ).not.toThrow();
  });

  it("accepts uppercase UUID", () => {
    expect(() =>
      validateUUID("550E8400-E29B-41D4-A716-446655440000")
    ).not.toThrow();
  });

  it("rejects invalid format", () => {
    expect(() => validateUUID("not-a-uuid")).toThrow("not a valid UUID");
  });

  it("rejects empty", () => {
    expect(() => validateUUID("")).toThrow("not a valid UUID");
  });

  it("rejects UUID with extra characters", () => {
    expect(() =>
      validateUUID("550e8400-e29b-41d4-a716-446655440000-extra")
    ).toThrow("not a valid UUID");
  });

  // Security: SQL injection in UUID field
  it("rejects SQL injection payload", () => {
    expect(() =>
      validateUUID("'; DROP TABLE users; --")
    ).toThrow("not a valid UUID");
  });

  it("rejects UUID-like string with wrong length segment", () => {
    expect(() =>
      validateUUID("550e840-e29b-41d4-a716-446655440000")
    ).toThrow("not a valid UUID");
  });

  it("uses custom label in error message", () => {
    expect(() => validateUUID("bad", "Asset ID")).toThrow("Asset ID is not a valid UUID");
  });

  // Nil UUID (all zeros) — valid format
  it("accepts nil UUID", () => {
    expect(() =>
      validateUUID("00000000-0000-0000-0000-000000000000")
    ).not.toThrow();
  });
});
