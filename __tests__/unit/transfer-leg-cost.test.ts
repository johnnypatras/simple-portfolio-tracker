import { describe, it, expect } from "vitest";
import { conversionLegCost } from "@/lib/transfer-leg-cost";

describe("conversionLegCost", () => {
  it("buy (cash source): returns the cash amount + currency as the position-leg cost", () => {
    expect(
      conversionLegCost("buy", { type: "cash_account", accountId: "a", amount: 100 }, "EUR"),
    ).toEqual({ amount: 100, currency: "EUR" });
  });
  it("sell (cash destination): returns the cash proceeds + currency", () => {
    expect(
      conversionLegCost("sell", { type: "cash_account", accountId: "a", amount: 250 }, "USD"),
    ).toEqual({ amount: 250, currency: "USD" });
  });
  it("move (no cash side): returns null → keep market valuation", () => {
    expect(
      conversionLegCost("move", { type: "crypto_position", assetId: "x", walletId: "w", quantity: 1 }, "EUR"),
    ).toBeNull();
  });
  it("non-cash side in buy/sell (defensive): returns null", () => {
    expect(
      conversionLegCost("buy", { type: "crypto_position", assetId: "x", walletId: "w", quantity: 1 }, "EUR"),
    ).toBeNull();
  });
});
