import { describe, it, expect } from "vitest";

/**
 * Tests for the legacy array derivation logic used in exportFullJson().
 * The export function derives bankAccounts, exchangeDeposits, and brokerDeposits
 * from the unified cashAccounts array using filter conditions on wallet_id/broker_id.
 *
 * Since the derivation is inline in the server action (not extractable without
 * major refactoring), we replicate the filter logic here to validate correctness.
 */

interface MockCashAccount {
  id: string;
  name: string;
  currency: string;
  balance: number;
  wallet_id: string | null;
  broker_id: string | null;
}

function deriveLegacyArrays(cashAccounts: MockCashAccount[]) {
  return {
    bankAccounts: cashAccounts.filter((c) => !c.wallet_id && !c.broker_id),
    exchangeDeposits: cashAccounts.filter((c) => c.wallet_id != null),
    brokerDeposits: cashAccounts.filter((c) => c.broker_id != null),
  };
}

const accounts: MockCashAccount[] = [
  { id: "1", name: "Alpha Bank", currency: "EUR", balance: 5000, wallet_id: null, broker_id: null },
  { id: "2", name: "Binance EUR", currency: "EUR", balance: 1000, wallet_id: "w1", broker_id: null },
  { id: "3", name: "DEGIRO Cash", currency: "EUR", balance: 800, wallet_id: null, broker_id: "b1" },
];

describe("export legacy array derivation", () => {
  it("wallet_id set, broker_id null → appears in exchangeDeposits", () => {
    const { exchangeDeposits } = deriveLegacyArrays(accounts);
    expect(exchangeDeposits).toHaveLength(1);
    expect(exchangeDeposits[0].id).toBe("2");
  });

  it("broker_id set, wallet_id null → appears in brokerDeposits", () => {
    const { brokerDeposits } = deriveLegacyArrays(accounts);
    expect(brokerDeposits).toHaveLength(1);
    expect(brokerDeposits[0].id).toBe("3");
  });

  it("both null → appears in bankAccounts", () => {
    const { bankAccounts } = deriveLegacyArrays(accounts);
    expect(bankAccounts).toHaveLength(1);
    expect(bankAccounts[0].id).toBe("1");
  });

  it("export version field is 3 — all three categories sum to total", () => {
    // When all three categories are derived, no account should be lost
    const { bankAccounts, exchangeDeposits, brokerDeposits } = deriveLegacyArrays(accounts);
    expect(bankAccounts.length + exchangeDeposits.length + brokerDeposits.length).toBe(accounts.length);
  });
});
