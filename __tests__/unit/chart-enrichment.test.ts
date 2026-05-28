import { describe, it, expect } from "vitest";
import { enrichChartData } from "@/lib/portfolio/chart-enrichment";
import type {
  ChartPoint,
  EnrichChartDataInput,
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

// ── Tests ──────────────────────────────────────────────────

describe("enrichChartData — literal-truth contract (Phase 4)", () => {
  /**
   * Phase 4 contract: the portfolio line is the literal truth from the
   * snapshot (already augmented upstream by historical-price/manual-NAV).
   * The S&P benchmark seeds against that truth at chartStart and diverges.
   */
  it("seeds S&P at the raw firstSliceVal (not at a back-filled value)", () => {
    // Single-point chart with portfolio value $1000 at chartStart and a real
    // cash flow on the same day. After seeding, the S&P benchmark must equal
    // the portfolio value at chartStart so both lines start at $1000.
    const points = [
      makePoint({ date: "2026-01-01", value: 1000, valueUsd: 1000 }),
    ];
    const cashFlows: CashFlowEvent[] = [
      { date: "2026-01-01", amount_usd: 1000, asset_class: "cash" },
    ];
    const result = enrichChartData(
      makeInput({
        points,
        viewMode: "total",
        primaryCurrency: "USD",
        sp500History: [{ date: "2026-01-01", close: 5000 }],
        cashFlows,
      }),
    );
    // Seed: firstSliceVal=1000, fxRatio=1, seedUsd=1000, neededUnits=0.2.
    // unitsAtChartStart already = 1000/5000 = 0.2 (cash flow on chartStart),
    // so seedDelta = 0 and S&P value = 0.2 × 5000 = 1000.
    expect(result[0].sp500Value).toBeCloseTo(1000, 0);
    // Portfolio line is the literal raw value — `value` field IS the truth.
    expect(result[0].value).toBe(1000);
  });

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
  it("zero portfolio at chartStart keeps S&P at zero (correct benchmark)", () => {
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
