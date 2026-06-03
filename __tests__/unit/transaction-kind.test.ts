import { describe, it, expect } from "vitest";
import { classifyTransaction, quantityDelta } from "@/lib/transaction-kind";

const cryptoBuy = {
  action: "updated",
  entity_type: "crypto_position",
  is_adjustment: false,
  is_yield: false,
  transfer_group_id: null,
  split_from_id: null,
  details: null,
  before_snapshot: { quantity: 1 },
  after_snapshot: { quantity: 3 },
};

const bankDeposit = {
  ...cryptoBuy,
  entity_type: "bank_account",
  before_snapshot: { balance: 300 },
  after_snapshot: { balance: 500 },
};

describe("quantityDelta", () => {
  it("crypto: after − before from snapshots", () => expect(quantityDelta(cryptoBuy)).toBe(2));
  it("CASH reads balance, not quantity (B2)", () => expect(quantityDelta(bankDeposit)).toBe(200));
  it("removed: delta = −before", () =>
    expect(
      quantityDelta({
        ...cryptoBuy,
        action: "removed",
        after_snapshot: null,
        before_snapshot: { quantity: 2 },
      })
    ).toBe(-2));
  it("split child uses split_direction × split_quantity — a split SELL stays negative (B3/C1)", () =>
    expect(
      quantityDelta({
        ...cryptoBuy,
        before_snapshot: null,
        after_snapshot: null,
        details: { split_quantity: 0.5, split_direction: -1 },
      })
    ).toBe(-0.5));
  it("split child with no split_direction defaults to +1 (legacy #94 children stay byte-identical)", () =>
    expect(
      quantityDelta({
        ...cryptoBuy,
        before_snapshot: null,
        after_snapshot: null,
        details: { split_quantity: 0.5 },
      })
    ).toBe(0.5));
  it("never NaNs on fully-null rows", () =>
    expect(
      quantityDelta({
        ...cryptoBuy,
        before_snapshot: null,
        after_snapshot: null,
        details: null,
      })
    ).toBe(0));
});

describe("classifyTransaction", () => {
  it("crypto buy/sell", () => {
    expect(classifyTransaction(cryptoBuy)).toBe("buy");
    expect(classifyTransaction({ ...cryptoBuy, after_snapshot: { quantity: 0.5 } })).toBe("sell");
  });
  it("ALL four cash entity types → deposit / withdrawal (B2)", () => {
    const cases = [
      { t: "bank_account", field: "balance" }, { t: "cash_account", field: "balance" },
      { t: "exchange_deposit", field: "amount" }, { t: "broker_deposit", field: "amount" },
    ] as const;
    for (const { t, field } of cases) {
      const base = { ...cryptoBuy, entity_type: t, before_snapshot: { [field]: 300 }, after_snapshot: { [field]: 500 } };
      expect(classifyTransaction(base)).toBe("deposit");
      expect(classifyTransaction({ ...base, after_snapshot: { [field]: 100 } })).toBe("withdrawal");
    }
  });
  it("yield wins · transfer · adjustment", () => {
    expect(classifyTransaction({ ...cryptoBuy, is_yield: true })).toBe("yield");
    expect(
      classifyTransaction({ ...cryptoBuy, is_adjustment: true, transfer_group_id: "g1" })
    ).toBe("transfer");
    expect(classifyTransaction({ ...cryptoBuy, is_adjustment: true })).toBe("adjustment");
  });
});
