import { describe, it, expect } from "vitest";
import {
  enrichChartData,
  lookupCostAtOrBefore,
  lookupCostValueAtOrBefore,
  mergeCostBasisIntoChart,
  computeCostBasisYDomainExpansion,
} from "@/lib/portfolio/chart-enrichment";
import type {
  ChartPoint,
  EnrichedChartPoint,
  EnrichChartDataInput,
  CostBasisSeriesPoint,
} from "@/lib/portfolio/chart-enrichment";
import type { CashFlowEvent } from "@/lib/types";

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

const SP500_PRICE = 5000;
const SP500_HISTORY = [{ date: "2026-01-01", close: SP500_PRICE }];

function makeInput(overrides: Partial<EnrichChartDataInput>): EnrichChartDataInput {
  return {
    points: [],
    viewMode: "total",
    primaryCurrency: "USD",
    sp500History: SP500_HISTORY,
    cashFlows: [],
    snapshotRatios: null,
    ...overrides,
  };
}

function makeCostPoint(
  overrides: Partial<CostBasisSeriesPoint> & { date: string },
): CostBasisSeriesPoint {
  return {
    cryptoCostUsd: 0,
    stocksCostUsd: 0,
    cashCostUsd: 0,
    cryptoCostEur: 0,
    stocksCostEur: 0,
    cashCostEur: 0,
    cryptoGapUsd: 0,
    stocksGapUsd: 0,
    cashGapUsd: 0,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────

describe("enrichChartData — literal-truth contract (Phase 4)", () => {
  /**
   * Phase 4 contract: the portfolio line is the literal truth from the
   * snapshot (already augmented upstream by historical-price/manual-NAV).
   * The S&P benchmark seeds against that truth at chartStart and diverges.
   */
  /**
   * No cash flows, no backdated data: the naive fallback seeds S&P at the
   * portfolio's first snapshot value. Both lines start equal and diverge by
   * actual performance.
   */
  it("seeds S&P at the first portfolio value (no cash flows path)", () => {
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
        cashFlows: [],
      }),
    );
    // Naive: sp500Value = (portfolioStart / sp500Start) × close
    // = (50000 / 5000) × 5000 = 50000 (day 1, equal start)
    // = (50000 / 5000) × 5100 = 51000 (day 2, after +2% S&P gain)
    expect(result[0].sp500Value).toBeCloseTo(50000, 0);
    expect(result[1].sp500Value).toBeCloseTo(51000, 0);
    // Portfolio values pass through unmodified.
    expect(result[0].value).toBe(50000);
    expect(result[1].value).toBe(51000);
  });

  /**
   * Edge case: portfolio starts at zero (no positions, no backdated lots).
   * Seeding at firstSliceVal=0 keeps the S&P benchmark at zero too —
   * "if you'd invested NOTHING, you'd have NOTHING" is the correct answer.
   */
  it("zero portfolio at chartStart keeps S&P at zero or undefined (no FX anchor)", () => {
    const points = [
      makePoint({ date: "2026-01-01", value: 0, valueUsd: 0 }),
    ];
    const result = enrichChartData(
      makeInput({
        points,
        viewMode: "total",
        primaryCurrency: "EUR",
        cashFlows: [{ date: "2025-12-01", amount_usd: 10 }],
        snapshotRatios: [{ date: "2026-01-01", ratio: 0 }],
      }),
    );
    // The fxRatioUsdPerDisp lookup falls through all 4 tiers (no non-zero
    // point anywhere), so seeding is skipped. preChartUnits = 10/5000 = 0.002.
    // sp500ValueUsd = 0.002 × 5000 = 10 USD. But the portfolio has valueUsd=0
    // at this point, so toDisplayCurrency returns undefined for EUR user.
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(0);
    expect(result[0].sp500Value).toBeUndefined();
  });
});

// ── Per-class S&P seeding FX ratio ─────────────────────────

describe("enrichChartData — S&P seeding FX ratio", () => {
  /**
   * EUR user, per-class slice zero at chartStart → fallback to portfolio-wide
   * FX ratio. The seed must use the EUR firstSliceVal converted via the
   * portfolio-wide rate, not the identity (which would corrupt the seed).
   */
  it("zero slice, EUR user → uses portfolio-wide FX ratio", () => {
    // Portfolio: €30,500 EUR = $36,000 USD (implicit rate ~1.18)
    // Stocks slice: 0 at start (imported later)
    const points = [
      makePoint({
        date: "2026-01-01",
        value: 30500,
        valueUsd: 36000,
        stocksUsd: 0,
        cryptoUsd: 20000,
        cashUsd: 16000,
      }),
    ];

    const result = enrichChartData(
      makeInput({
        points,
        viewMode: "stocks",
        primaryCurrency: "EUR",
        cashFlows: [{ date: "2025-12-01", amount_usd: 100 }],
        snapshotRatios: [{ date: "2026-01-01", ratio: 0 }],
      }),
    );

    // firstSliceVal (stocks in EUR) = 0
    // → seed math falls into tier-2 (portfolio-wide rate) but seedDisp=0
    // → S&P value at chartStart should be 0 (matching the literal portfolio truth)
    expect(result[0].sp500Value).toBeDefined();
    // Both portfolio and benchmark start at 0 — they only diverge once stocks
    // appear in real cash flows.
    expect(result[0].value).toBe(0);
    expect(result[0].sp500Value).toBeCloseTo(0, 0);
  });

  /**
   * Per-class slice has non-zero value at chart start → use per-class FX ratio.
   */
  it("non-zero slice → uses per-class FX ratio", () => {
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

    const result = enrichChartData(
      makeInput({
        points,
        viewMode: "crypto",
        primaryCurrency: "EUR",
        cashFlows: [{ date: "2025-12-01", amount_usd: 50 }],
        snapshotRatios: [{ date: "2026-01-01", ratio: 10000 / 36000 }],
      }),
    );

    // Crypto slice in EUR = 10000 * (30000/36000) = 8333.33
    // S&P and portfolio crypto must start equal (within rounding).
    expect(result[0].sp500Value).toBeDefined();
    const cryptoSlice = 10000 * (30000 / 36000);
    expect(result[0].value).toBeCloseTo(cryptoSlice, 0);
    expect(result[0].sp500Value!).toBeCloseTo(cryptoSlice, 0);
  });

  /**
   * USD user: no FX conversion needed. seedDisp == firstSliceVal == USD value.
   */
  it("USD user → no FX conversion (ratio = 1)", () => {
    const points = [
      makePoint({
        date: "2026-01-01",
        value: 50000,
        valueUsd: 50000,
        stocksUsd: 30000,
        cryptoUsd: 15000,
        cashUsd: 5000,
      }),
    ];

    const result = enrichChartData(
      makeInput({
        points,
        viewMode: "stocks",
        primaryCurrency: "USD",
        cashFlows: [{ date: "2025-12-01", amount_usd: 100 }],
        snapshotRatios: [{ date: "2026-01-01", ratio: 30000 / 50000 }],
      }),
    );

    // Stocks slice = 30000 USD.
    // Seed: seedDisp=30000, fxRatio=1 → seedUsd=30000, neededUnits=6.
    // S&P value = 6 × 5000 = 30000 (matches portfolio stocks slice).
    expect(result[0].value).toBe(30000);
    expect(result[0].sp500Value).toBeCloseTo(30000, 0);
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
      }),
    );

    expect(result).toHaveLength(3);
    for (const pt of result) {
      expect(pt.sp500Value).toBeDefined();
      expect(Number.isFinite(pt.sp500Value)).toBe(true);
    }
    // After the day-2 cash flow, sp500Value should increase
    expect(result[2].sp500Value!).toBeGreaterThan(result[0].sp500Value!);
  });
});

// ── Weekend chart start (regression: S&P seeding failure) ─

describe("enrichChartData — weekend chart start", () => {
  it("seeds S&P correctly when chart starts on a weekend (no trading data)", () => {
    // Regression: 7D chart starting on Sunday had no S&P price for the first
    // date. Forward-fill seeds lastPrice from the most recent trading day
    // BEFORE chartStart so seeding works at the weekend boundary.
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
          { date: "2026-03-13", close: 13000 }, // Friday (before chart)
          { date: "2026-03-16", close: 13050 }, // Monday
          { date: "2026-03-17", close: 13100 }, // Tuesday
        ],
        cashFlows: [
          { date: "2026-03-03", amount_usd: 700 }, // tiny real cash flow
        ],
      }),
    );

    // Sunday must have a forward-filled S&P price from Friday and seed
    // against the portfolio value (~€110k), not at ~€1,500 (which would
    // happen if seeding failed and only the tiny $700 cash flow drove S&P).
    expect(result[0].sp500Value).toBeDefined();
    expect(result[0].sp500Value!).toBeGreaterThan(50000);
    for (const pt of result) {
      expect(pt.sp500Value).toBeDefined();
      expect(Number.isFinite(pt.sp500Value)).toBe(true);
    }
  });
});

// ── Extended range: synthesized benchmark cash flow ───────

describe("enrichChartData — extended range with synthetic benchmark cash flow", () => {
  it("seeds the S&P to the portfolio value at chartStart (seedDelta ≈ 0)", () => {
    // Phase 1/2 back-extension feeds a synthesized point at 2021-01-01
    // (portfolio value = $60k from augmentation) plus a synthetic cash flow.
    // The seed reconciliation must make sp500Value[0] ≈ 60000, and
    // sp500Value[1] must double because the S&P price doubled (3000 → 6000).
    const points = [
      makePoint({ date: "2021-01-01", value: 60000, valueUsd: 60000, cryptoUsd: 60000 }),
      makePoint({ date: "2026-01-01", value: 120000, valueUsd: 120000, cryptoUsd: 120000 }),
    ];
    const cashFlows: CashFlowEvent[] = [
      { date: "2021-01-01", amount_usd: 60000, asset_class: "crypto" },
    ];
    const sp500History = [
      { date: "2021-01-01", close: 3000 },
      { date: "2026-01-01", close: 6000 },
    ];
    const out = enrichChartData(
      makeInput({
        points,
        viewMode: "total",
        primaryCurrency: "USD",
        sp500History,
        cashFlows,
        snapshotRatios: null,
      }),
    );
    // Seed: preChartUnits = 0, units at 2021-01-01 = 60000/3000 = 20.
    // neededUnits = 60000/3000 = 20 (equals unitsAtChartStart), seedDelta = 0.
    // sp500Value[0] = 20 × 3000 = 60000.
    // sp500Value[1] = 20 × 6000 = 120000 (S&P doubled).
    expect(out[0].sp500Value).toBeCloseTo(60000, 0);
    expect(out[1].sp500Value).toBeCloseTo(120000, 0);
    // Portfolio values pass through as literal truth.
    expect(out[0].value).toBe(60000);
    expect(out[1].value).toBe(120000);
  });

  it("adds S&P units for a second backdated lot at its later date", () => {
    const points = [
      makePoint({ date: "2021-01-01", value: 60000, valueUsd: 60000, cryptoUsd: 60000 }),
      makePoint({ date: "2022-01-01", value: 90000, valueUsd: 90000, cryptoUsd: 70000, stocksUsd: 20000 }),
      makePoint({ date: "2026-01-01", value: 200000, valueUsd: 200000, cryptoUsd: 150000, stocksUsd: 50000 }),
    ];
    const cashFlows: CashFlowEvent[] = [
      { date: "2021-01-01", amount_usd: 60000, asset_class: "crypto" },
      { date: "2022-01-01", amount_usd: 20000, asset_class: "stocks" },
    ];
    const sp500History = [
      { date: "2021-01-01", close: 3000 },
      { date: "2022-01-01", close: 4000 },
      { date: "2026-01-01", close: 6000 },
    ];
    const out = enrichChartData(
      makeInput({
        points,
        viewMode: "total",
        primaryCurrency: "USD",
        sp500History,
        cashFlows,
        snapshotRatios: null,
      }),
    );
    // 2021-01-01: 60000/3000 = 20 units.
    // 2022-01-01: +20000/4000 = +5 → 25 units.
    // 2026-01-01: 25 × 6000 = 150000.
    expect(out[2].sp500Value).toBeCloseTo(150000, 0);
  });
});

// ── S&P forward-fill gaps ─────────────────────────────────

describe("enrichChartData — S&P forward-fill", () => {
  it("forward-fills S&P prices for weekend gaps", () => {
    // S&P only for Mon/Wed/Fri, chart spans Mon-Sun
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
      }),
    );

    for (const pt of result) {
      expect(pt.sp500Value).toBeDefined();
      expect(Number.isFinite(pt.sp500Value)).toBe(true);
    }
    // Naive: ratio = 10000/5000 = 2, so sp500Value = 2 × close
    expect(result[1].sp500Value).toBeCloseTo(10000, 0); // Tue: 2 × 5000
    expect(result[3].sp500Value).toBeCloseTo(10100, 0); // Thu: 2 × 5050
    expect(result[5].sp500Value).toBeCloseTo(10200, 0); // Sat: 2 × 5100
    expect(result[6].sp500Value).toBeCloseTo(10200, 0); // Sun: 2 × 5100
  });
});

// ── lookupCostAtOrBefore — per-viewMode gap summation (Task 3.4c) ──

describe("lookupCostAtOrBefore — per-viewMode gap summation", () => {
  const series: CostBasisSeriesPoint[] = [
    makeCostPoint({ date: "2026-01-01", cryptoGapUsd: 100, stocksGapUsd: 200, cashGapUsd: 5 }),
    makeCostPoint({ date: "2026-01-10", cryptoGapUsd: 300, stocksGapUsd: 400, cashGapUsd: 7 }),
    makeCostPoint({ date: "2026-02-01", cryptoGapUsd: 999, stocksGapUsd: 999, cashGapUsd: 999 }),
  ];

  it("crypto → cryptoGapUsd at the latest point on-or-before chartStart", () => {
    expect(lookupCostAtOrBefore(series, "2026-01-15", "crypto")).toBe(300);
  });

  it("stocks → stocksGapUsd", () => {
    expect(lookupCostAtOrBefore(series, "2026-01-15", "stocks")).toBe(400);
  });

  it("cash → cashGapUsd", () => {
    expect(lookupCostAtOrBefore(series, "2026-01-15", "cash")).toBe(7);
  });

  it("investments → crypto + stocks (NOT cash)", () => {
    expect(lookupCostAtOrBefore(series, "2026-01-15", "investments")).toBe(300 + 400);
  });

  it("total → crypto + stocks + cash", () => {
    expect(lookupCostAtOrBefore(series, "2026-01-15", "total")).toBe(300 + 400 + 7);
  });

  it("picks the LATEST point with date <= chartStart (exact boundary)", () => {
    // chartStart exactly on a point's date → that point is included.
    expect(lookupCostAtOrBefore(series, "2026-01-10", "total")).toBe(300 + 400 + 7);
    // One day before → the earlier point.
    expect(lookupCostAtOrBefore(series, "2026-01-09", "total")).toBe(100 + 200 + 5);
  });

  it("returns 0 when the series is empty", () => {
    expect(lookupCostAtOrBefore([], "2026-01-15", "total")).toBe(0);
  });

  it("returns 0 when no point is at-or-before chartStart", () => {
    expect(lookupCostAtOrBefore(series, "2025-12-31", "total")).toBe(0);
  });

  it("reads the PRE-COMPUTED gap columns verbatim (never recomputes from cost)", () => {
    // A point whose gap columns are explicitly authoritative — even a NEGATIVE
    // gap (market below cost) must pass through unchanged, proving we read the
    // column rather than re-deriving market−cost.
    const negSeries: CostBasisSeriesPoint[] = [
      makeCostPoint({ date: "2026-01-01", cryptoGapUsd: -1500, stocksGapUsd: 0, cashGapUsd: 0 }),
    ];
    expect(lookupCostAtOrBefore(negSeries, "2026-06-01", "crypto")).toBe(-1500);
    expect(lookupCostAtOrBefore(negSeries, "2026-06-01", "total")).toBe(-1500);
  });
});

// ── Seed re-anchor to cost (Task 3.4e/f) ──────────────────

describe("enrichChartData — S&P seed re-anchor to cost basis", () => {
  /**
   * Scenario 1 — a user-costed backdated lot, cost < market at chartStart.
   * cost 5,000, market 8,000 → gap 3,000. The S&P line anchors at the COST
   * (market − gap), the portfolio line stays at market truth. The 3,000 gap
   * SURVIVES at chartStart: the divergence is exactly the gap.
   *
   * USD-primary so firstSliceVal == firstSliceUsd and the gap maps 1:1 with no
   * FX rounding — the divergence assertion is exact.
   */
  it("anchors the S&P to cost while the portfolio stays at market (gap survives)", () => {
    const points = [
      makePoint({ date: "2026-01-01", value: 8000, valueUsd: 8000, cryptoUsd: 8000 }),
      makePoint({ date: "2026-01-02", value: 8000, valueUsd: 8000, cryptoUsd: 8000 }),
    ];
    const costBasisSeries: CostBasisSeriesPoint[] = [
      // gap = market(8000) − cost(5000) = 3000
      makeCostPoint({ date: "2026-01-01", cryptoGapUsd: 3000 }),
    ];
    const out = enrichChartData(
      makeInput({
        points,
        viewMode: "crypto",
        primaryCurrency: "USD",
        sp500History: [
          { date: "2026-01-01", close: 5000 },
          { date: "2026-01-02", close: 5000 },
        ],
        // A backdated benchmark cash flow at the lot's market value (the
        // synthetic-flow path), so the seed re-anchor is exercised, not naive.
        cashFlows: [{ date: "2026-01-01", amount_usd: 8000, asset_class: "crypto" }],
        snapshotRatios: null,
        costBasisSeries,
      }),
    );
    // Portfolio line = literal market truth.
    expect(out[0].value).toBe(8000);
    // S&P seed = firstSliceUsd(8000) − gap(3000) = 5000 (cost-equivalent).
    expect(out[0].sp500Value).toBeCloseTo(5000, 6);
    // The gap survives: portfolio − S&P at chartStart == the 3,000 gap exactly.
    expect(out[0].value - out[0].sp500Value!).toBeCloseTo(3000, 6);
  });

  /**
   * Scenario 2 — a NON-backdated user-costed lot predating a short-period
   * chartStart. The widened price coverage feeds its gap into the series, so it
   * applies at chartStart even though it is not a backdated lot. EPS tolerance
   * is allowed on THIS branch only (reconstructed market vs snapshot may differ
   * by FX/forward-fill ULPs); here the fixture is exact so we assert tightly.
   */
  it("applies the gap of a non-backdated user-costed lot predating chartStart", () => {
    const points = [
      makePoint({ date: "2026-03-10", value: 12000, valueUsd: 12000, stocksUsd: 12000 }),
      makePoint({ date: "2026-03-11", value: 12000, valueUsd: 12000, stocksUsd: 12000 }),
    ];
    const costBasisSeries: CostBasisSeriesPoint[] = [
      // The lot was bought 2026-01-15 (before the 7D window). Its gap is carried
      // forward on the daily spine; the latest point on-or-before chartStart is
      // 2026-03-10 with a running gap of 2,000 (market 12,000 − cost 10,000).
      makeCostPoint({ date: "2026-01-15", stocksGapUsd: 1000 }),
      makeCostPoint({ date: "2026-03-10", stocksGapUsd: 2000 }),
    ];
    const out = enrichChartData(
      makeInput({
        points,
        viewMode: "stocks",
        primaryCurrency: "USD",
        sp500History: [
          { date: "2026-03-10", close: 4000 },
          { date: "2026-03-11", close: 4000 },
        ],
        cashFlows: [{ date: "2026-03-10", amount_usd: 12000, asset_class: "stocks" }],
        snapshotRatios: null,
        costBasisSeries,
      }),
    );
    // seed = 12000 − 2000 = 10000 → divergence == 2000 at chartStart.
    expect(out[0].value).toBe(12000);
    expect(out[0].sp500Value!).toBeCloseTo(10000, 6);
    expect(out[0].value - out[0].sp500Value!).toBeCloseTo(2000, 6);
  });

  /**
   * Control 1 — NO user cost (empty series). The enriched output must be
   * BYTE-IDENTICAL to a run WITHOUT the series prop. Exact deep-equality, not EPS.
   * This proves the seed is a pure delta: gap=0 → the SAME code path → identical bytes.
   */
  it("Control 1: empty series → byte-identical to no-series run", () => {
    const points = [
      makePoint({ date: "2026-01-01", value: 60000, valueUsd: 60000, cryptoUsd: 60000 }),
      makePoint({ date: "2026-02-01", value: 72000, valueUsd: 72000, cryptoUsd: 72000 }),
    ];
    const base = {
      points,
      viewMode: "total" as const,
      primaryCurrency: "USD" as const,
      sp500History: [
        { date: "2026-01-01", close: 5000 },
        { date: "2026-02-01", close: 5500 },
      ],
      cashFlows: [{ date: "2026-01-01", amount_usd: 60000, asset_class: "crypto" as const }],
      snapshotRatios: null,
    };
    const without = enrichChartData(makeInput({ ...base }));
    const withEmpty = enrichChartData(makeInput({ ...base, costBasisSeries: [] }));
    expect(withEmpty).toEqual(without);
  });

  /**
   * Control 2 (the REAL guard) — a POPULATED series whose gap is 0 (a backdated
   * lot is present, cost == market). STILL byte-identical. This proves the
   * benchmark is unchanged by GAP-SUBTRACTION reaching zero — not by the series
   * being empty (an accident Control 1 alone cannot rule out).
   */
  it("Control 2: populated series, gap == 0 → byte-identical to no-series run", () => {
    const points = [
      makePoint({ date: "2026-01-01", value: 60000, valueUsd: 60000, cryptoUsd: 60000 }),
      makePoint({ date: "2026-02-01", value: 72000, valueUsd: 72000, cryptoUsd: 72000 }),
    ];
    const base = {
      points,
      viewMode: "total" as const,
      primaryCurrency: "USD" as const,
      sp500History: [
        { date: "2026-01-01", close: 5000 },
        { date: "2026-02-01", close: 5500 },
      ],
      cashFlows: [{ date: "2026-01-01", amount_usd: 60000, asset_class: "crypto" as const }],
      snapshotRatios: null,
    };
    const without = enrichChartData(makeInput({ ...base }));
    // Populated: a real point at chartStart, but cost == market → every gap 0.
    const populated: CostBasisSeriesPoint[] = [
      makeCostPoint({ date: "2026-01-01", cryptoGapUsd: 0, stocksGapUsd: 0, cashGapUsd: 0 }),
      makeCostPoint({ date: "2026-02-01", cryptoGapUsd: 0, stocksGapUsd: 0, cashGapUsd: 0 }),
    ];
    const withZeroGap = enrichChartData(makeInput({ ...base, costBasisSeries: populated }));
    expect(withZeroGap).toEqual(without);
  });

  /**
   * Scenario 5 — an is_adjustment lot at chartStart is NEVER user-costed, so it
   * never enters the gap (its series gap columns stay 0). Byte-identical.
   * Modeled as a populated series with 0 gaps + an adjustment-style synthetic
   * cash flow at chartStart.
   */
  it("is_adjustment lot at chartStart → not in the gap → byte-identical", () => {
    const points = [
      makePoint({ date: "2026-01-01", value: 40000, valueUsd: 40000, stocksUsd: 40000 }),
      makePoint({ date: "2026-02-01", value: 44000, valueUsd: 44000, stocksUsd: 44000 }),
    ];
    const base = {
      points,
      viewMode: "stocks" as const,
      primaryCurrency: "USD" as const,
      sp500History: [
        { date: "2026-01-01", close: 5000 },
        { date: "2026-02-01", close: 5200 },
      ],
      cashFlows: [{ date: "2026-01-01", amount_usd: 40000, asset_class: "stocks" as const }],
      snapshotRatios: null,
    };
    const without = enrichChartData(makeInput({ ...base }));
    // The adjustment lot contributes to COST columns upstream but its GAP is 0
    // (user-cost gate excludes is_adjustment). The series the seed reads has 0 gap.
    const adjSeries: CostBasisSeriesPoint[] = [
      makeCostPoint({ date: "2026-01-01", stocksGapUsd: 0 }),
    ];
    const withAdj = enrichChartData(makeInput({ ...base, costBasisSeries: adjSeries }));
    expect(withAdj).toEqual(without);
  });

  /**
   * Empty-slice skip guard — when firstSliceUsd <= 0 (the tier-2/3/4 fallback,
   * e.g. an all-adjustment import backdated before any position existed), today's
   * skip-seeding MUST be preserved EVEN when a gap exists. The series must NOT
   * cause seeding from firstSliceUsd=0.
   */
  it("preserves the empty-slice skip even when a gap is present", () => {
    // stocks slice is 0 at chartStart (firstSliceUsd === 0), portfolio non-zero.
    const points = [
      makePoint({
        date: "2026-01-01",
        value: 30500,
        valueUsd: 36000,
        stocksUsd: 0,
        cryptoUsd: 20000,
        cashUsd: 16000,
      }),
    ];
    const base = {
      points,
      viewMode: "stocks" as const,
      primaryCurrency: "EUR" as const,
      cashFlows: [{ date: "2025-12-01", amount_usd: 100 }],
      snapshotRatios: [{ date: "2026-01-01", ratio: 0 }],
    };
    const without = enrichChartData(makeInput({ ...base }));
    // A gap exists for stocks, but firstSliceUsd === 0 → seeding stays skipped,
    // so the output is unchanged by the series.
    const withGap = enrichChartData(
      makeInput({
        ...base,
        costBasisSeries: [makeCostPoint({ date: "2026-01-01", stocksGapUsd: 4000 })],
      }),
    );
    expect(withGap).toEqual(without);
  });
});

// ── mergeCostBasisIntoChart — cost overlay data merge (Task 5.2) ──

function makeEnrichedPoint(
  overrides: Partial<EnrichedChartPoint> & { date: string },
): EnrichedChartPoint {
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

describe("mergeCostBasisIntoChart — cost overlay data merge", () => {
  const series: CostBasisSeriesPoint[] = [
    makeCostPoint({
      date: "2026-01-01",
      cryptoCostUsd: 5000, cryptoCostEur: 4500,
      stocksCostUsd: 3000, stocksCostEur: 2700,
      cashCostUsd: 1000,  cashCostEur: 900,
    }),
    makeCostPoint({
      date: "2026-02-01",
      cryptoCostUsd: 6000, cryptoCostEur: 5400,
      stocksCostUsd: 4000, stocksCostEur: 3600,
      cashCostUsd: 1200,  cashCostEur: 1080,
    }),
  ];

  it("viewMode=crypto, USD → reads cryptoCostUsd at the at-or-before point", () => {
    const points = [makeEnrichedPoint({ date: "2026-01-15", value: 8000 })];
    const result = mergeCostBasisIntoChart(points, series, "crypto", "USD");
    expect(result[0].costBasis).toBe(5000);
  });

  it("viewMode=crypto, EUR → reads cryptoCostEur", () => {
    const points = [makeEnrichedPoint({ date: "2026-01-15", value: 7000 })];
    const result = mergeCostBasisIntoChart(points, series, "crypto", "EUR");
    expect(result[0].costBasis).toBe(4500);
  });

  it("viewMode=stocks, USD → reads stocksCostUsd", () => {
    const points = [makeEnrichedPoint({ date: "2026-01-15", value: 5000 })];
    const result = mergeCostBasisIntoChart(points, series, "stocks", "USD");
    expect(result[0].costBasis).toBe(3000);
  });

  it("viewMode=cash, EUR → reads cashCostEur", () => {
    const points = [makeEnrichedPoint({ date: "2026-01-15", value: 1000 })];
    const result = mergeCostBasisIntoChart(points, series, "cash", "EUR");
    expect(result[0].costBasis).toBe(900);
  });

  it("viewMode=investments, USD → crypto + stocks", () => {
    const points = [makeEnrichedPoint({ date: "2026-01-15", value: 10000 })];
    const result = mergeCostBasisIntoChart(points, series, "investments", "USD");
    expect(result[0].costBasis).toBe(5000 + 3000); // 8000
  });

  it("viewMode=total, EUR → crypto + stocks + cash EUR", () => {
    const points = [makeEnrichedPoint({ date: "2026-01-15", value: 10000 })];
    const result = mergeCostBasisIntoChart(points, series, "total", "EUR");
    expect(result[0].costBasis).toBe(4500 + 2700 + 900); // 8100
  });

  it("picks the LATER series point when chart date advances past it", () => {
    const points = [makeEnrichedPoint({ date: "2026-02-15", value: 15000 })];
    const result = mergeCostBasisIntoChart(points, series, "crypto", "USD");
    expect(result[0].costBasis).toBe(6000); // from 2026-02-01 entry
  });

  it("costBasis is undefined when chart point predates all series entries", () => {
    const points = [makeEnrichedPoint({ date: "2025-12-31", value: 0 })];
    const result = mergeCostBasisIntoChart(points, series, "total", "USD");
    expect(result[0].costBasis).toBeUndefined();
  });

  it("empty series → points returned unchanged (costBasis absent)", () => {
    const points = [makeEnrichedPoint({ date: "2026-01-15", value: 8000 })];
    const result = mergeCostBasisIntoChart(points, [], "crypto", "USD");
    expect(result).toHaveLength(1);
    expect(result[0].costBasis).toBeUndefined();
    // Returned array is the same reference (no copy when series empty).
    expect(result).toBe(points);
  });

  it("does not mutate the input points array", () => {
    const points = [makeEnrichedPoint({ date: "2026-01-15", value: 8000 })];
    const pointsBefore = JSON.stringify(points);
    mergeCostBasisIntoChart(points, series, "crypto", "USD");
    expect(JSON.stringify(points)).toBe(pointsBefore);
  });

  // FIX 4: missing investments, EUR case
  it("viewMode=investments, EUR → cryptoCostEur + stocksCostEur", () => {
    const points = [makeEnrichedPoint({ date: "2026-01-15", value: 10000 })];
    const result = mergeCostBasisIntoChart(points, series, "investments", "EUR");
    expect(result[0].costBasis).toBe(4500 + 2700); // 7200
  });
});

// ── computeCostBasisYDomainExpansion — FIX 1 domain clipping guard ──────────

describe("computeCostBasisYDomainExpansion — domain clipping for short periods", () => {
  /**
   * FIX 1 regression: a series whose only entry PRE-dates chartStart carries
   * its value forward onto every visible point via at-or-before lookup.
   * The domain expansion must include that carried-forward cost even when no
   * series entry falls inside [chartStart, chartEnd].
   *
   * Setup: cost entry on 2026-01-01, chart window is 2026-02-01 → 2026-03-01.
   * The cost value (9000) exceeds all visible portfolio values — without the
   * seed lookup, the domain would miss it and the cost line would be clipped.
   */
  it("includes the carried-forward pre-window cost in the domain", () => {
    const series: CostBasisSeriesPoint[] = [
      makeCostPoint({
        date: "2026-01-01",
        cryptoCostUsd: 9000, cryptoCostEur: 8000,
        stocksCostUsd: 0, stocksCostEur: 0,
        cashCostUsd: 0, cashCostEur: 0,
      }),
    ];
    // chartStart is 2026-02-01, which is AFTER the only series entry.
    const { min, max } = computeCostBasisYDomainExpansion(
      series, "2026-02-01", "2026-03-01", "crypto", "USD",
    );
    // The carried-forward value (9000) must appear in the domain.
    expect(max).toBe(9000);
    expect(min).toBe(9000);
  });

  it("includes in-window entries when they exist alongside a pre-window seed", () => {
    const series: CostBasisSeriesPoint[] = [
      makeCostPoint({ date: "2026-01-01", cryptoCostUsd: 5000, cryptoCostEur: 0, stocksCostUsd: 0, stocksCostEur: 0, cashCostUsd: 0, cashCostEur: 0 }),
      makeCostPoint({ date: "2026-02-15", cryptoCostUsd: 7000, cryptoCostEur: 0, stocksCostUsd: 0, stocksCostEur: 0, cashCostUsd: 0, cashCostEur: 0 }),
    ];
    // Seed (at chartStart 2026-02-01) → carried-forward from 2026-01-01 → 5000.
    // In-window entry 2026-02-15 → 7000.
    const { min, max } = computeCostBasisYDomainExpansion(
      series, "2026-02-01", "2026-03-01", "crypto", "USD",
    );
    expect(min).toBe(5000);
    expect(max).toBe(7000);
  });

  it("returns Infinity/-Infinity sentinel for empty series", () => {
    const { min, max } = computeCostBasisYDomainExpansion(
      [], "2026-02-01", "2026-03-01", "total", "USD",
    );
    expect(min).toBe(Infinity);
    expect(max).toBe(-Infinity);
  });

  it("returns undefined sentinel when no entry is at-or-before chartStart", () => {
    const series: CostBasisSeriesPoint[] = [
      makeCostPoint({ date: "2026-05-01", cryptoCostUsd: 1000, cryptoCostEur: 0, stocksCostUsd: 0, stocksCostEur: 0, cashCostUsd: 0, cashCostEur: 0 }),
    ];
    // chartStart is before the only series entry → seed returns undefined.
    // In-window scan: no entry falls inside [2026-01-01, 2026-03-01].
    const { min, max } = computeCostBasisYDomainExpansion(
      series, "2026-01-01", "2026-03-01", "crypto", "USD",
    );
    // No candidates found — sentinels passed through unchanged.
    expect(min).toBe(Infinity);
    expect(max).toBe(-Infinity);
  });
});

// ── lookupCostValueAtOrBefore — direct export smoke tests ───────────────────

describe("lookupCostValueAtOrBefore — exported for testability", () => {
  const series: CostBasisSeriesPoint[] = [
    makeCostPoint({
      date: "2026-01-01",
      cryptoCostUsd: 1000, cryptoCostEur: 900,
      stocksCostUsd: 2000, stocksCostEur: 1800,
      cashCostUsd: 500, cashCostEur: 450,
    }),
  ];

  it("returns undefined when date is before all series entries", () => {
    const result = lookupCostValueAtOrBefore(series, "2025-12-31", "total", "USD");
    expect(result).toBeUndefined();
  });

  it("total, USD → sum of all three USD cost columns", () => {
    const result = lookupCostValueAtOrBefore(series, "2026-03-01", "total", "USD");
    expect(result).toBe(1000 + 2000 + 500);
  });

  it("investments, EUR → cryptoCostEur + stocksCostEur (not cash)", () => {
    const result = lookupCostValueAtOrBefore(series, "2026-03-01", "investments", "EUR");
    expect(result).toBe(900 + 1800);
  });
});
