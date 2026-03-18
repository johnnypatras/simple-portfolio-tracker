import { describe, it, expect, vi } from "vitest";
import {
  validateAmount,
  validateCurrency,
  validateName,
  validateQuantity,
} from "@/lib/validation";

// Mock "use server" dependencies so validateBackup can be imported
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
}));
vi.mock("@/lib/actions/export", () => ({
  exportFullJson: vi.fn(),
}));

import { validateBackup } from "@/lib/actions/import";

// ─── Helpers ─────────────────────────────────────────────

/** Minimal valid v3 backup with all required arrays present. */
function minimalV3() {
  return {
    version: 3,
    institutions: [],
    wallets: [],
    brokers: [],
    cryptoAssets: [],
    stockAssets: [],
    tradeEntries: [],
    snapshots: [],
    cashAccounts: [],
  };
}

/** Minimal valid v1 backup with all required arrays present. */
function minimalV1() {
  return {
    version: 1,
    institutions: [],
    wallets: [],
    brokers: [],
    cryptoAssets: [],
    stockAssets: [],
    tradeEntries: [],
    snapshots: [],
    bankAccounts: [],
    exchangeDeposits: [],
    brokerDeposits: [],
  };
}

// ─── Original validator tests ────────────────────────────

describe("import backup validation", () => {
  it("accepts minimal v1 backup shape", () => {
    const v1 = {
      version: 1,
      cryptoAssets: [],
      stockAssets: [],
      bankAccounts: [],
      exchangeDeposits: [],
      brokerDeposits: [],
    };
    expect(v1.version).toBe(1);
    expect(Array.isArray(v1.cryptoAssets)).toBe(true);
  });

  it("rejects missing required name", () => {
    expect(() => validateName("")).toThrow("cannot be empty");
  });

  it("rejects invalid currency in import data", () => {
    expect(() => validateCurrency("usd")).toThrow("Invalid currency");
  });

  it("rejects negative amount in import data", () => {
    expect(() => validateAmount(-100)).toThrow("cannot be negative");
  });

  it("rejects NaN quantity in import data", () => {
    expect(() => validateQuantity(NaN)).toThrow("valid number");
  });

  it("accepts valid import data values", () => {
    expect(() => validateName("Bitcoin")).not.toThrow();
    expect(() => validateCurrency("USD")).not.toThrow();
    expect(() => validateAmount(1000)).not.toThrow();
    expect(() => validateQuantity(0.5)).not.toThrow();
  });
});

// ─── validateBackup tests ────────────────────────────────

describe("validateBackup", () => {
  it("accepts valid v3 backup with cashAccounts", async () => {
    const result = await validateBackup(minimalV3());
    expect(result.ok).toBe(true);
  });

  it("accepts valid v1 backup with legacy arrays", async () => {
    const result = await validateBackup(minimalV1());
    expect(result.ok).toBe(true);
  });

  it("rejects v3 backup missing cashAccounts", async () => {
    const data = minimalV3();
    delete (data as Record<string, unknown>).cashAccounts;
    const result = await validateBackup(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("cashAccounts");
    }
  });

  it("rejects v1 backup missing bankAccounts", async () => {
    const data = minimalV1();
    delete (data as Record<string, unknown>).bankAccounts;
    const result = await validateBackup(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("bankAccounts");
    }
  });

  it("normalizes v1 exchangeDeposits amount to cashAccounts balance", async () => {
    const data = {
      ...minimalV1(),
      exchangeDeposits: [
        { wallet_id: "w1", currency: "EUR", amount: 500 },
      ],
    };
    const result = await validateBackup(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const cashAccounts = result.preview.cashAccounts ?? [];
      const fromDeposit = cashAccounts.find(
        (c: Record<string, unknown>) =>
          (c as Record<string, unknown>).wallet_id === "w1",
      );
      expect(fromDeposit).toBeDefined();
      expect((fromDeposit as Record<string, unknown>).balance).toBe(500);
    }
  });
});
