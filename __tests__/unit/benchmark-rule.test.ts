import { describe, it, expect } from "vitest";
import { countsInBenchmark, SEED_BALANCE_DEFAULT_IS_ADJUSTMENT } from "@/lib/benchmark-rule";

describe("countsInBenchmark — the S&P rule (Law 1)", () => {
  it("FLOW / TRACK (not an adjustment) counts in the benchmark", () => {
    expect(countsInBenchmark({ is_adjustment: false })).toBe(true);
    expect(countsInBenchmark({})).toBe(true);
    expect(countsInBenchmark({ is_adjustment: null })).toBe(true);
    expect(countsInBenchmark({ is_adjustment: undefined })).toBe(true);
  });
  it("CORRECT / MOVE-leg (an adjustment) is off-book", () => {
    expect(countsInBenchmark({ is_adjustment: true })).toBe(false);
  });
});

describe("SEED_BALANCE_DEFAULT_IS_ADJUSTMENT", () => {
  it("defaults a seeded opening balance to COUNT (money entering counts)", () => {
    expect(SEED_BALANCE_DEFAULT_IS_ADJUSTMENT).toBe(false);
  });
});
