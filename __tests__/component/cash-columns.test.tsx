import { describe, it, expect } from "vitest";
import { buildCashGroupRows } from "@/components/cash/cash-columns";
import type { CashAccount } from "@/lib/types";
import type { FXRates } from "@/lib/prices/fx";

// ── Helpers ──────────────────────────────────────────────

/** Build a minimal CashAccount with overrides. */
function makeCashAccount(overrides: Partial<CashAccount> = {}): CashAccount {
  return {
    id: "ca-1",
    user_id: "u-1",
    institution_id: "inst-1",
    name: "Savings",
    currency: "EUR",
    balance: 1000,
    apy: 0,
    region: null,
    wallet_id: null,
    broker_id: null,
    last_was_adjustment: false,
    last_was_transfer: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    institution_name: "Alpha Bank",
    wallet_name: null,
    broker_name: null,
    ...overrides,
  };
}

/** EUR-based rates: EUR=1, USD=1.08 (1 EUR = 1.08 USD). */
const fxRates: FXRates = { EUR: 1, USD: 1.08 };

// ── Tests ────────────────────────────────────────────────

describe("buildCashGroupRows", () => {
  it("bank-origin cash (wallet_id=null, broker_id=null) has origin 'Bank' and groups by institution name", () => {
    const accounts: CashAccount[] = [
      makeCashAccount({ id: "ca-1", institution_name: "Alpha Bank" }),
    ];

    const rows = buildCashGroupRows(accounts, "EUR", fxRates);

    expect(rows).toHaveLength(1);
    expect(rows[0].data.origin).toBe("Bank");
    expect(rows[0].data.groupName).toBe("Alpha Bank");
  });

  it("exchange-origin cash (wallet_id set) has origin 'Exchange' and groups by wallet name", () => {
    const accounts: CashAccount[] = [
      makeCashAccount({
        id: "ca-2",
        wallet_id: "w-1",
        wallet_name: "Binance",
        institution_id: null,
        institution_name: null,
      }),
    ];

    const rows = buildCashGroupRows(accounts, "EUR", fxRates);

    expect(rows).toHaveLength(1);
    expect(rows[0].data.origin).toBe("Exchange");
    expect(rows[0].data.groupName).toBe("Binance");
  });

  it("broker-origin cash (broker_id set) has origin 'Broker' and groups by broker name", () => {
    const accounts: CashAccount[] = [
      makeCashAccount({
        id: "ca-3",
        broker_id: "b-1",
        broker_name: "DEGIRO",
        institution_id: null,
        institution_name: null,
      }),
    ];

    const rows = buildCashGroupRows(accounts, "EUR", fxRates);

    expect(rows).toHaveLength(1);
    expect(rows[0].data.origin).toBe("Broker");
    expect(rows[0].data.groupName).toBe("DEGIRO");
  });

  it("groups multiple accounts at the same institution together and sums balances", () => {
    const accounts: CashAccount[] = [
      makeCashAccount({
        id: "ca-1",
        name: "Savings",
        balance: 5000,
        institution_id: "inst-1",
        institution_name: "Alpha Bank",
      }),
      makeCashAccount({
        id: "ca-2",
        name: "Current",
        balance: 3000,
        institution_id: "inst-1",
        institution_name: "Alpha Bank",
      }),
    ];

    const rows = buildCashGroupRows(accounts, "EUR", fxRates);

    expect(rows).toHaveLength(1);
    expect(rows[0].data.groupName).toBe("Alpha Bank");
    expect(rows[0].data.accounts).toHaveLength(2);
    expect(rows[0].data.totalValue).toBe(8000);
  });

  it("computes weighted APY correctly (weight by converted value)", () => {
    const accounts: CashAccount[] = [
      makeCashAccount({
        id: "ca-1",
        balance: 1000,
        apy: 2,
        institution_id: "inst-1",
        institution_name: "Alpha Bank",
      }),
      makeCashAccount({
        id: "ca-2",
        balance: 3000,
        apy: 4,
        institution_id: "inst-1",
        institution_name: "Alpha Bank",
      }),
    ];

    const rows = buildCashGroupRows(accounts, "EUR", fxRates);

    // Weighted: (1000*2 + 3000*4) / 4000 = 14000/4000 = 3.5
    expect(rows[0].data.weightedApy).toBeCloseTo(3.5, 6);
  });

  it("sorts groups by total value descending", () => {
    const accounts: CashAccount[] = [
      makeCashAccount({
        id: "ca-1",
        balance: 1000,
        institution_id: "inst-1",
        institution_name: "Small Bank",
      }),
      makeCashAccount({
        id: "ca-2",
        balance: 9000,
        institution_id: "inst-2",
        institution_name: "Big Bank",
      }),
    ];

    const rows = buildCashGroupRows(accounts, "EUR", fxRates);

    expect(rows).toHaveLength(2);
    expect(rows[0].data.groupName).toBe("Big Bank");
    expect(rows[1].data.groupName).toBe("Small Bank");
  });

  it("returns empty array for empty input", () => {
    const rows = buildCashGroupRows([], "EUR", fxRates);
    expect(rows).toHaveLength(0);
  });
});
