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

  // ── THE SIGN CONTRACT: override × direction matrix (cashflow branch) ────────
  describe("amountOverride sign (cashflow branch)", () => {
    it("acquisition override (direction +1) → stored POSITIVE", () => {
      const result = computeActivityFx({
        valUsd: 0,
        valEur: 0,
        entityType: "crypto_position",
        amountOverride: { usd: 1760, eur: 1600 },
        direction: 1,
      });
      expect(result.cashflowUsd).toBe(1760);
      expect(result.cashflowEur).toBe(1600);
      expect(result.cashflowUserSet).toBe(true);
      expect(result.cashflowStatus).toBe("complete");
    });

    it("disposal override (direction −1) → stored NEGATIVE", () => {
      const result = computeActivityFx({
        valUsd: 0,
        valEur: 0,
        entityType: "crypto_position",
        amountOverride: { usd: 1760, eur: 1600 },
        direction: -1,
      });
      expect(result.cashflowUsd).toBe(-1760);
      expect(result.cashflowEur).toBe(-1600);
      expect(result.cashflowUserSet).toBe(true);
    });

    it("THE TRAP: zero-val disposal (no prices) STILL stores negative", () => {
      // The transaction manager passes NO prices for a cost-only write → valUsd
      // is 0/-0. Math.sign(valUsd || 1) would flip this positive — forbidden.
      const result = computeActivityFx({
        valUsd: -0,
        valEur: -0,
        entityType: "crypto_position",
        amountOverride: { usd: 1760, eur: 1600 },
        direction: -1,
      });
      expect(result.cashflowUsd).toBe(-1760);
      expect(result.cashflowEur).toBe(-1600);
    });

    it("override magnitude with stray negative sign is normalized then re-signed (no double-negate)", () => {
      // A future signed caller must not double-negate: Math.abs collapses any
      // sign on the incoming magnitude, then direction is applied once.
      const result = computeActivityFx({
        valUsd: 0,
        valEur: 0,
        entityType: "crypto_position",
        amountOverride: { usd: -1760, eur: -1600 },
        direction: -1,
      });
      expect(result.cashflowUsd).toBe(-1760);
      expect(result.cashflowEur).toBe(-1600);
    });

    it("override with no direction defaults to +1 (acquisition)", () => {
      const result = computeActivityFx({
        valUsd: 0,
        valEur: 0,
        entityType: "crypto_position",
        amountOverride: { usd: 500, eur: 460 },
      });
      expect(result.cashflowUsd).toBe(500);
      expect(result.cashflowEur).toBe(460);
    });

    it("no override → val* used verbatim, direction ignored, cashflowUserSet false", () => {
      const result = computeActivityFx({
        valUsd: -1760,
        valEur: -1600,
        entityType: "crypto_position",
        direction: 1, // ignored on the no-override path
      });
      expect(result.cashflowUsd).toBe(-1760);
      expect(result.cashflowEur).toBe(-1600);
      expect(result.cashflowUserSet).toBe(false);
    });
  });

  // ── THE SIGN CONTRACT: override × direction matrix (adjustment branch) ──────
  describe("amountOverride sign (adjustment branch)", () => {
    it("disposal override (direction −1) → delta stored NEGATIVE", () => {
      const result = computeActivityFx({
        valUsd: 0,
        valEur: 0,
        isAdjustment: true,
        entityType: "crypto_position",
        amountOverride: { usd: 1760, eur: 1600 },
        direction: -1,
      });
      expect(result.deltaUsd).toBe(-1760);
      expect(result.deltaEur).toBe(-1600);
      expect(result.deltaStatus).toBe("complete");
      // cashflowUserSet is a cashflow-branch concept — never set in adjustment mode.
      expect(result.cashflowUserSet).toBe(false);
    });

    it("acquisition override (direction +1) → delta stored POSITIVE", () => {
      const result = computeActivityFx({
        valUsd: 0,
        valEur: 0,
        isAdjustment: true,
        entityType: "crypto_position",
        amountOverride: { usd: 1760, eur: 1600 },
        direction: 1,
      });
      expect(result.deltaUsd).toBe(1760);
      expect(result.deltaEur).toBe(1600);
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

  // ── THE SIGN CONTRACT: override × direction (skips FX conversion) ──────────
  describe("amountOverride sign — non-adjustment", () => {
    it("disposal override (direction −1) → stored NEGATIVE, toUsdAndEur NOT called", async () => {
      const result = await computeActivityFxWithConversion({
        valueNative: 0,
        currency: "USD",
        entityType: "stock_position",
        amountOverride: { usd: 1760, eur: 1600 },
        direction: -1,
      });
      expect(result.cashflowUsd).toBe(-1760);
      expect(result.cashflowEur).toBe(-1600);
      expect(result.cashflowUserSet).toBe(true);
      expect(result.cashflowStatus).toBe("complete");
      // The override path bypasses qty × price — FX conversion is never invoked.
      expect(hoisted.toUsdAndEur).not.toHaveBeenCalled();
    });

    it("acquisition override (direction +1) → stored POSITIVE", async () => {
      const result = await computeActivityFxWithConversion({
        valueNative: 0,
        currency: "USD",
        entityType: "stock_position",
        amountOverride: { usd: 1760, eur: 1600 },
        direction: 1,
      });
      expect(result.cashflowUsd).toBe(1760);
      expect(result.cashflowEur).toBe(1600);
    });

    it("THE TRAP: zero-val disposal (no native price) STILL stores negative", async () => {
      const result = await computeActivityFxWithConversion({
        valueNative: -0,
        currency: "USD",
        entityType: "stock_position",
        amountOverride: { usd: 900, eur: 818.18 },
        direction: -1,
      });
      expect(result.cashflowUsd).toBe(-900);
      expect(result.cashflowEur).toBe(-818.18);
    });

    it("override with no direction defaults to +1", async () => {
      const result = await computeActivityFxWithConversion({
        valueNative: 0,
        currency: "USD",
        entityType: "stock_position",
        amountOverride: { usd: 300, eur: 272 },
      });
      expect(result.cashflowUsd).toBe(300);
      expect(result.cashflowEur).toBe(272);
    });
  });

  describe("amountOverride sign — adjustment", () => {
    it("disposal override (direction −1) → delta stored NEGATIVE", async () => {
      const result = await computeActivityFxWithConversion({
        valueNative: 0,
        currency: "USD",
        isAdjustment: true,
        entityType: "stock_position",
        amountOverride: { usd: 1760, eur: 1600 },
        direction: -1,
      });
      expect(result.deltaUsd).toBe(-1760);
      expect(result.deltaEur).toBe(-1600);
      expect(result.deltaStatus).toBe("complete");
      expect(hoisted.toUsdAndEur).not.toHaveBeenCalled();
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
