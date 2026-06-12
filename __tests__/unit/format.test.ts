import { describe, it, expect } from "vitest";
import {
  fmtCurrency,
  formatCurrency,
  fmtCurrencyCompact,
  fmtPct,
  fmtPctPlain,
  changeColorClass,
  changeDisplayParts,
  snapDisplayZero,
  formatNumber,
  formatQuantity,
  formatBackdateChipDate,
  formatDepositNote,
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

  // Task 9 guard: original_currency is server-validated, but a hand-edited DB
  // row must never crash the drawer — Intl.NumberFormat throws RangeError on a
  // malformed ISO code, so fmtCurrency falls back to "<amount> <code>" via
  // formatNumber (thousands grouping preserved on the degraded path).
  it("falls back to '<amount> <code>' on a malformed currency code (too short)", () => {
    expect(fmtCurrency(100, "EU")).toBe("100.00 EU");
  });

  it("keeps thousands grouping in the fallback (>1000, malformed code too long)", () => {
    expect(fmtCurrency(1234.5, "ABCD")).toBe("1,234.50 ABCD");
  });

  it("fallback respects the decimals parameter", () => {
    expect(fmtCurrency(9.12345, "EU", 4)).toBe("9.1235 EU");
  });

  it("still formats a valid non-EUR/USD ISO code via Intl (no fallback)", () => {
    expect(fmtCurrency(850.5, "GBP")).toBe("£850.50");
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

// ── formatBackdateChipDate ─────────────────────────────────
// Locale output varies by runtime, so we assert against the same
// `toLocaleDateString` contract (deriving the expected string from the LOCAL
// formatter) plus the year-omission/inclusion logic and the LOCAL-date parse.
describe("formatBackdateChipDate", () => {
  const NOW = new Date(2026, 5, 15); // 2026-06-15, local

  it("omits the year when the date is in the current year", () => {
    const expected = new Date(2026, 2, 2).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    expect(formatBackdateChipDate("2026-03-02", NOW)).toBe(expected);
    // Year string should NOT appear for a same-year date.
    expect(formatBackdateChipDate("2026-03-02", NOW)).not.toMatch(/2026/);
  });

  it("includes the year when the date is in a different year", () => {
    const expected = new Date(2024, 10, 9).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    expect(formatBackdateChipDate("2024-11-09", NOW)).toBe(expected);
    expect(formatBackdateChipDate("2024-11-09", NOW)).toMatch(/2024/);
  });

  it("parses as a LOCAL date (no UTC-midnight off-by-one)", () => {
    // new Date('2026-03-02') would be UTC midnight → the prior day in negative
    // offsets. The component-split parse renders the 2nd regardless of zone.
    expect(formatBackdateChipDate("2026-03-02", NOW)).toContain("2");
    const day1 = new Date(2026, 2, 1).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    expect(formatBackdateChipDate("2026-03-02", NOW)).not.toBe(day1);
  });

  it("includes the year across the Dec-31 → Jan-1 boundary", () => {
    // One day apart, different calendar years: yesterday's date must carry its
    // year when "now" has just rolled over.
    const jan1 = new Date(2026, 0, 1);
    expect(formatBackdateChipDate("2025-12-31", jan1)).toMatch(/2025/);
    expect(formatBackdateChipDate("2026-01-01", jan1)).not.toMatch(/2026/);
  });

  it("returns the raw input unchanged when it isn't YYYY-MM-DD", () => {
    expect(formatBackdateChipDate("not-a-date", NOW)).toBe("not-a-date");
  });
});

// ── snapDisplayZero ────────────────────────────────────────

describe("snapDisplayZero", () => {
  it("snaps values under half a display unit to exactly +0", () => {
    expect(snapDisplayZero(-0.3, 0)).toBe(0);
    expect(snapDisplayZero(0.49, 0)).toBe(0);
    expect(snapDisplayZero(-0.004, 2)).toBe(0);
    expect(snapDisplayZero(0.0049, 2)).toBe(0);
    expect(snapDisplayZero(-0.04, 1)).toBe(0);
  });

  it("returns +0 (never −0) in the zero case so Intl can't render a sign", () => {
    expect(Object.is(snapDisplayZero(-0.3, 0), -0)).toBe(false);
    expect(Object.is(snapDisplayZero(-0.3, 0), 0)).toBe(true);
  });

  it("passes through values at or above half a display unit", () => {
    expect(snapDisplayZero(-0.5, 0)).toBe(-0.5);
    expect(snapDisplayZero(0.7, 0)).toBe(0.7);
    expect(snapDisplayZero(-0.005, 2)).toBe(-0.005);
    expect(snapDisplayZero(123.45, 2)).toBe(123.45);
  });
});

// ── changeDisplayParts ─────────────────────────────────────

describe("changeDisplayParts", () => {
  it("renders a normal positive change with signs and emerald color", () => {
    const d = changeDisplayParts(342.39, 1.9, "EUR", { compact: true });
    expect(d.value).toBe("+€342");
    expect(d.pct).toBe("+1.9%");
    expect(d.colorClass).toBe("text-emerald-400");
    expect(d.isDisplayZero).toBe(false);
  });

  it("renders a normal negative change with red color", () => {
    const d = changeDisplayParts(-298.5, -1.5, "EUR", { compact: true });
    expect(d.value).toBe("-€299");
    expect(d.pct).toBe("-1.5%");
    expect(d.colorClass).toBe("text-red-400");
  });

  it("THE FINDING: a −€0.30 / −0.04% change renders unsigned, zinc, display-zero", () => {
    const d = changeDisplayParts(-0.3, -0.04, "EUR", { compact: true });
    expect(d.value).toBe("€0");
    expect(d.pct).toBe("0.0%");
    expect(d.colorClass).toBe("text-zinc-400");
    expect(d.isDisplayZero).toBe(true);
  });

  it("never emits '−€0' or '−0.0%' for any sub-half-unit negative", () => {
    for (const v of [-0.49, -0.25, -0.01]) {
      const d = changeDisplayParts(v, v / 10, "EUR", { compact: true });
      expect(d.value).not.toMatch(/-€0\b/);
      expect(d.pct).not.toMatch(/-0\.0%/);
    }
  });

  it("micro-position: value display-zero but percent real keeps the percent's direction", () => {
    // −€0.40 on a €8 position = −5%: the pct carries the signal, color follows it
    const d = changeDisplayParts(-0.4, -5, "EUR", { compact: true });
    expect(d.value).toBe("€0");
    expect(d.pct).toBe("-5.0%");
    expect(d.colorClass).toBe("text-red-400");
    expect(d.isDisplayZero).toBe(false);
  });

  it("exact zero renders unsigned '0.0%' (no leading '+')", () => {
    const d = changeDisplayParts(0, 0, "EUR", { compact: true });
    expect(d.pct).toBe("0.0%");
    expect(d.isDisplayZero).toBe(true);
    expect(d.colorClass).toBe("text-zinc-400");
  });

  it("default (detail-panel) mode renders 2-decimal currency", () => {
    const d = changeDisplayParts(-12.345, -0.7, "EUR");
    expect(d.value).toBe("-€12.35");
    expect(d.pct).toBe("-0.7%");
    expect(d.colorClass).toBe("text-red-400");
  });

  it("2-decimal mode: a −€0.004 residue snaps to unsigned €0.00", () => {
    const d = changeDisplayParts(-0.004, -0.01, "EUR");
    expect(d.value).toBe("€0.00");
    expect(d.pct).toBe("0.0%");
    expect(d.isDisplayZero).toBe(true);
  });

  it("USD currency flows through", () => {
    const d = changeDisplayParts(50, 2.1, "USD", { compact: true });
    expect(d.value).toBe("+$50");
  });

  it("non-finite percent degrades to the em-dash via fmtPct", () => {
    const d = changeDisplayParts(100, Number.POSITIVE_INFINITY, "EUR", { compact: true });
    expect(d.pct).toBe("—");
    expect(d.isDisplayZero).toBe(false);
  });
});

// ── formatDepositNote ──────────────────────────────────────

describe("formatDepositNote (Group C #2)", () => {
  it("labels a positive total as deposited (full number under €1M)", () => {
    expect(formatDepositNote(10000, "EUR")).toBe("€10,000 deposited");
  });
  it("labels a negative total as withdrawn (magnitude only)", () => {
    expect(formatDepositNote(-5000, "EUR")).toBe("€5,000 withdrawn");
  });
  it("returns null when the total rounds to zero at display precision", () => {
    expect(formatDepositNote(0, "EUR")).toBeNull();
    expect(formatDepositNote(0.3, "EUR")).toBeNull();
    expect(formatDepositNote(-0.4, "EUR")).toBeNull();
  });
  it("abbreviates seven-figure flows like the change value does", () => {
    expect(formatDepositNote(1_500_000, "USD")).toBe("$1.5M deposited");
  });
  it("returns null for non-finite input (matches the file's fmtPct convention)", () => {
    expect(formatDepositNote(NaN, "EUR")).toBeNull();
    expect(formatDepositNote(Infinity, "EUR")).toBeNull();
    expect(formatDepositNote(-Infinity, "EUR")).toBeNull();
  });
  it("does NOT suppress a flow that rounds to one display unit (€0.50 → €1)", () => {
    expect(formatDepositNote(0.5, "EUR")).toBe("€1 deposited");
  });
});
