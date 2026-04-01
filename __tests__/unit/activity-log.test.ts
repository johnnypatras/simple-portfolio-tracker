import { describe, it, expect } from "vitest";
import {
  cashDelta,
  positionQtyDelta,
  cashAmountField,
} from "@/lib/deltas";

describe("cashAmountField", () => {
  it("returns 'balance' for bank_account", () => {
    expect(cashAmountField("bank_account")).toBe("balance");
  });

  it("returns 'amount' for exchange_deposit", () => {
    expect(cashAmountField("exchange_deposit")).toBe("amount");
  });

  it("returns 'amount' for broker_deposit", () => {
    expect(cashAmountField("broker_deposit")).toBe("amount");
  });

  it("returns 'balance' for cash_account", () => {
    expect(cashAmountField("cash_account")).toBe("balance");
  });
});

describe("cashDelta", () => {
  it("created — uses full after amount", () => {
    expect(cashDelta("created", 0, 5000)).toBe(5000);
  });

  it("removed — negative of before amount", () => {
    expect(cashDelta("removed", 1000, 0)).toBe(-1000);
  });

  it("updated — computes difference", () => {
    expect(cashDelta("updated", 500, 800)).toBe(300);
  });

  it("created with zero after — returns 0", () => {
    expect(cashDelta("created", 0, 0)).toBe(0);
  });

  it("updated — computes difference (larger delta)", () => {
    expect(cashDelta("updated", 100, 300)).toBe(200);
  });
});

describe("positionQtyDelta", () => {
  it("created — full quantity as delta", () => {
    expect(positionQtyDelta("created", 0, 0.5)).toBe(0.5);
  });

  it("removed — negative quantity", () => {
    expect(positionQtyDelta("removed", 1.5, 0)).toBe(-1.5);
  });

  it("updated — quantity difference", () => {
    expect(positionQtyDelta("updated", 2.0, 3.5)).toBe(1.5);
  });

  it("handles very small quantities (crypto precision)", () => {
    expect(positionQtyDelta("created", 0, 0.000001)).toBeCloseTo(0.000001, 8);
  });

  it("unknown action — falls through to difference", () => {
    expect(positionQtyDelta("updated", 1, 4)).toBe(3);
  });
});
