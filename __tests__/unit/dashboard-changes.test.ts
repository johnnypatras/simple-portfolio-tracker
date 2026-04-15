import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  deriveClassFx,
  getChangeForPeriod,
  getCryptoChangeForPeriod,
  getStockChangeForPeriod,
  getCashChangeForPeriod,
  getDepositsForPeriod,
  getCumDeltaAtDate,
  getCumDeltaFinal,
} from "@/lib/portfolio/dashboard-changes";
import type { ChangeContext } from "@/lib/portfolio/dashboard-changes";
import type { PortfolioSnapshot, AdjustmentDelta } from "@/lib/types";

// ── Test helpers ───────────────────────────────────────────

function makeSnapshot(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    id: "snap-1",
    user_id: "u1",
    snapshot_date: "2026-01-01",
    total_value_usd: 100000,
    total_value_eur: 85000,
    crypto_value_usd: 30000,
    stocks_value_usd: 50000,
    cash_value_usd: 20000,
    crypto_value_eur: null,
    stocks_value_eur: null,
    cash_value_eur: null,
    stocks_eur_denominated_value: null,
    cash_eur_denominated_value: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ChangeContext> = {}): ChangeContext {
  return {
    primaryCurrency: "EUR",
    totalValue: 90000,
    totalValueUsd: 106000,
    totalValueEur: 90000,
    totalValueChange24h: 500,
    change24hPercent: 0.56,
    fxChange24hPercent: 0.1,
    fxValueChange24h: 90,
    cryptoValue: 27000,
    cryptoValueUsd: 31800,
    cryptoValueEur: 27000,
    cryptoValueChange24h: 300,
    cryptoFxChange24hPercent: 0.05,
    cryptoFxValueChange24h: 13.5,
    stocksValue: 45000,
    stocksValueUsd: 53000,
    stocksValueEur: 45000,
    stocksValueChange24h: 150,
    stocksFxChange24hPercent: 0.08,
    stocksFxValueChange24h: 36,
    stocksHomeCurrencyEur: 15000,
    cashValue: 18000,
    cashValueUsd: 21200,
    cashValueEur: 18000,
    cashTotalValueChange24h: 50,
    cashTotalFxChange24hPercent: 0.02,
    cashTotalFxValueChange24h: 3.6,
    cashHomeCurrencyEur: 12000,
    cryptoChange24hPercent: 1.1,
    pastSnapshots: {},
    cashFlows: [],
    adjustmentDeltas: [],
    ...overrides,
  };
}

// ── deriveClassFx ──────────────────────────────────────────

describe("deriveClassFx", () => {
  it("computes FX impact from dual-currency returns", () => {
    // Snapshot: $100k USD / €85k EUR → implied rate 0.85
    // Past stocks: $50k USD → past EUR = $50k × 0.85 = €42,500
    // Current stocks: $53k USD / €45k EUR
    // USD return: (53000 - 50000) / 50000 = 6%
    // EUR return: (45000 - 42500) / 42500 = 5.88%
    // EUR user: FX = EUR return - USD return = 5.88% - 6% ≈ -0.12%
    const snap = makeSnapshot();
    const result = deriveClassFx(45000, 53000, 45000, 50000, snap, "EUR");
    expect(result.pastClassEur).toBeCloseTo(42500, 0);
    expect(result.fxPct).toBeCloseTo(-0.118, 1);
    // fxAbs should be small and negative
    expect(result.fxAbs).toBeLessThan(0);
  });

  it("returns zeros when snapshot totals are zero", () => {
    const snap = makeSnapshot({ total_value_usd: 0, total_value_eur: 0 });
    const result = deriveClassFx(45000, 53000, 45000, 50000, snap, "EUR");
    expect(result.fxPct).toBe(0);
    expect(result.fxAbs).toBe(0);
    expect(result.pastClassEur).toBeNull();
  });

  it("returns zeros when past class value is zero", () => {
    const snap = makeSnapshot();
    const result = deriveClassFx(45000, 53000, 45000, 0, snap, "EUR");
    expect(result.fxPct).toBe(0);
    expect(result.fxAbs).toBe(0);
  });

  it("scales fxAbs by FX-sensitive fraction when home currency data provided", () => {
    // stocks_eur_denominated_value = 20000 (EUR stocks in past snapshot)
    // pastClassEur = 50000 * 0.85 = 42500
    // pastFxFraction = 1 - 20000/42500 ≈ 0.529
    // currentHomeCurrencyEur = 15000, currentClassEur = 45000
    // currentFxFraction = 1 - 15000/45000 ≈ 0.667
    // avgFxFraction = (0.667 + 0.529) / 2 ≈ 0.598
    const snap = makeSnapshot({ stocks_eur_denominated_value: 20000 });
    const noHome = deriveClassFx(45000, 53000, 45000, 50000, snap, "EUR");
    const withHome = deriveClassFx(45000, 53000, 45000, 50000, snap, "EUR", 15000, 20000);
    // With home currency, fxAbs should be scaled down (multiplied by ~0.598)
    expect(Math.abs(withHome.fxAbs)).toBeLessThan(Math.abs(noHome.fxAbs));
    expect(Math.abs(withHome.fxAbs)).toBeGreaterThan(0);
  });

  it("USD user gets reversed FX direction", () => {
    const snap = makeSnapshot();
    const eurResult = deriveClassFx(45000, 53000, 45000, 50000, snap, "EUR");
    const usdResult = deriveClassFx(53000, 53000, 45000, 50000, snap, "USD");
    // FX direction should be opposite
    expect(Math.sign(eurResult.fxPct)).not.toBe(Math.sign(usdResult.fxPct));
  });
});

// ── getChangeForPeriod ─────────────────────────────────────

describe("getChangeForPeriod", () => {
  it("returns 24h values directly from context", () => {
    const ctx = makeCtx();
    const result = getChangeForPeriod("24h", ctx);
    expect(result.percent).toBe(0.56);
    expect(result.valueChange).toBe(500);
    expect(result.fxPercent).toBe(0.1);
    expect(result.fxValueChange).toBe(90);
    expect(result.available).toBe(true);
  });

  it("returns unavailable when no snapshot exists for period", () => {
    const ctx = makeCtx({ pastSnapshots: {} });
    const result = getChangeForPeriod("30d", ctx);
    expect(result.available).toBe(false);
    expect(result.percent).toBe(0);
  });

  it("computes change from snapshot for non-24h periods", () => {
    const snap = makeSnapshot({ total_value_eur: 80000, total_value_usd: 95000 });
    const ctx = makeCtx({ pastSnapshots: { "30d": snap } });
    const result = getChangeForPeriod("30d", ctx);
    expect(result.available).toBe(true);
    // EUR user: (90000 - 80000) / 80000 = 12.5%
    expect(result.percent).toBeCloseTo(12.5, 1);
    expect(result.valueChange).toBeCloseTo(10000, 0);
  });

  it("returns unavailable when past value is zero", () => {
    const snap = makeSnapshot({ total_value_eur: 0 });
    const ctx = makeCtx({ pastSnapshots: { "7d": snap } });
    const result = getChangeForPeriod("7d", ctx);
    expect(result.available).toBe(false);
  });
});

// ── getChangeForPeriod with adjustment deltas ──────────────

describe("getChangeForPeriod with adjustment deltas", () => {
  it("adjusts past value when delta exists before snapshot date", () => {
    const deltas = [makeDelta("2026-01-10", 78824, 67000)];
    const snap = makeSnapshot({ total_value_eur: 23000, total_value_usd: 27060 });
    const ctx = makeCtx({
      totalValue: 90000,
      pastSnapshots: { "30d": snap },
      adjustmentDeltas: deltas,
    });
    const result = getChangeForPeriod("30d", ctx);
    expect(result.available).toBe(true);
    // adjustedPast = 23000 + (67000 - 0) = 90000
    // (90000 - 90000) / 90000 = 0%
    expect(result.percent).toBeCloseTo(0, 0);
  });

  it("no adjustment when deltas are empty", () => {
    const snap = makeSnapshot({ total_value_eur: 80000, total_value_usd: 95000 });
    const ctx = makeCtx({ pastSnapshots: { "30d": snap }, adjustmentDeltas: [] });
    const result = getChangeForPeriod("30d", ctx);
    expect(result.percent).toBeCloseTo(12.5, 1);
  });

  it("no adjustment when adjustmentDeltas is empty", () => {
    const snap = makeSnapshot({ total_value_eur: 80000, total_value_usd: 95000 });
    const ctx = makeCtx({ pastSnapshots: { "30d": snap }, adjustmentDeltas: [] });
    const result = getChangeForPeriod("30d", ctx);
    expect(result.percent).toBeCloseTo(12.5, 1);
  });

  it("adjusts when all deltas are after snapshot date", () => {
    const deltas = [makeDelta("2026-06-01", 10000, 8500)];
    const snap = makeSnapshot({ total_value_eur: 80000, total_value_usd: 95000 });
    const ctx = makeCtx({ pastSnapshots: { "30d": snap }, adjustmentDeltas: deltas });
    const result = getChangeForPeriod("30d", ctx);
    // cumAtSnapshot = 0, final = 8500
    // adjustedPast = 80000 + (8500 - 0) = 88500
    // (90000 - 88500) / 88500 ≈ 1.69%
    expect(result.percent).toBeCloseTo(1.69, 0);
  });

  it("returns unavailable when adjusted past value <= 0", () => {
    const snap = makeSnapshot({ total_value_eur: 0 });
    const ctx = makeCtx({ pastSnapshots: { "7d": snap }, adjustmentDeltas: [] });
    const result = getChangeForPeriod("7d", ctx);
    expect(result.available).toBe(false);
  });

  it("24h period unaffected by deltas", () => {
    const deltas = [makeDelta("2026-01-01", 50000, 42500)];
    const ctx = makeCtx({ adjustmentDeltas: deltas });
    const result = getChangeForPeriod("24h", ctx);
    expect(result.percent).toBe(0.56);
  });

  it("adjusts FX decomposition too", () => {
    // With a large delta, both EUR and USD past values should be adjusted
    // so FX % isn't distorted
    const deltas = [makeDelta("2026-01-10", 50000, 42500)];
    const snap = makeSnapshot({ total_value_eur: 40000, total_value_usd: 47000 });
    const ctx = makeCtx({ pastSnapshots: { "30d": snap }, adjustmentDeltas: deltas });
    const result = getChangeForPeriod("30d", ctx);
    expect(result.available).toBe(true);
    // Compare with unadjusted: the FX % should differ when deltas are applied
    const noAdj = getChangeForPeriod("30d", makeCtx({ pastSnapshots: { "30d": snap }, adjustmentDeltas: [] }));
    // Both should have FX values, but they should differ due to adjustment
    expect(result.fxPercent).not.toBe(noAdj.fxPercent);
  });
});

// ── Per-class change functions ─────────────────────────────

describe("getCryptoChangeForPeriod", () => {
  it("returns 24h values from context", () => {
    const ctx = makeCtx();
    const result = getCryptoChangeForPeriod("24h", ctx);
    expect(result.percent).toBe(1.1);
    expect(result.valueChange).toBe(300);
    expect(result.available).toBe(true);
  });

  it("computes from snapshot for non-24h periods", () => {
    const snap = makeSnapshot({ crypto_value_usd: 28000 });
    const ctx = makeCtx({ pastSnapshots: { "30d": snap } });
    const result = getCryptoChangeForPeriod("30d", ctx);
    expect(result.available).toBe(true);
    expect(result.valueChange).not.toBe(0);
  });
});

describe("getStockChangeForPeriod", () => {
  it("returns 24h values from context", () => {
    const ctx = makeCtx();
    const result = getStockChangeForPeriod("24h", ctx);
    expect(result.valueChange).toBe(150);
    expect(result.available).toBe(true);
  });

  it("passes home currency data for FX-sensitive fraction", () => {
    const snap = makeSnapshot({
      stocks_value_usd: 48000,
      stocks_eur_denominated_value: 18000,
    });
    const ctx = makeCtx({ pastSnapshots: { "30d": snap } });
    const result = getStockChangeForPeriod("30d", ctx);
    expect(result.available).toBe(true);
    // FX should be scaled by home currency fraction
    expect(typeof result.fxPercent).toBe("number");
  });
});

describe("getCashChangeForPeriod", () => {
  it("returns 24h values from context", () => {
    const ctx = makeCtx();
    const result = getCashChangeForPeriod("24h", ctx);
    expect(result.valueChange).toBe(50);
    expect(result.available).toBe(true);
  });

  it("returns unavailable when no snapshot", () => {
    const ctx = makeCtx();
    const result = getCashChangeForPeriod("7d", ctx);
    expect(result.available).toBe(false);
  });
});

// ── Per-class adjustment delta tests ───────────────────────

function makeClassDelta(date: string, opts: {
  cryptoUsd?: number; cryptoEur?: number;
  stocksUsd?: number; stocksEur?: number;
  cashUsd?: number; cashEur?: number;
}): AdjustmentDelta {
  return {
    date,
    cumulative_usd: (opts.cryptoUsd ?? 0) + (opts.stocksUsd ?? 0) + (opts.cashUsd ?? 0),
    cumulative_eur: (opts.cryptoEur ?? 0) + (opts.stocksEur ?? 0) + (opts.cashEur ?? 0),
    crypto_cumulative_usd: opts.cryptoUsd ?? 0,
    crypto_cumulative_eur: opts.cryptoEur ?? 0,
    stocks_cumulative_usd: opts.stocksUsd ?? 0,
    stocks_cumulative_eur: opts.stocksEur ?? 0,
    cash_cumulative_usd: opts.cashUsd ?? 0,
    cash_cumulative_eur: opts.cashEur ?? 0,
  };
}

describe("getCryptoChangeForPeriod with adjustment deltas", () => {
  it("adjusts past USD before deriveClassFx", () => {
    const deltas = [makeClassDelta("2026-01-10", { cryptoUsd: 20000, cryptoEur: 17000 })];
    const snap = makeSnapshot({ crypto_value_usd: 10000 });
    const ctx = makeCtx({ pastSnapshots: { "30d": snap }, adjustmentDeltas: deltas });
    const result = getCryptoChangeForPeriod("30d", ctx);
    expect(result.available).toBe(true);
    // adjustedPastUsd = 10000 + (20000 - 0) = 30000 (close to current 31800)
    // Raw would be 10000 → 27000 = huge %. Adjusted should be small.
    expect(Math.abs(result.percent)).toBeLessThan(20);
  });

  it("no adjustment when deltas are empty", () => {
    const snap = makeSnapshot({ crypto_value_usd: 28000 });
    const ctx = makeCtx({ pastSnapshots: { "30d": snap }, adjustmentDeltas: [] });
    const result = getCryptoChangeForPeriod("30d", ctx);
    expect(result.available).toBe(true);
    // Should match raw behavior
    expect(result.valueChange).not.toBe(0);
  });

  it("24h unaffected by deltas", () => {
    const deltas = [makeClassDelta("2026-01-01", { cryptoUsd: 50000, cryptoEur: 42500 })];
    const ctx = makeCtx({ adjustmentDeltas: deltas });
    const result = getCryptoChangeForPeriod("24h", ctx);
    expect(result.percent).toBe(1.1);
  });
});

describe("getStockChangeForPeriod with adjustment deltas", () => {
  it("adjusts past USD before deriveClassFx", () => {
    const deltas = [makeClassDelta("2026-01-10", { stocksUsd: 30000, stocksEur: 25500 })];
    const snap = makeSnapshot({ stocks_value_usd: 20000, stocks_eur_denominated_value: 8000 });
    const ctx = makeCtx({ pastSnapshots: { "30d": snap }, adjustmentDeltas: deltas });
    const result = getStockChangeForPeriod("30d", ctx);
    expect(result.available).toBe(true);
    // adjustedPastUsd = 20000 + (30000 - 0) = 50000 (close to current 53000)
    expect(Math.abs(result.percent)).toBeLessThan(20);
  });
});

describe("getCashChangeForPeriod with adjustment deltas", () => {
  it("adjusts past USD before deriveClassFx", () => {
    const deltas = [makeClassDelta("2026-01-10", { cashUsd: 15000, cashEur: 12750 })];
    const snap = makeSnapshot({ cash_value_usd: 5000 });
    const ctx = makeCtx({ pastSnapshots: { "30d": snap }, adjustmentDeltas: deltas });
    const result = getCashChangeForPeriod("30d", ctx);
    expect(result.available).toBe(true);
    // adjustedPastUsd = 5000 + (15000 - 0) = 20000 (close to current 21200)
    expect(Math.abs(result.percent)).toBeLessThan(20);
  });
});

// ── getDepositsForPeriod ───────────────────────────────────

const PINNED_NOW = "2026-06-15T12:00:00Z";
const PINNED_TODAY = "2026-06-15";

describe("getDepositsForPeriod", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PINNED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sums deposits within the period window", () => {
    const ctx = makeCtx({
      cashFlows: [
        { date: PINNED_TODAY, amount_usd: 1000, entity_name: "Alpha Bank" },
        { date: PINNED_TODAY, amount_usd: 500, entity_name: "DEGIRO" },
        { date: "2020-01-01", amount_usd: 9999, entity_name: "Old" }, // outside window
      ],
    });
    const result = getDepositsForPeriod("24h", ctx);
    // EUR user: uses fxMul = 90000/106000 ≈ 0.849
    expect(result.breakdown).toHaveLength(2);
    expect(result.total).toBeGreaterThan(0);
    // Old deposit should be excluded
    expect(result.breakdown.find(b => b.name === "Old")).toBeUndefined();
  });

  it("uses amount_eur when available for EUR users", () => {
    const ctx = makeCtx({
      primaryCurrency: "EUR",
      cashFlows: [
        { date: PINNED_TODAY, amount_usd: 1180, amount_eur: 1000, entity_name: "Bank" },
      ],
    });
    const result = getDepositsForPeriod("24h", ctx);
    // Should use amount_eur=1000 directly, not amount_usd * fxMul
    expect(result.total).toBeCloseTo(1000, 0);
  });

  it("filters by asset class when specified", () => {
    const ctx = makeCtx({
      primaryCurrency: "USD",
      totalValueUsd: 100000,
      cashFlows: [
        { date: PINNED_TODAY, amount_usd: 500, asset_class: "crypto", entity_name: "Binance" },
        { date: PINNED_TODAY, amount_usd: 300, asset_class: "stocks", entity_name: "DEGIRO" },
      ],
    });
    const cryptoResult = getDepositsForPeriod("24h", ctx, "crypto");
    expect(cryptoResult.total).toBeCloseTo(500, 0);
    expect(cryptoResult.breakdown).toHaveLength(1);
    expect(cryptoResult.breakdown[0].name).toBe("Binance");
  });

  it("groups deposits by entity name", () => {
    const ctx = makeCtx({
      primaryCurrency: "USD",
      totalValueUsd: 100000,
      cashFlows: [
        { date: PINNED_TODAY, amount_usd: 200, entity_name: "Bank A" },
        { date: PINNED_TODAY, amount_usd: 300, entity_name: "Bank A" },
        { date: PINNED_TODAY, amount_usd: 100, entity_name: "Bank B" },
      ],
    });
    const result = getDepositsForPeriod("24h", ctx);
    expect(result.total).toBeCloseTo(600, 0);
    expect(result.breakdown).toHaveLength(2);
    // Sorted by absolute value descending
    expect(result.breakdown[0].name).toBe("Bank A");
    expect(result.breakdown[0].value).toBeCloseTo(500, 0);
  });

  it("filters out tiny amounts (< 0.5)", () => {
    const ctx = makeCtx({
      primaryCurrency: "USD",
      totalValueUsd: 100000,
      cashFlows: [
        { date: PINNED_TODAY, amount_usd: 0.3, entity_name: "Dust" },
        { date: PINNED_TODAY, amount_usd: 100, entity_name: "Real" },
      ],
    });
    const result = getDepositsForPeriod("24h", ctx);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].name).toBe("Real");
  });

  it("returns empty result when no cash flows match", () => {
    const ctx = makeCtx({ cashFlows: [] });
    const result = getDepositsForPeriod("30d", ctx);
    expect(result.total).toBe(0);
    expect(result.breakdown).toHaveLength(0);
  });

  // ── Newly added ChangePeriod values: 3d, 90d, all ───────────
  it("3d period includes flows in the last 3 days, excludes older", () => {
    const ctx = makeCtx({
      primaryCurrency: "USD",
      totalValueUsd: 100000,
      cashFlows: [
        { date: "2026-06-13", amount_usd: 100, entity_name: "Recent" }, // within 3d
        { date: "2026-06-10", amount_usd: 999, entity_name: "Older" }, // 5 days ago — outside
      ],
    });
    const result = getDepositsForPeriod("3d", ctx);
    expect(result.total).toBeCloseTo(100, 0);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].name).toBe("Recent");
  });

  it("90d period includes flows in the last 90 days, excludes older", () => {
    const ctx = makeCtx({
      primaryCurrency: "USD",
      totalValueUsd: 100000,
      cashFlows: [
        { date: "2026-04-01", amount_usd: 200, entity_name: "Within90d" }, // ~75 days ago
        { date: "2025-12-01", amount_usd: 999, entity_name: "Outside90d" }, // ~196 days ago
      ],
    });
    const result = getDepositsForPeriod("90d", ctx);
    expect(result.total).toBeCloseTo(200, 0);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].name).toBe("Within90d");
  });

  it("all period includes flows from any historical date", () => {
    const ctx = makeCtx({
      primaryCurrency: "USD",
      totalValueUsd: 100000,
      cashFlows: [
        { date: "2020-01-01", amount_usd: 50, entity_name: "Old" },
        { date: "2010-06-15", amount_usd: 30, entity_name: "Older" },
        { date: PINNED_TODAY, amount_usd: 10, entity_name: "Today" },
      ],
    });
    const result = getDepositsForPeriod("all", ctx);
    expect(result.total).toBeCloseTo(90, 0);
    expect(result.breakdown).toHaveLength(3);
  });
});

// ── Delta helpers ──────────────────────────────────────────

function makeDelta(date: string, cumUsd: number, cumEur: number): AdjustmentDelta {
  return {
    date, cumulative_usd: cumUsd, cumulative_eur: cumEur,
    crypto_cumulative_usd: 0, crypto_cumulative_eur: 0,
    stocks_cumulative_usd: 0, stocks_cumulative_eur: 0,
    cash_cumulative_usd: 0, cash_cumulative_eur: 0,
  };
}

describe("getCumDeltaAtDate", () => {
  it("returns 0 for empty deltas", () => {
    expect(getCumDeltaAtDate("2026-01-15", [], "EUR")).toBe(0);
  });

  it("returns cumulative delta at exact date", () => {
    const deltas = [makeDelta("2026-01-10", 1000, 850)];
    expect(getCumDeltaAtDate("2026-01-10", deltas, "EUR")).toBe(850);
  });

  it("forward-fills to last delta before date", () => {
    const deltas = [
      makeDelta("2026-01-05", 500, 425),
      makeDelta("2026-01-15", 1500, 1275),
    ];
    expect(getCumDeltaAtDate("2026-01-10", deltas, "EUR")).toBe(425);
  });

  it("returns 0 when date is before all deltas", () => {
    const deltas = [makeDelta("2026-02-01", 1000, 850)];
    expect(getCumDeltaAtDate("2026-01-01", deltas, "EUR")).toBe(0);
  });

  it("returns final delta when date is after all deltas", () => {
    const deltas = [makeDelta("2026-01-01", 1000, 850)];
    expect(getCumDeltaAtDate("2026-12-31", deltas, "EUR")).toBe(850);
  });

  it("returns class-specific delta when assetClass provided", () => {
    const deltas: AdjustmentDelta[] = [{
      date: "2026-01-10",
      cumulative_usd: 3000, cumulative_eur: 2550,
      crypto_cumulative_usd: 1000, crypto_cumulative_eur: 850,
      stocks_cumulative_usd: 2000, stocks_cumulative_eur: 1700,
      cash_cumulative_usd: 0, cash_cumulative_eur: 0,
    }];
    expect(getCumDeltaAtDate("2026-01-10", deltas, "EUR", "crypto")).toBe(850);
    expect(getCumDeltaAtDate("2026-01-10", deltas, "USD", "stocks")).toBe(2000);
  });

  it("uses USD currency correctly", () => {
    const deltas = [makeDelta("2026-01-10", 1000, 850)];
    expect(getCumDeltaAtDate("2026-01-10", deltas, "USD")).toBe(1000);
  });
});

// ── Edge case: negative adjusted past value ─────────────

describe("getChangeForPeriod — negative adjusted past value", () => {
  it("returns unavailable when adjustment makes past value negative", () => {
    // snapshot total_value_eur: 80000, adjustment cumDelta = -100000
    // pastValue = 80000 + (-100000 - 0) = -20000 → guard returns available: false
    const deltas = [makeDelta("2026-06-01", -117647, -100000)];
    const snap = makeSnapshot({ total_value_eur: 80000, total_value_usd: 94000 });
    const ctx = makeCtx({
      totalValue: 90000,
      pastSnapshots: { "30d": snap },
      adjustmentDeltas: deltas,
    });
    const result = getChangeForPeriod("30d", ctx);
    // pastValue = 80000 + (-100000 - 0) = -20000 → <= 0 → unavailable
    expect(result.available).toBe(false);
    expect(result.percent).toBe(0);
    expect(result.valueChange).toBe(0);
    expect(Number.isNaN(result.percent)).toBe(false);
  });
});

// ── Edge case: very small period change ──────────────────

describe("getChangeForPeriod — sub-0.01% change", () => {
  it("computes tiny percentage without rounding to zero", () => {
    // ~1,000,000 EUR → 1,000,050 EUR = +0.005%
    const snap = makeSnapshot({ total_value_eur: 1000000, total_value_usd: 1180000 });
    const ctx = makeCtx({
      totalValue: 1000050,
      totalValueUsd: 1180059,
      totalValueEur: 1000050,
      pastSnapshots: { "30d": snap },
      adjustmentDeltas: [],
    });
    const result = getChangeForPeriod("30d", ctx);
    expect(result.available).toBe(true);
    // (1000050 - 1000000) / 1000000 × 100 = 0.005%
    expect(result.percent).toBeCloseTo(0.005, 3);
    expect(result.valueChange).toBeCloseTo(50, 0);
    expect(result.percent).not.toBe(0);
  });
});

// ── Edge case: missing EUR snapshot value ─────────────────

describe("getChangeForPeriod — null EUR in snapshot", () => {
  it("returns unavailable when primary currency value is null", () => {
    // EUR user, but snapshot has total_value_eur: null (old snapshot)
    // rawPastValue = snapshot[valueKey] ?? 0 = 0 → pastValue = 0 → unavailable
    const snap = makeSnapshot({
      total_value_usd: 100000,
      total_value_eur: null as unknown as number,
    });
    const ctx = makeCtx({
      primaryCurrency: "EUR",
      pastSnapshots: { "7d": snap },
      adjustmentDeltas: [],
    });
    const result = getChangeForPeriod("7d", ctx);
    expect(result.available).toBe(false);
    expect(Number.isNaN(result.percent)).toBe(false);
    expect(Number.isNaN(result.fxPercent)).toBe(false);
  });

  it("FX decomposition handles null other-currency snapshot gracefully", () => {
    // USD user, but snapshot has total_value_eur: null → FX decomposition gets pastOther=0
    const snap = makeSnapshot({
      total_value_usd: 80000,
      total_value_eur: null as unknown as number,
    });
    const ctx = makeCtx({
      primaryCurrency: "USD",
      totalValue: 90000,
      totalValueUsd: 90000,
      totalValueEur: 76500,
      pastSnapshots: { "30d": snap },
      adjustmentDeltas: [],
    });
    const result = getChangeForPeriod("30d", ctx);
    expect(result.available).toBe(true);
    // Primary return works: (90000 - 80000) / 80000 = 12.5%
    expect(result.percent).toBeCloseTo(12.5, 1);
    // FX: pastOther = (null ?? 0) + 0 = 0 → fxPct stays 0
    expect(result.fxPercent).toBe(0);
    expect(Number.isNaN(result.fxValueChange)).toBe(false);
  });
});

describe("getCumDeltaFinal", () => {
  it("returns 0 for empty deltas", () => {
    expect(getCumDeltaFinal([], "EUR")).toBe(0);
  });

  it("returns last delta value", () => {
    const deltas = [
      makeDelta("2026-01-01", 500, 425),
      makeDelta("2026-01-15", 1500, 1275),
    ];
    expect(getCumDeltaFinal(deltas, "EUR")).toBe(1275);
    expect(getCumDeltaFinal(deltas, "USD")).toBe(1500);
  });

  it("returns class-specific final delta", () => {
    const deltas: AdjustmentDelta[] = [{
      date: "2026-01-10",
      cumulative_usd: 3000, cumulative_eur: 2550,
      crypto_cumulative_usd: 1000, crypto_cumulative_eur: 850,
      stocks_cumulative_usd: 2000, stocks_cumulative_eur: 1700,
      cash_cumulative_usd: 0, cash_cumulative_eur: 0,
    }];
    expect(getCumDeltaFinal(deltas, "EUR", "crypto")).toBe(850);
  });
});
