import { describe, it, expect } from "vitest";
import { resolveTable, remapSnapshotFields } from "@/lib/undo-remap";

describe("resolveTable", () => {
  it("remaps bank_accounts → cash_accounts", () => {
    expect(resolveTable("bank_accounts")).toBe("cash_accounts");
  });

  it("remaps exchange_deposits → cash_accounts", () => {
    expect(resolveTable("exchange_deposits")).toBe("cash_accounts");
  });

  it("remaps broker_deposits → cash_accounts", () => {
    expect(resolveTable("broker_deposits")).toBe("cash_accounts");
  });

  it("identity: cash_accounts → cash_accounts", () => {
    expect(resolveTable("cash_accounts")).toBe("cash_accounts");
  });

  it("passes through unmapped tables", () => {
    expect(resolveTable("crypto_positions")).toBe("crypto_positions");
  });
});

describe("remapSnapshotFields", () => {
  it("remaps exchange_deposits amount → balance", () => {
    expect(
      remapSnapshotFields("exchange_deposits", { amount: 500, currency: "EUR" }),
    ).toEqual({ balance: 500, currency: "EUR" });
  });

  it("remaps broker_deposits amount → balance", () => {
    expect(
      remapSnapshotFields("broker_deposits", { amount: 200 }),
    ).toEqual({ balance: 200 });
  });

  it("leaves bank_accounts snapshot unchanged", () => {
    expect(
      remapSnapshotFields("bank_accounts", { balance: 1000 }),
    ).toEqual({ balance: 1000 });
  });

  it("leaves cash_accounts snapshot unchanged", () => {
    expect(
      remapSnapshotFields("cash_accounts", { balance: 1000 }),
    ).toEqual({ balance: 1000 });
  });

  it("returns null for null snapshot", () => {
    expect(remapSnapshotFields("exchange_deposits", null)).toBeNull();
  });

  it("collision (amount first, balance second): later key wins — `balance` survives", () => {
    // Insertion order matters: Object.entries iterates string keys in
    // declaration order. `amount` remaps to `balance`, then the original
    // `balance` key overwrites. This test pins the current behavior so
    // a future refactor of remapSnapshotFields doesn't silently change
    // undo data integrity for any legacy row that has both fields.
    const result = remapSnapshotFields("exchange_deposits", { amount: 500, balance: 999 });
    expect(result).toEqual({ balance: 999 });
  });

  it("collision (balance first, amount second): `amount` remap wins — `balance` overwritten", () => {
    // Mirror of the above — demonstrates the order-dependence explicitly.
    const result = remapSnapshotFields("exchange_deposits", { balance: 999, amount: 500 });
    expect(result).toEqual({ balance: 500 });
  });
});
