import { describe, it, expect } from "vitest";
import { enrichChartData } from "@/lib/portfolio/chart-enrichment";
import type {
  ChartPoint,
  EnrichChartDataInput,
} from "@/lib/portfolio/chart-enrichment";
import type { AdjustmentDelta } from "@/lib/types";

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

// ── Naive fallback path (empty cashFlows) ─────────────────

describe("enrichChartData — naive fallback", () => {
  it("uses portfolio start price ratio for S&P when cashFlows is empty", () => {
    // With cashFlows=[], enrichNaiveFallback is used:
    // S&P seeded as (portfolioStart / sp500Start) × sp500Price
    const points = [
      makePoint({ date: "2026-01-01", value: 50000, valueUsd: 50000 }),
      makePoint({ date: "2026-01-02", value: 51000, valueUsd: 51000 }),
    ];

    const result = enrichChartData(
      makeInput({
        points,
        viewMode: "total",
        primaryCurrency: "USD",
        sp500History: [
          { date: "2026-01-01", close: 5000 },
          { date: "2026-01-02", close: 5100 },
        ],
        cashFlows: [], // empty → triggers naive fallback
        adjustmentDeltas: [],
      }),
    );

    // Naive: sp500Value = (portfolioStart / sp500Start) × close
    // = (50000 / 5000) × 5000 = 50000 (day 1)
    // = (50000 / 5000) × 5100 = 51000 (day 2)
    expect(result[0].sp500Value).toBeCloseTo(50000, 0);
    expect(result[1].sp500Value).toBeCloseTo(51000, 0);
  });
});

// ── Multiple cash flows accumulation ──────────────────────

describe("enrichChartData — cash flow unit accumulation", () => {
  it("accumulates S&P units from multiple cash flows", () => {
    const points = [
      makePoint({ date: "2026-01-01", value: 2000, valueUsd: 2000 }),
      makePoint({ date: "2026-01-05", value: 2000, valueUsd: 2000 }),
      makePoint({ date: "2026-01-10", value: 2000, valueUsd: 2000 }),
    ];

    const result = enrichChartData(
      makeInput({
        points,
        viewMode: "total",
        primaryCurrency: "USD",
        sp500History: [
          { date: "2026-01-01", close: 5000 },
          { date: "2026-01-05", close: 5100 },
          { date: "2026-01-10", close: 5200 },
        ],
        cashFlows: [
          { date: "2025-12-01", amount_usd: 1000 }, // pre-chart
          { date: "2026-01-05", amount_usd: 1000 }, // during chart
        ],
        adjustmentDeltas: [],
      }),
    );

    // Pre-chart: 1000/5000 = 0.2 units (using forward-filled sp500 price at 2025-12-01)
    // After seeding, units are adjusted to match the portfolio start value.
    // The key assertion: each point has a defined sp500Value
    expect(result).toHaveLength(3);
    for (const pt of result) {
      expect(pt.sp500Value).toBeDefined();
      expect(Number.isFinite(pt.sp500Value)).toBe(true);
    }
    // After the second cash flow (day 2), sp500Value should increase
    // because more units were added
    expect(result[2].sp500Value!).toBeGreaterThan(result[0].sp500Value!);
  });
});

// ── Weekend chart start (regression: S&P seeding failure) ─

describe("enrichChartData — weekend chart start", () => {
  it("seeds S&P correctly when chart starts on a weekend (no trading data)", () => {
    // Regression: 7D chart starting on Sunday had no S&P price for the first
    // date. The seeding condition (sp500StartPrice > 0) failed, so S&P only
    // tracked tiny actual cash flows instead of matching the portfolio value.
    // Fix: forward-fill seeds lastPrice from the most recent trading day
    // BEFORE chartStart.
    const points = [
      makePoint({ date: "2026-03-15", value: 110000, valueUsd: 128000 }), // Sunday
      makePoint({ date: "2026-03-16", value: 110500, valueUsd: 128500 }), // Monday
      makePoint({ date: "2026-03-17", value: 111000, valueUsd: 129000 }), // Tuesday
    ];

    const result = enrichChartData(
      makeInput({
        points,
        viewMode: "total",
        primaryCurrency: "EUR",
        sp500History: [
          // Only trading days — no weekend prices
          { date: "2026-03-13", close: 13000 }, // Friday (before chart)
          { date: "2026-03-16", close: 13050 }, // Monday
          { date: "2026-03-17", close: 13100 }, // Tuesday
        ],
        cashFlows: [
          { date: "2026-03-03", amount_usd: 700 }, // tiny real cash flow
        ],
        adjustmentDeltas: [
          makeDelta({
            date: "2026-02-20",
            cumulative_usd: 127000,
            cumulative_eur: 109000,
          }),
        ],
      }),
    );

    // Sunday must have a forward-filled S&P price from Friday
    expect(result[0].sp500Value).toBeDefined();
    // The S&P should start near the portfolio value (~€110k), not at ~€1,500
    // (which would happen if seeding failed and only the tiny $700 cash flow
    // determined the S&P units)
    expect(result[0].sp500Value!).toBeGreaterThan(50000);
    // All points should have finite S&P values
    for (const pt of result) {
      expect(pt.sp500Value).toBeDefined();
      expect(Number.isFinite(pt.sp500Value)).toBe(true);
    }
  });
});

// ── S&P forward-fill gaps ─────────────────────────────────

describe("enrichChartData — S&P forward-fill", () => {
  it("forward-fills S&P prices for weekend gaps", () => {
    // Provide S&P only for Mon/Wed/Fri, chart spans Mon-Sun
    const points = [
      makePoint({ date: "2026-01-05", value: 10000, valueUsd: 10000 }), // Mon
      makePoint({ date: "2026-01-06", value: 10000, valueUsd: 10000 }), // Tue
      makePoint({ date: "2026-01-07", value: 10000, valueUsd: 10000 }), // Wed
      makePoint({ date: "2026-01-08", value: 10000, valueUsd: 10000 }), // Thu
      makePoint({ date: "2026-01-09", value: 10000, valueUsd: 10000 }), // Fri
      makePoint({ date: "2026-01-10", value: 10000, valueUsd: 10000 }), // Sat
      makePoint({ date: "2026-01-11", value: 10000, valueUsd: 10000 }), // Sun
    ];

    const result = enrichChartData(
      makeInput({
        points,
        viewMode: "total",
        primaryCurrency: "USD",
        sp500History: [
          { date: "2026-01-05", close: 5000 }, // Mon
          { date: "2026-01-07", close: 5050 }, // Wed
          { date: "2026-01-09", close: 5100 }, // Fri
        ],
        cashFlows: [],
        adjustmentDeltas: [],
      }),
    );

    // All 7 days should have sp500Value (forward-filled)
    for (const pt of result) {
      expect(pt.sp500Value).toBeDefined();
      expect(Number.isFinite(pt.sp500Value)).toBe(true);
    }
    // Tue should forward-fill from Mon's price
    // Naive: ratio = 10000/5000 = 2, so sp500Value = 2 × close
    expect(result[1].sp500Value).toBeCloseTo(10000, 0); // Tue: 2 × 5000
    // Thu should forward-fill from Wed's price
    expect(result[3].sp500Value).toBeCloseTo(10100, 0); // Thu: 2 × 5050
    // Sat/Sun should forward-fill from Fri's price
    expect(result[5].sp500Value).toBeCloseTo(10200, 0); // Sat: 2 × 5100
    expect(result[6].sp500Value).toBeCloseTo(10200, 0); // Sun: 2 × 5100
  });
});
