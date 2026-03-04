import { describe, it, expect } from "vitest";

// Test the delta computation logic (pure math, no DB)
describe("delta computation from snapshots", () => {
  // Helper mirrors the cash-entity logic in activity-log.ts:128-154
  function cashDelta(
    action: string,
    before: { amount?: number; balance?: number } | null,
    after: { amount?: number; balance?: number } | null,
    entityType: "bank_account" | "exchange_deposit" | "broker_deposit"
  ): number {
    const field = entityType === "bank_account" ? "balance" : "amount";
    const beforeAmt = (before as Record<string, number> | null)?.[field] ?? 0;
    const afterAmt = (after as Record<string, number> | null)?.[field] ?? 0;

    if (action === "created") return afterAmt;
    if (action === "removed") return -beforeAmt;
    return afterAmt - beforeAmt; // updated
  }

  it("created — uses full after amount", () => {
    expect(cashDelta("created", null, { balance: 5000 }, "bank_account")).toBe(5000);
  });

  it("removed — negative of before amount", () => {
    expect(cashDelta("removed", { amount: 1000 }, null, "exchange_deposit")).toBe(-1000);
  });

  it("updated — computes difference", () => {
    expect(cashDelta("updated", { amount: 500 }, { amount: 800 }, "broker_deposit")).toBe(300);
  });

  it("null before on creation — uses 0 as before", () => {
    expect(cashDelta("created", null, { amount: 250 }, "exchange_deposit")).toBe(250);
  });

  it("null after on removal — uses 0 as after", () => {
    expect(cashDelta("removed", { balance: 3000 }, null, "bank_account")).toBe(-3000);
  });

  // Position delta (quantity-based)
  function positionDelta(
    action: string,
    beforeQty: number | null,
    afterQty: number | null
  ): number {
    const before = beforeQty ?? 0;
    const after = afterQty ?? 0;
    if (action === "created") return after;
    if (action === "removed") return -before;
    return after - before;
  }

  it("crypto position created — full quantity as delta", () => {
    expect(positionDelta("created", null, 0.5)).toBe(0.5);
  });

  it("crypto position removed — negative quantity", () => {
    expect(positionDelta("removed", 1.5, null)).toBe(-1.5);
  });

  it("position updated — quantity difference", () => {
    expect(positionDelta("updated", 2.0, 3.5)).toBe(1.5);
  });
});
