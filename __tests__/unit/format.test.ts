import { describe, it, expect } from "vitest";
import {
  fmtCurrency,
  formatCurrency,
  fmtCurrencyCompact,
  fmtPct,
  fmtPctPlain,
  changeColorClass,
  formatNumber,
  formatQuantity,
} from "@/lib/format";

// ── fmtCurrency ────────────────────────────────────────────

describe("fmtCurrency", () => {
  it("formats USD with 2 decimal places by default", () => {
    expect(fmtCurrency(1234.56, "USD")).toBe("$1,234.56");
  });

  it("formats EUR with € symbol", () => {
    expect(fmtCurrency(1000, "EUR")).toBe("€1,000.00");
  });

  it("respects custom decimal places", () => {
    expect(fmtCurrency(9.12345, "USD", 4)).toBe("$9.1235");
  });

  it("formats zero", () => {
    expect(fmtCurrency(0, "USD")).toBe("$0.00");
  });

  it("formats negative values", () => {
    expect(fmtCurrency(-500.5, "EUR")).toBe("-€500.50");
  });

  it("formats with 0 decimals", () => {
    expect(fmtCurrency(1234.99, "USD", 0)).toBe("$1,235");
  });

  it("is aliased as formatCurrency", () => {
    expect(formatCurrency).toBe(fmtCurrency);
  });
});

// ── fmtCurrencyCompact ─────────────────────────────────────

describe("fmtCurrencyCompact", () => {
  it("uses compact notation for millions", () => {
    const result = fmtCurrencyCompact(1_500_000, "USD");
    expect(result).toMatch(/\$1\.5M/);
  });

  it("uses compact notation for negative millions", () => {
    const result = fmtCurrencyCompact(-2_300_000, "EUR");
    expect(result).toMatch(/-€2\.3M/);
  });

  it("falls back to standard for sub-million values", () => {
    expect(fmtCurrencyCompact(12345, "USD")).toBe("$12,345");
  });

  it("respects custom decimals for sub-million values", () => {
    expect(fmtCurrencyCompact(999.99, "EUR", 2)).toBe("€999.99");
  });

  it("defaults to 0 decimal places for sub-million", () => {
    expect(fmtCurrencyCompact(1234.56, "USD")).toBe("$1,235");
  });
});

// ── fmtPct ─────────────────────────────────────────────────

describe("fmtPct", () => {
  it("prefixes positive values with +", () => {
    expect(fmtPct(2.45)).toBe("+2.5%");
  });

  it("shows negative sign for negative values", () => {
    expect(fmtPct(-1.3)).toBe("-1.3%");
  });

  it("formats zero as +0.0%", () => {
    expect(fmtPct(0)).toBe("+0.0%");
  });

  it("respects custom decimal places", () => {
    expect(fmtPct(3.456, 2)).toBe("+3.46%");
  });

  it("returns dash for Infinity", () => {
    expect(fmtPct(Infinity)).toBe("—");
  });

  it("returns dash for NaN", () => {
    expect(fmtPct(NaN)).toBe("—");
  });

  it("returns dash for negative Infinity", () => {
    expect(fmtPct(-Infinity)).toBe("—");
  });
});

// ── fmtPctPlain ────────────────────────────────────────────

describe("fmtPctPlain", () => {
  it("formats without sign prefix", () => {
    expect(fmtPctPlain(45.6)).toBe("46%");
  });

  it("shows negative sign", () => {
    expect(fmtPctPlain(-3.2, 1)).toBe("-3.2%");
  });

  it("respects custom decimal places", () => {
    expect(fmtPctPlain(99.555, 2)).toBe("99.56%");
  });

  it("defaults to 0 decimal places", () => {
    expect(fmtPctPlain(7.8)).toBe("8%");
  });

  it("returns dash for non-finite values", () => {
    expect(fmtPctPlain(NaN)).toBe("—");
    expect(fmtPctPlain(Infinity)).toBe("—");
  });
});

// ── changeColorClass ───────────────────────────────────────

describe("changeColorClass", () => {
  it("returns emerald for positive", () => {
    expect(changeColorClass(1)).toBe("text-emerald-400");
  });

  it("returns red for negative", () => {
    expect(changeColorClass(-0.01)).toBe("text-red-400");
  });

  it("returns zinc for zero", () => {
    expect(changeColorClass(0)).toBe("text-zinc-400");
  });
});

// ── formatNumber ───────────────────────────────────────────

describe("formatNumber", () => {
  it("formats with 2 decimal places by default", () => {
    expect(formatNumber(1234.5)).toBe("1,234.50");
  });

  it("respects custom decimal places", () => {
    expect(formatNumber(3.14159, 4)).toBe("3.1416");
  });

  it("adds thousands separators", () => {
    expect(formatNumber(1000000, 0)).toBe("1,000,000");
  });

  it("formats zero", () => {
    expect(formatNumber(0)).toBe("0.00");
  });

  it("formats negative numbers", () => {
    expect(formatNumber(-42.1, 1)).toBe("-42.1");
  });
});

// ── formatQuantity ─────────────────────────────────────────

describe("formatQuantity", () => {
  it("formats with minimum 2 and up to maxDecimals", () => {
    expect(formatQuantity(1.5, 6)).toBe("1.50");
  });

  it("preserves significant decimals up to max", () => {
    expect(formatQuantity(0.123456, 6)).toBe("0.123456");
  });

  it("truncates beyond maxDecimals", () => {
    expect(formatQuantity(0.1234567, 6)).toBe("0.123457");
  });

  it("always shows at least 2 decimal places", () => {
    expect(formatQuantity(100, 6)).toBe("100.00");
  });

  it("adds thousands separators", () => {
    // maximumFractionDigits=4 doesn't pad beyond actual precision
    expect(formatQuantity(12345.678, 4)).toBe("12,345.678");
  });
});
