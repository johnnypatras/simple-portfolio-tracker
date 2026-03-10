import { describe, it, expect } from "vitest";
import { enrichChartData } from "@/lib/portfolio/chart-enrichment";
import type {
  ChartPoint,
  EnrichChartDataInput,
} from "@/lib/portfolio/chart-enrichment";
import type { AdjustmentDelta } from "@/lib/actions/activity-log";

// ── Test helpers ───────────────────────────────────────────

function makePoint(overrides: Partial<ChartPoint> & { date: string }): ChartPoint {
  return {
    value: 0,
    valueUsd: 0,
    cryptoUsd: 0,
    stocksUsd: 0,
    cashUsd: 0,
    cryptoPct: 0,
    stocksPct: 0,
    cashPct: 0,
    ...overrides,
  };
}

function makeDelta(overrides: Partial<AdjustmentDelta> & { date: string }): AdjustmentDelta {
  return {
    cumulative_usd: 0,
    cumulative_eur: 0,
    crypto_cumulative_usd: 0,
    crypto_cumulative_eur: 0,
    stocks_cumulative_usd: 0,
    stocks_cumulative_eur: 0,
    cash_cumulative_usd: 0,
    cash_cumulative_eur: 0,
    ...overrides,
  };
}

const SP500_PRICE = 5000;
const SP500_HISTORY = [{ date: "2026-01-01", close: SP500_PRICE }];

function makeInput(overrides: Partial<EnrichChartDataInput>): EnrichChartDataInput {
  return {
    points: [],
    viewMode: "total",
    primaryCurrency: "USD",
    sp500History: SP500_HISTORY,
    cashFlows: [],
    adjustmentDeltas: [],
    snapshotRatios: null,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────

describe("enrichChartData — S&P seeding FX ratio", () => {
  /**
   * Bug scenario: EUR user viewing Stocks chart where stocks_value = 0 at
   * the first chart point (stocks imported on a later date). The per-class
   * FX ratio is undefined (0/0), so the algorithm must fall back to the
   * portfolio-wide FX ratio. Before the fix, the EUR display value was
   * treated as USD, producing a ~15% error.
   */
  it("zero slice, EUR user → uses portfolio-wide FX ratio", () => {
    // Portfolio: €30,500 EUR = $36,000 USD (implicit rate ~1.18)
    // Stocks slice: 0 at start (imported later)
    // Adjustment delta: €27,000 EUR / $32,000 USD (stocks import)
    const points = [
      makePoint({
        date: "2026-01-01",
        value: 30500,    // EUR
        valueUsd: 36000, // USD
        stocksUsd: 0,    // zero at start
        cryptoUsd: 20000,
        cashUsd: 16000,
      }),
    ];

    const deltas = [
      makeDelta({
        date: "2026-02-20",
        cumulative_usd: 32000,
        cumulative_eur: 27000,
        stocks_cumulative_usd: 32000,
        stocks_cumulative_eur: 27000,
      }),
    ];

    const result = enrichChartData(
      makeInput({
        points,
        viewMode: "stocks",
        primaryCurrency: "EUR",
        cashFlows: [{ date: "2025-12-01", amount_usd: 100 }],
        adjustmentDeltas: deltas,
        snapshotRatios: [{ date: "2026-01-01", ratio: 0 }],
      }),
    );

    // The S&P should start at the adjusted stocks display value (€27,000)
    // not at $27,000 mistakenly treated as EUR.
    // adjustedFirstDisp = 0 + (27000 - 0) = 27000 EUR
    // fxRatioUsdPerDisp = 36000 / 30500 (portfolio-wide fallback)
    // adjustedFirstUsd = 27000 * (36000 / 30500) ≈ 31868
    // neededUnits = 31868 / 5000 ≈ 6.374
    // sp500Value = 6.374 * 5000 * (30500 / 36000) ≈ 27000
    expect(result[0].sp500Value).toBeDefined();
    const sp500 = result[0].sp500Value!;
    const adjusted = result[0].adjustedValue!;
    // S&P and adjusted portfolio value must start at the same point (within 0.1%)
    expect(Math.abs(sp500 - adjusted) / adjusted).toBeLessThan(0.001);
  });

  /**
   * Normal case: per-class slice has non-zero value at chart start.
   * The per-class FX ratio should be used directly.
   */
  it("non-zero slice → uses per-class FX ratio", () => {
    // Crypto: €15,000 EUR portfolio-wide, $18,000 USD
    // Crypto slice: $10,000 USD
    // toDisplayFromUsd(10000, {30000, 36000}) = 10000 * (30000/36000) = 8333 EUR
    const points = [
      makePoint({
        date: "2026-01-01",
        value: 30000,
        valueUsd: 36000,
        cryptoUsd: 10000,
        stocksUsd: 16000,
        cashUsd: 10000,
      }),
    ];

    const deltas = [
      makeDelta({
        date: "2026-01-15",
        cumulative_usd: 5000,
        cumulative_eur: 4200,
        crypto_cumulative_usd: 5000,
        crypto_cumulative_eur: 4200,
      }),
    ];

    const result = enrichChartData(
      makeInput({
        points,
        viewMode: "crypto",
        primaryCurrency: "EUR",
        cashFlows: [{ date: "2025-12-01", amount_usd: 50 }],
        adjustmentDeltas: deltas,
        snapshotRatios: [{ date: "2026-01-01", ratio: 10000 / 36000 }],
      }),
    );

    expect(result[0].sp500Value).toBeDefined();
    const sp500 = result[0].sp500Value!;
    const adjusted = result[0].adjustedValue!;
    // S&P and adjusted value must match at start (within 0.1%)
    expect(Math.abs(sp500 - adjusted) / adjusted).toBeLessThan(0.001);
  });

  /**
   * USD user: the FX ratio is always 1 (no conversion). The per-class
   * USD value IS the display value, so no fallback is needed.
   */
  it("USD user → no FX conversion (ratio = 1)", () => {
    const points = [
      makePoint({
        date: "2026-01-01",
        value: 50000,     // USD = display
        valueUsd: 50000,
        stocksUsd: 30000,
        cryptoUsd: 15000,
        cashUsd: 5000,
      }),
    ];

    const deltas = [
      makeDelta({
        date: "2026-01-10",
        cumulative_usd: 10000,
        cumulative_eur: 8400,
        stocks_cumulative_usd: 10000,
        stocks_cumulative_eur: 8400,
      }),
    ];

    const result = enrichChartData(
      makeInput({
        points,
        viewMode: "stocks",
        primaryCurrency: "USD",
        cashFlows: [{ date: "2025-12-01", amount_usd: 100 }],
        adjustmentDeltas: deltas,
        snapshotRatios: [{ date: "2026-01-01", ratio: 30000 / 50000 }],
      }),
    );

    expect(result[0].sp500Value).toBeDefined();
    const sp500 = result[0].sp500Value!;
    const adjusted = result[0].adjustedValue!;
    // adjustedFirstDisp = 30000 + (10000 - 0) = 40000 USD
    // fxRatioUsdPerDisp = 30000/30000 = 1 (per-class, since value=valueUsd for USD)
    // adjustedFirstUsd = 40000, neededUnits = 40000/5000 = 8
    // sp500Value = 8 * 5000 = 40000
    expect(sp500).toBeCloseTo(40000, 0);
    expect(adjusted).toBeCloseTo(40000, 0);
  });

  /**
   * Edge case: entire portfolio is zero (no value at all). The identity
   * fallback must prevent division by zero.
   */
  it("zero portfolio → identity fallback (no division by zero)", () => {
    const points = [
      makePoint({
        date: "2026-01-01",
        value: 0,
        valueUsd: 0,
        stocksUsd: 0,
        cryptoUsd: 0,
        cashUsd: 0,
      }),
    ];

    const deltas = [
      makeDelta({
        date: "2026-01-05",
        cumulative_usd: 1000,
        cumulative_eur: 840,
        stocks_cumulative_usd: 1000,
        stocks_cumulative_eur: 840,
      }),
    ];

    const result = enrichChartData(
      makeInput({
        points,
        viewMode: "stocks",
        primaryCurrency: "EUR",
        cashFlows: [{ date: "2025-12-01", amount_usd: 10 }],
        adjustmentDeltas: deltas,
        snapshotRatios: [{ date: "2026-01-01", ratio: 0 }],
      }),
    );

    // Should not throw — the identity fallback (ratio = 1) handles all-zero
    expect(result).toHaveLength(1);
    // adjustedFirstDisp = 0 + (840 - 0) = 840
    // fxRatioUsdPerDisp = 1 (identity fallback: both slice and portfolio are 0)
    // adjustedFirstUsd = 840 * 1 = 840 → neededUnits = 840/5000 = 0.168
    // sp500ValueUsd = 0.168 * 5000 = 840 USD
    // But toDisplayCurrency returns undefined when valueUsd=0 (can't derive FX rate)
    // — this is correct: a zero-value portfolio has no implicit FX rate to convert with
    expect(result[0].sp500Value).toBeUndefined();
    // The seeding itself must still work without throwing
    expect(result[0].adjustedValue).toBe(840);
  });
});
