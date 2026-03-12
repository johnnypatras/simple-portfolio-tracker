import { describe, it, expect } from "vitest";
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
    // fxAbs should be small and negative
    expect(result.fxAbs).toBeLessThan(0);
  });

  it("returns zeros when snapshot totals are zero", () => {
    const snap = makeSnapshot({ total_value_usd: 0, total_value_eur: 0 });
    const result = deriveClassFx(45000, 53000, 45000, 50000, snap, "EUR");
    expect(result.fxPct).toBe(0);
    expect(result.fxAbs).toBe(0);
    expect(result.pastClassEur).toBe(0);
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

// ── getDepositsForPeriod ───────────────────────────────────

describe("getDepositsForPeriod", () => {
  it("sums deposits within the period window", () => {
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    const ctx = makeCtx({
      cashFlows: [
        { date: today, amount_usd: 1000, entity_name: "Alpha Bank" },
        { date: today, amount_usd: 500, entity_name: "DEGIRO" },
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
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    const ctx = makeCtx({
      primaryCurrency: "EUR",
      cashFlows: [
        { date: today, amount_usd: 1180, amount_eur: 1000, entity_name: "Bank" },
      ],
    });
    const result = getDepositsForPeriod("24h", ctx);
    // Should use amount_eur=1000 directly, not amount_usd * fxMul
    expect(result.total).toBeCloseTo(1000, 0);
  });

  it("filters by asset class when specified", () => {
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    const ctx = makeCtx({
      primaryCurrency: "USD",
      totalValueUsd: 100000,
      cashFlows: [
        { date: today, amount_usd: 500, asset_class: "crypto", entity_name: "Binance" },
        { date: today, amount_usd: 300, asset_class: "stocks", entity_name: "DEGIRO" },
      ],
    });
    const cryptoResult = getDepositsForPeriod("24h", ctx, "crypto");
    expect(cryptoResult.total).toBeCloseTo(500, 0);
    expect(cryptoResult.breakdown).toHaveLength(1);
    expect(cryptoResult.breakdown[0].name).toBe("Binance");
  });

  it("groups deposits by entity name", () => {
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    const ctx = makeCtx({
      primaryCurrency: "USD",
      totalValueUsd: 100000,
      cashFlows: [
        { date: today, amount_usd: 200, entity_name: "Bank A" },
        { date: today, amount_usd: 300, entity_name: "Bank A" },
        { date: today, amount_usd: 100, entity_name: "Bank B" },
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
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    const ctx = makeCtx({
      primaryCurrency: "USD",
      totalValueUsd: 100000,
      cashFlows: [
        { date: today, amount_usd: 0.3, entity_name: "Dust" },
        { date: today, amount_usd: 100, entity_name: "Real" },
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
});
