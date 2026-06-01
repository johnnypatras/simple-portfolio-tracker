import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  deriveClassFx,
  getChangeForPeriod,
  getCryptoChangeForPeriod,
  getStockChangeForPeriod,
  getCashChangeForPeriod,
  getDepositsForPeriod,
} from "@/lib/portfolio/dashboard-changes";
import type { ChangeContext } from "@/lib/portfolio/dashboard-changes";
import type { PortfolioSnapshot } from "@/lib/types";

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
    const snap = makeSnapshot({ stocks_eur_denominated_value: 20000 });
    const noHome = deriveClassFx(45000, 53000, 45000, 50000, snap, "EUR");
    const withHome = deriveClassFx(45000, 53000, 45000, 50000, snap, "EUR", 15000, 20000);
    expect(Math.abs(withHome.fxAbs)).toBeLessThan(Math.abs(noHome.fxAbs));
    expect(Math.abs(withHome.fxAbs)).toBeGreaterThan(0);
  });

  it("USD user gets reversed FX direction", () => {
    const snap = makeSnapshot();
    const eurResult = deriveClassFx(45000, 53000, 45000, 50000, snap, "EUR");
    const usdResult = deriveClassFx(53000, 53000, 45000, 50000, snap, "USD");
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

  // Phase 4 contract: a snapshot with total_value_eur=0 (backdated lot before
  // any positions existed, no augmentation yet) returns { available: false }
  // — clean truth, no back-filled fakery.
  it("Phase 4: zero past value returns 'available: false' (clean truth, no back-fill)", () => {
    const snap = makeSnapshot({
      total_value_eur: 0,
      total_value_usd: 0,
      snapshot_date: "2021-01-14",
    });
    const ctx = makeCtx({ pastSnapshots: { "all": snap } });
    const result = getChangeForPeriod("all", ctx);
    expect(result.available).toBe(false);
    expect(result.percent).toBe(0);
    expect(result.valueChange).toBe(0);
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

  it("returns 'available: false' when snapshot crypto value is zero", () => {
    const snap = makeSnapshot({ crypto_value_usd: 0 });
    const ctx = makeCtx({ pastSnapshots: { "30d": snap } });
    const result = getCryptoChangeForPeriod("30d", ctx);
    expect(result.available).toBe(false);
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
    expect(typeof result.fxPercent).toBe("number");
  });

  it("returns 'available: false' when snapshot stocks value is zero", () => {
    const snap = makeSnapshot({ stocks_value_usd: 0 });
    const ctx = makeCtx({ pastSnapshots: { "30d": snap } });
    const result = getStockChangeForPeriod("30d", ctx);
    expect(result.available).toBe(false);
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

  it("returns 'available: false' when snapshot cash value is zero", () => {
    const snap = makeSnapshot({ cash_value_usd: 0 });
    const ctx = makeCtx({ pastSnapshots: { "30d": snap } });
    const result = getCashChangeForPeriod("30d", ctx);
    expect(result.available).toBe(false);
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
    expect(result.breakdown).toHaveLength(2);
    expect(result.total).toBeGreaterThan(0);
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

  it("3d period includes flows in the last 3 days, excludes older", () => {
    const ctx = makeCtx({
      primaryCurrency: "USD",
      totalValueUsd: 100000,
      cashFlows: [
        { date: "2026-06-13", amount_usd: 100, entity_name: "Recent" },
        { date: "2026-06-10", amount_usd: 999, entity_name: "Older" },
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
        { date: "2026-04-01", amount_usd: 200, entity_name: "Within90d" },
        { date: "2025-12-01", amount_usd: 999, entity_name: "Outside90d" },
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

  // M1: synthetic benchmark cash flows must be filtered before aggregation
  // (buildBenchmarkCashFlows emits synthetic=true rows as S&P seeds — they
  // must never surface in the deposit tooltip as "Unknown" entries).
  it("filters synthetic flows out of deposit aggregation (M1)", () => {
    const ctx = makeCtx({
      primaryCurrency: "USD",
      totalValueUsd: 100000,
      cashFlows: [
        { date: PINNED_TODAY, amount_usd: 1000, entity_name: "Alpha Bank" },
        { date: PINNED_TODAY, amount_usd: 500, entity_name: "DEGIRO" },
        { date: PINNED_TODAY, amount_usd: 25000, asset_class: "crypto", synthetic: true },
      ],
    });
    const result = getDepositsForPeriod("24h", ctx);
    expect(result.total).toBeCloseTo(1500, 0);
    expect(result.breakdown).toHaveLength(2);
    expect(result.breakdown.map(b => b.name).sort()).toEqual(["Alpha Bank", "DEGIRO"]);
    expect(result.breakdown.find(b => b.name === "Unknown")).toBeUndefined();
  });

  it("synthetic filter survives class filtering (synthetic crypto flow doesn't pollute crypto deposits)", () => {
    const ctx = makeCtx({
      primaryCurrency: "USD",
      totalValueUsd: 100000,
      cashFlows: [
        { date: PINNED_TODAY, amount_usd: 800, asset_class: "crypto", entity_name: "Binance" },
        { date: PINNED_TODAY, amount_usd: 50000, asset_class: "crypto", synthetic: true },
      ],
    });
    const cryptoResult = getDepositsForPeriod("24h", ctx, "crypto");
    expect(cryptoResult.total).toBeCloseTo(800, 0);
    expect(cryptoResult.breakdown).toHaveLength(1);
    expect(cryptoResult.breakdown[0].name).toBe("Binance");
  });

  it("explicit synthetic: false flows pass through (parity with omitted flag)", () => {
    const ctx = makeCtx({
      primaryCurrency: "USD",
      totalValueUsd: 100000,
      cashFlows: [
        { date: PINNED_TODAY, amount_usd: 1000, asset_class: "cash", entity_name: "Real", synthetic: false },
        { date: PINNED_TODAY, amount_usd: 500, asset_class: "cash", entity_name: "Real2" },
        { date: PINNED_TODAY, amount_usd: 25000, asset_class: "cash", synthetic: true },
      ],
    });
    const result = getDepositsForPeriod("24h", ctx);
    expect(result.total).toBeCloseTo(1500, 0);
    expect(result.breakdown).toHaveLength(2);
    expect(result.breakdown.map((b) => b.name).sort()).toEqual(["Real", "Real2"]);
    expect(result.breakdown.find((b) => b.name === "Unknown")).toBeUndefined();
  });
});

// ── Edge case: very small period change ──────────────────

describe("getChangeForPeriod — sub-0.01% change", () => {
  it("computes tiny percentage without rounding to zero", () => {
    const snap = makeSnapshot({ total_value_eur: 1000000, total_value_usd: 1180000 });
    const ctx = makeCtx({
      totalValue: 1000050,
      totalValueUsd: 1180059,
      totalValueEur: 1000050,
      pastSnapshots: { "30d": snap },
    });
    const result = getChangeForPeriod("30d", ctx);
    expect(result.available).toBe(true);
    expect(result.percent).toBeCloseTo(0.005, 3);
    expect(result.valueChange).toBeCloseTo(50, 0);
    expect(result.percent).not.toBe(0);
  });
});

// ── Edge case: missing EUR snapshot value ─────────────────

describe("getChangeForPeriod — null EUR in snapshot", () => {
  it("returns unavailable when primary currency value is null", () => {
    const snap = makeSnapshot({
      total_value_usd: 100000,
      total_value_eur: null as unknown as number,
    });
    const ctx = makeCtx({
      primaryCurrency: "EUR",
      pastSnapshots: { "7d": snap },
    });
    const result = getChangeForPeriod("7d", ctx);
    expect(result.available).toBe(false);
    expect(Number.isNaN(result.percent)).toBe(false);
    expect(Number.isNaN(result.fxPercent)).toBe(false);
  });

  it("FX decomposition handles null other-currency snapshot gracefully", () => {
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
    });
    const result = getChangeForPeriod("30d", ctx);
    expect(result.available).toBe(true);
    expect(result.percent).toBeCloseTo(12.5, 1);
    expect(result.fxPercent).toBe(0);
    expect(Number.isNaN(result.fxValueChange)).toBe(false);
  });
});
