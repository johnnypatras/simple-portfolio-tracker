import { describe, it, expect } from "vitest";
import {
  validateAmount,
  validateQuantity,
  validateCurrency,
  validateName,
  validateUUID,
  validateCoinGeckoId,
  validateYahooTicker,
  validateDate,
  validatePastOrTodayDate,
  validateApy,
  validateIsin,
  validateImageUrl,
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
    expect(() => validateQuantity(-5)).toThrow("must not be negative");
  });

  it("rejects NaN", () => {
    expect(() => validateQuantity(NaN)).toThrow("valid number");
  });

  it("rejects Infinity", () => {
    expect(() => validateQuantity(Infinity)).toThrow("valid number");
  });

  it("accepts zero (used for position removal)", () => {
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

describe("validateCoinGeckoId", () => {
  it("accepts simple id", () => {
    expect(() => validateCoinGeckoId("bitcoin")).not.toThrow();
  });

  it("accepts hyphenated id", () => {
    expect(() => validateCoinGeckoId("usd-coin")).not.toThrow();
  });

  it("accepts id starting with digit", () => {
    expect(() => validateCoinGeckoId("0x-protocol")).not.toThrow();
  });

  it("accepts single character", () => {
    expect(() => validateCoinGeckoId("a")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateCoinGeckoId("")).toThrow();
  });

  it("rejects path traversal", () => {
    expect(() => validateCoinGeckoId("../../../etc")).toThrow();
  });

  it("rejects leading hyphen", () => {
    expect(() => validateCoinGeckoId("-bitcoin")).toThrow();
  });

  it("rejects uppercase", () => {
    expect(() => validateCoinGeckoId("BITCOIN")).toThrow();
  });

  it("rejects space", () => {
    expect(() => validateCoinGeckoId("bit coin")).toThrow();
  });

  it("rejects URL injection", () => {
    expect(() => validateCoinGeckoId("bitcoin&vs_currencies=jpy")).toThrow();
  });
});

describe("validateYahooTicker", () => {
  it("accepts simple ticker", () => {
    expect(() => validateYahooTicker("AAPL")).not.toThrow();
  });

  it("accepts ticker with dot (exchange suffix)", () => {
    expect(() => validateYahooTicker("VWCE.DE")).not.toThrow();
  });

  it("rejects caret prefix (first char must be alphanumeric)", () => {
    expect(() => validateYahooTicker("^GSPC")).toThrow();
  });

  it("accepts hyphenated ticker", () => {
    expect(() => validateYahooTicker("BRK-B")).not.toThrow();
  });

  it("accepts FX ticker with equals", () => {
    expect(() => validateYahooTicker("EURUSD=X")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateYahooTicker("")).toThrow();
  });

  it("rejects lowercase", () => {
    expect(() => validateYahooTicker("aapl")).toThrow();
  });

  it("rejects too long (>20 chars)", () => {
    expect(() => validateYahooTicker("A".repeat(21))).toThrow();
  });

  it("rejects newline", () => {
    expect(() => validateYahooTicker("TICK\n")).toThrow();
  });

  it("rejects URL injection", () => {
    expect(() => validateYahooTicker("AAPL&foo=bar")).toThrow();
  });
});

describe("validateApy", () => {
  it("accepts 0 (no yield)", () => {
    expect(() => validateApy(0)).not.toThrow();
  });

  it("accepts 50 (mid-range)", () => {
    expect(() => validateApy(50)).not.toThrow();
  });

  it("accepts 100 (maximum)", () => {
    expect(() => validateApy(100)).not.toThrow();
  });

  it("rejects NaN", () => {
    expect(() => validateApy(NaN)).toThrow("valid number");
  });

  it("rejects Infinity", () => {
    expect(() => validateApy(Infinity)).toThrow("valid number");
  });

  it("rejects -Infinity", () => {
    expect(() => validateApy(-Infinity)).toThrow("valid number");
  });

  it("rejects negative APY", () => {
    expect(() => validateApy(-1)).toThrow("between 0 and 100");
  });

  it("rejects APY above 100", () => {
    expect(() => validateApy(100.1)).toThrow("between 0 and 100");
  });

  it("uses custom label in error message", () => {
    expect(() => validateApy(-1, "Staking yield")).toThrow("Staking yield must be between 0 and 100");
  });
});

describe("validateIsin", () => {
  it("accepts a valid ISIN", () => {
    expect(validateIsin("US0378331005")).toBe("US0378331005");
  });

  it("uppercases and accepts a lowercase ISIN", () => {
    expect(validateIsin("us0378331005")).toBe("US0378331005");
  });

  it("returns null for null input", () => {
    expect(validateIsin(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(validateIsin(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(validateIsin("")).toBeNull();
  });

  it("rejects a string that is too short", () => {
    expect(() => validateIsin("short")).toThrow("ISIN must be 12");
  });

  it("rejects a 12-digit numeric string (no country code)", () => {
    expect(() => validateIsin("123456789012")).toThrow("ISIN must be 12");
  });
});

describe("validateImageUrl", () => {
  it("accepts a valid assets.coingecko.com URL", () => {
    const url = "https://assets.coingecko.com/coins/images/1/thumb/bitcoin.png";
    expect(validateImageUrl(url)).toBe(url);
  });

  it("accepts a valid coin-images.coingecko.com URL", () => {
    const url = "https://coin-images.coingecko.com/coins/images/1/small/bitcoin.png";
    expect(validateImageUrl(url)).toBe(url);
  });

  it("returns null for a non-CoinGecko URL", () => {
    expect(validateImageUrl("https://example.com/image.png")).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(validateImageUrl("not-a-url")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(validateImageUrl(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(validateImageUrl(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(validateImageUrl("")).toBeNull();
  });

  it("rejects subdomain spoofing of coingecko origins", () => {
    // If origin check used `url.href.startsWith("https://assets.coingecko.com")`
    // this URL would pass because the string prefix matches. The fix compares
    // `url.origin` (hostname-aware) instead.
    expect(validateImageUrl("https://assets.coingecko.com.evil.com/image.png")).toBeNull();
    expect(validateImageUrl("https://evil.com/assets.coingecko.com/image.png")).toBeNull();
  });

  it("rejects non-https protocols (javascript:, data:, http:)", () => {
    expect(validateImageUrl("javascript:alert(1)")).toBeNull();
    expect(validateImageUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(validateImageUrl("http://assets.coingecko.com/image.png")).toBeNull();
  });

  it("accepts coingecko URLs with query strings and fragments", () => {
    // Supabase returns CG URLs with ?v=cache-buster query strings
    const url = "https://assets.coingecko.com/coins/images/1/thumb/bitcoin.png?v=1234";
    expect(validateImageUrl(url)).toBe(url);
  });
});

describe("validateDate", () => {
  it("accepts valid YYYY-MM-DD date", () => {
    expect(() => validateDate("2026-03-21")).not.toThrow();
  });

  it("rejects missing leading zero in month", () => {
    expect(() => validateDate("2026-3-21")).toThrow("must be YYYY-MM-DD format");
  });

  it("rejects wrong format (DD/MM/YYYY)", () => {
    expect(() => validateDate("21/03/2026")).toThrow("must be YYYY-MM-DD format");
  });

  it("rejects empty string", () => {
    expect(() => validateDate("")).toThrow("must be YYYY-MM-DD format");
  });

  it("rejects non-date string", () => {
    expect(() => validateDate("not-a-date")).toThrow("must be YYYY-MM-DD format");
  });

  it("uses custom label in error message", () => {
    expect(() => validateDate("bad", "Effective date")).toThrow(
      "Effective date must be YYYY-MM-DD format",
    );
  });

  it("rejects SQL injection attempt", () => {
    expect(() => validateDate("2026-01-01' OR '1'='1")).toThrow(
      "must be YYYY-MM-DD format",
    );
  });

  // Calendar round-trip rejections — regex matches these but the
  // Date.UTC + getUTCFullYear/Month/Date round-trip catches the rollover.
  it("rejects invalid calendar date 2026-02-30", () => {
    expect(() => validateDate("2026-02-30")).toThrow("not a valid calendar date");
  });

  it("rejects invalid calendar date 2026-13-01 (month=13)", () => {
    expect(() => validateDate("2026-13-01")).toThrow("not a valid calendar date");
  });

  it("rejects invalid calendar date 2026-13-99 (both month and day invalid)", () => {
    expect(() => validateDate("2026-13-99")).toThrow("not a valid calendar date");
  });

  it("rejects non-leap-year Feb 29 (2025-02-29)", () => {
    expect(() => validateDate("2025-02-29")).toThrow("not a valid calendar date");
  });

  it("accepts leap-year Feb 29 (2024-02-29)", () => {
    expect(() => validateDate("2024-02-29")).not.toThrow();
  });
});

describe("validatePastOrTodayDate", () => {
  // System time is intentionally NOT mocked in this file — tests use dates
  // relative to "now" via Date offsets to stay deterministic across runs.

  it("accepts today's date", () => {
    const today = new Date().toISOString().split("T")[0];
    expect(() => validatePastOrTodayDate(today)).not.toThrow();
  });

  it("accepts a date one day in the past", () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    const yesterday = d.toISOString().split("T")[0];
    expect(() => validatePastOrTodayDate(yesterday)).not.toThrow();
  });

  it("rejects a date one day in the future", () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    const tomorrow = d.toISOString().split("T")[0];
    expect(() => validatePastOrTodayDate(tomorrow)).toThrow("cannot be in the future");
  });

  it("rejects a far-future date (typo scenario: 2099 meant 2029)", () => {
    expect(() => validatePastOrTodayDate("2099-01-15")).toThrow("cannot be in the future");
  });

  it("inherits validateDate's calendar round-trip check (rejects 2026-02-30)", () => {
    expect(() => validatePastOrTodayDate("2026-02-30")).toThrow("not a valid calendar date");
  });

  it("inherits validateDate's format check (rejects DD/MM/YYYY)", () => {
    expect(() => validatePastOrTodayDate("21/03/2026")).toThrow("must be YYYY-MM-DD format");
  });

  it("uses custom label in future-date error message", () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 30);
    const future = d.toISOString().split("T")[0];
    expect(() => validatePastOrTodayDate(future, "NAV effective date")).toThrow(
      "NAV effective date cannot be in the future",
    );
  });
});
