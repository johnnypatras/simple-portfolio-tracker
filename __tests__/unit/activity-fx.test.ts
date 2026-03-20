import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for computeActivityFx and computeActivityFxWithConversion
 * from src/lib/activity-fx.ts.
 *
 * computeActivityFx — synchronous, uses pre-computed USD/EUR values.
 * computeActivityFxWithConversion — async, calls toUsdAndEur() via dynamic
 *   import of "@/lib/actions/activity-log". Falls back to "pending" status
 *   when toUsdAndEur throws.
 *
 * Mock strategy:
 * - "@/lib/actions/activity-log" is mocked so toUsdAndEur can be controlled.
 *   Vitest intercepts dynamic imports through the same module registry as
 *   static imports, so vi.mock() covers the `await import(...)` in activity-fx.
 * - "@/lib/cashflow" is mocked so classifyAssetClass returns a predictable value.
 */

// ─── Hoisted mock state ──────────────────────────────────────────────────────

const hoisted = vi.hoisted(() => ({
  toUsdAndEur: vi.fn<() => Promise<{ usd: number; eur: number }>>(),
  classifyAssetClass: vi.fn<() => string | null>(),
}));

vi.mock("@/lib/actions/activity-log", () => ({
  toUsdAndEur: hoisted.toUsdAndEur,
}));

vi.mock("@/lib/cashflow", () => ({
  classifyAssetClass: hoisted.classifyAssetClass,
}));

// ─── Import after mocks ──────────────────────────────────────────────────────

import {
  computeActivityFx,
  computeActivityFxWithConversion,
  emptyFx,
} from "@/lib/activity-fx";

// ─── Tests: computeActivityFx (sync) ─────────────────────────────────────────

describe("computeActivityFx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.classifyAssetClass.mockReturnValue("crypto");
  });

  describe("non-adjustment mode", () => {
    it("fills cashflow fields and sets cashflowStatus=complete", () => {
      const result = computeActivityFx({
        valUsd: 1000,
        valEur: 920,
        isAdjustment: false,
        entityType: "crypto_position",
      });

      expect(result.cashflowUsd).toBe(1000);
      expect(result.cashflowEur).toBe(920);
      expect(result.cashflowStatus).toBe("complete");
      expect(result.cashflowAssetClass).toBe("crypto");
    });

    it("leaves delta fields null in non-adjustment mode", () => {
      const result = computeActivityFx({
        valUsd: 500,
        valEur: 460,
        entityType: "crypto_position",
      });

      expect(result.deltaUsd).toBeNull();
      expect(result.deltaEur).toBeNull();
      expect(result.deltaStatus).toBeNull();
    });
  });

  describe("adjustment mode", () => {
    it("fills delta fields and sets deltaStatus=complete", () => {
      const result = computeActivityFx({
        valUsd: 2000,
        valEur: 1840,
        isAdjustment: true,
        entityType: "stock_position",
      });

      expect(result.deltaUsd).toBe(2000);
      expect(result.deltaEur).toBe(1840);
      expect(result.deltaStatus).toBe("complete");
    });

    it("leaves cashflow fields null in adjustment mode", () => {
      const result = computeActivityFx({
        valUsd: 2000,
        valEur: 1840,
        isAdjustment: true,
        entityType: "stock_position",
      });

      expect(result.cashflowUsd).toBeNull();
      expect(result.cashflowEur).toBeNull();
      expect(result.cashflowStatus).toBeNull();
      expect(result.cashflowAssetClass).toBeNull();
    });
  });
});

// ─── Tests: computeActivityFxWithConversion (async) ──────────────────────────

describe("computeActivityFxWithConversion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.classifyAssetClass.mockReturnValue("stocks");
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe("happy path — non-adjustment", () => {
    it("fills cashflow fields with converted USD/EUR values", async () => {
      hoisted.toUsdAndEur.mockResolvedValue({ usd: 1500, eur: 1380 });

      const result = await computeActivityFxWithConversion({
        valueNative: 1400,
        currency: "GBP",
        entityType: "stock_position",
      });

      expect(result.cashflowUsd).toBe(1500);
      expect(result.cashflowEur).toBe(1380);
      expect(result.cashflowStatus).toBe("complete");
      expect(result.cashflowAssetClass).toBe("stocks");
    });

    it("leaves delta fields null in non-adjustment mode", async () => {
      hoisted.toUsdAndEur.mockResolvedValue({ usd: 1500, eur: 1380 });

      const result = await computeActivityFxWithConversion({
        valueNative: 1400,
        currency: "GBP",
        entityType: "stock_position",
      });

      expect(result.deltaUsd).toBeNull();
      expect(result.deltaEur).toBeNull();
      expect(result.deltaStatus).toBeNull();
    });
  });

  describe("happy path — adjustment", () => {
    it("fills delta fields with converted USD/EUR values", async () => {
      hoisted.toUsdAndEur.mockResolvedValue({ usd: 3000, eur: 2760 });

      const result = await computeActivityFxWithConversion({
        valueNative: 2800,
        currency: "GBP",
        isAdjustment: true,
        entityType: "stock_position",
      });

      expect(result.deltaUsd).toBe(3000);
      expect(result.deltaEur).toBe(2760);
      expect(result.deltaStatus).toBe("complete");
    });

    it("leaves cashflow fields null in adjustment mode", async () => {
      hoisted.toUsdAndEur.mockResolvedValue({ usd: 3000, eur: 2760 });

      const result = await computeActivityFxWithConversion({
        valueNative: 2800,
        currency: "GBP",
        isAdjustment: true,
        entityType: "stock_position",
      });

      expect(result.cashflowUsd).toBeNull();
      expect(result.cashflowEur).toBeNull();
      expect(result.cashflowStatus).toBeNull();
      expect(result.cashflowAssetClass).toBeNull();
    });
  });

  // ── FX failure path ────────────────────────────────────────────────────────

  describe("FX failure — non-adjustment", () => {
    it("returns cashflowStatus=pending when toUsdAndEur throws", async () => {
      hoisted.toUsdAndEur.mockRejectedValue(new Error("FX API unavailable"));

      const result = await computeActivityFxWithConversion({
        valueNative: 500,
        currency: "GBP",
        entityType: "stock_position",
      });

      expect(result.cashflowStatus).toBe("pending");
    });

    it("returns all numeric fields as null when toUsdAndEur throws (non-adjustment)", async () => {
      hoisted.toUsdAndEur.mockRejectedValue(new Error("FX API unavailable"));

      const result = await computeActivityFxWithConversion({
        valueNative: 500,
        currency: "GBP",
        entityType: "stock_position",
      });

      expect(result.cashflowUsd).toBeNull();
      expect(result.cashflowEur).toBeNull();
      expect(result.cashflowAssetClass).toBeNull();
      expect(result.deltaUsd).toBeNull();
      expect(result.deltaEur).toBeNull();
      expect(result.deltaStatus).toBeNull();
    });

    it("does not throw — resolves gracefully on FX failure (non-adjustment)", async () => {
      hoisted.toUsdAndEur.mockRejectedValue(new Error("timeout"));

      await expect(
        computeActivityFxWithConversion({
          valueNative: 500,
          currency: "GBP",
          entityType: "stock_position",
        })
      ).resolves.toBeDefined();
    });
  });

  describe("FX failure — adjustment", () => {
    it("returns deltaStatus=pending when toUsdAndEur throws", async () => {
      hoisted.toUsdAndEur.mockRejectedValue(new Error("FX API unavailable"));

      const result = await computeActivityFxWithConversion({
        valueNative: 800,
        currency: "GBP",
        isAdjustment: true,
        entityType: "stock_position",
      });

      expect(result.deltaStatus).toBe("pending");
    });

    it("returns all numeric fields as null when toUsdAndEur throws (adjustment)", async () => {
      hoisted.toUsdAndEur.mockRejectedValue(new Error("FX API unavailable"));

      const result = await computeActivityFxWithConversion({
        valueNative: 800,
        currency: "GBP",
        isAdjustment: true,
        entityType: "stock_position",
      });

      expect(result.deltaUsd).toBeNull();
      expect(result.deltaEur).toBeNull();
      expect(result.cashflowUsd).toBeNull();
      expect(result.cashflowEur).toBeNull();
      expect(result.cashflowAssetClass).toBeNull();
      expect(result.cashflowStatus).toBeNull();
    });

    it("does not throw — resolves gracefully on FX failure (adjustment)", async () => {
      hoisted.toUsdAndEur.mockRejectedValue(new Error("timeout"));

      await expect(
        computeActivityFxWithConversion({
          valueNative: 800,
          currency: "GBP",
          isAdjustment: true,
          entityType: "stock_position",
        })
      ).resolves.toBeDefined();
    });
  });
});

// ─── Tests: emptyFx ──────────────────────────────────────────────────────────

describe("emptyFx", () => {
  it("returns an FxResult with all fields null", () => {
    const result = emptyFx();

    expect(result.deltaUsd).toBeNull();
    expect(result.deltaEur).toBeNull();
    expect(result.deltaStatus).toBeNull();
    expect(result.cashflowUsd).toBeNull();
    expect(result.cashflowEur).toBeNull();
    expect(result.cashflowAssetClass).toBeNull();
    expect(result.cashflowStatus).toBeNull();
  });
});
