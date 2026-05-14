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

/** Minimal valid v4 backup — identical shape to v3 plus position-level network field */
function minimalV4() {
  return {
    version: 4,
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

  it("accepts valid v4 backup with cashAccounts", async () => {
    const result = await validateBackup(minimalV4());
    expect(result.ok).toBe(true);
  });

  it("accepts v4 backup with position-level network field", async () => {
    const data = {
      ...minimalV4(),
      cryptoAssets: [
        {
          id: "ca1",
          ticker: "ETH",
          name: "Ethereum",
          coingecko_id: "ethereum",
          chain: "Linea",
          positions: [
            { quantity: 1.5, network: "Linea" },
          ],
        },
      ],
    };
    const result = await validateBackup(data);
    expect(result.ok).toBe(true);
  });

  it("rejects v4 backup missing cashAccounts", async () => {
    const data = minimalV4();
    delete (data as Record<string, unknown>).cashAccounts;
    const result = await validateBackup(data);
    expect(result.ok).toBe(false);
  });

  it("accepts v5 with manualNavUpdates present (round-trip)", async () => {
    const data = {
      ...minimalV4(),
      version: 5,
      manualNavUpdates: [
        {
          asset_id: "11111111-1111-1111-1111-111111111111",
          effective_date: "2026-04-01",
          nav: 105.5,
          note: "Q1 2026 fund letter",
        },
      ],
    };
    const result = await validateBackup(data);
    expect(result.ok).toBe(true);
  });

  it("accepts v5 without manualNavUpdates (backward-compat for empty case)", async () => {
    const data = { ...minimalV4(), version: 5 };
    const result = await validateBackup(data);
    expect(result.ok).toBe(true);
  });

  it("rejects v5 with malformed manualNavUpdates (string instead of array)", async () => {
    const data = { ...minimalV4(), version: 5, manualNavUpdates: "not-an-array" };
    const result = await validateBackup(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/manualNavUpdates.*array/);
    }
  });

  it("rejects v5 with negative or non-finite nav", async () => {
    const negResult = await validateBackup({
      ...minimalV4(),
      version: 5,
      manualNavUpdates: [{ asset_id: "x", effective_date: "2026-01-01", nav: -1 }],
    });
    expect(negResult.ok).toBe(false);

    const nanResult = await validateBackup({
      ...minimalV4(),
      version: 5,
      manualNavUpdates: [{ asset_id: "x", effective_date: "2026-01-01", nav: NaN }],
    });
    expect(nanResult.ok).toBe(false);
  });

  it("rejects v5 with malformed date", async () => {
    const result = await validateBackup({
      ...minimalV4(),
      version: 5,
      manualNavUpdates: [{ asset_id: "x", effective_date: "2026-13-99", nav: 100 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/effective_date/);
    }
  });

  it("rejects v6 (unsupported future version)", async () => {
    const data = { ...minimalV4(), version: 6 };
    const result = await validateBackup(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unsupported backup version");
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
      const fromDeposit = (cashAccounts as unknown as Record<string, unknown>[]).find(
        (c) => c.wallet_id === "w1",
      );
      expect(fromDeposit).toBeDefined();
      expect(fromDeposit?.balance).toBe(500);
    }
  });
});
