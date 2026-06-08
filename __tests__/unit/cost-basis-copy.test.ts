import { describe, it, expect } from "vitest";
import { TYPE_GUIDANCE, COST_COPY, MONEY_FLOW_COPY, ADJUSTMENT_COPY } from "@/lib/cost-basis-copy";
describe("cost-basis copy", () => {
  it("has guidance for every transaction type", () => {
    for (const k of ["buy","sell","yield","deposit","withdrawal","transfer"] as const) {
      expect(TYPE_GUIDANCE[k].length).toBeGreaterThan(20);
    }
  });
  it("yield guidance states cost 0 + Model B S&P participation in plain words", () => {
    expect(TYPE_GUIDANCE.yield).toMatch(/earned|didn't pay/i);
    expect(TYPE_GUIDANCE.yield).toMatch(/cost.*0|all gain|free/i);
    // Model B: yield COUNTS toward the S&P comparison (it does not "drop out").
    expect(TYPE_GUIDANCE.yield).toMatch(/counts? toward the s&p/i);
  });
  it("amount-optional hint mentions the market-value fallback", () => {
    expect(COST_COPY.amountOptionalHint).toMatch(/market value/i);
  });
  it("editor delta hint pins the cost to the CHANGE with a worked example + keeps the fallback", () => {
    // The position editors' quantity field holds the new TOTAL, so the cost
    // hint must say it applies to the change only (100 → 110 ⇒ cost of the 10).
    expect(COST_COPY.amountDeltaHint).toMatch(/this change only/i);
    expect(COST_COPY.amountDeltaHint).toMatch(/100 → 110/);
    expect(COST_COPY.amountDeltaHint).toMatch(/the 10/);
    expect(COST_COPY.amountDeltaHint).toMatch(/incl\. fees/i);
    expect(COST_COPY.amountDeltaHint).toMatch(/market value/i);
  });
  it("multi-currency tooltip explains the EUR/USD divergence", () => {
    expect(COST_COPY.fxDivergenceTooltip).toMatch(/exchange.?rate/i);
  });
  it("yieldHasNoCost copy exists and mentions earned income", () => {
    expect(COST_COPY.yieldHasNoCost).toMatch(/earned income/i);
    expect(COST_COPY.yieldHasNoCost).toMatch(/yield/i);
  });
  it("buy/sell guidance use participation language (counting / stops counting)", () => {
    expect(TYPE_GUIDANCE.buy).toMatch(/paid for it/i);
    expect(TYPE_GUIDANCE.buy).toMatch(/new money starts counting/i);
    expect(TYPE_GUIDANCE.buy).toMatch(/S&P unchanged/i);
    expect(TYPE_GUIDANCE.sell).toMatch(/where the proceeds went/i);
    expect(TYPE_GUIDANCE.sell).toMatch(/stops counting/i);
  });
  it("transfer guidance is move-only (same asset, nothing bought or sold)", () => {
    expect(TYPE_GUIDANCE.transfer).toMatch(/same asset/i);
    expect(TYPE_GUIDANCE.transfer).toMatch(/nothing bought or sold/i);
    expect(TYPE_GUIDANCE.transfer).toMatch(/doesn't move/i);
  });
  it("ADJUSTMENT_COPY states the off-book concept in plain words", () => {
    expect(ADJUSTMENT_COPY.optionLabel).toMatch(/cleaning up|correction|not a real money event/i);
    expect(ADJUSTMENT_COPY.consequence).toMatch(/s&p/i);
    expect(ADJUSTMENT_COPY.reversibleNote).toMatch(/revers/i);
  });
  it("ADJUSTMENT_COPY confirm builders are direction-aware and name the amount", () => {
    expect(ADJUSTMENT_COPY.markConfirm("+€2,400")).toMatch(/stop counting/i);
    expect(ADJUSTMENT_COPY.markConfirm("+€2,400")).toContain("+€2,400");
    expect(ADJUSTMENT_COPY.unmarkConfirm("+€2,400")).toMatch(/count this/i);
    expect(ADJUSTMENT_COPY.unmarkConfirm("+€2,400")).toContain("+€2,400");
  });
});

describe("money-flow copy (C2a)", () => {
  it("Buy question + verbatim option labels/sub-labels", () => {
    expect(MONEY_FLOW_COPY.buy.question).toBe("Paid with?");
    expect(MONEY_FLOW_COPY.buy.externalLabel).toBe("New money entering the portfolio");
    expect(MONEY_FLOW_COPY.buy.externalSub).toBe("salary, savings from outside");
    expect(MONEY_FLOW_COPY.buy.externalChipBlank).toBe("S&P +contribution");
    expect(MONEY_FLOW_COPY.buy.trackedLabel).toBe("From a tracked account");
    expect(MONEY_FLOW_COPY.buy.trackedChip).toBe("S&P unchanged");
  });
  it("Sell question + verbatim option labels/sub-labels", () => {
    expect(MONEY_FLOW_COPY.sell.question).toBe("Proceeds went to?");
    expect(MONEY_FLOW_COPY.sell.trackedLabel).toBe("A tracked account");
    expect(MONEY_FLOW_COPY.sell.trackedChip).toBe("S&P unchanged");
    expect(MONEY_FLOW_COPY.sell.externalLabel).toBe("Left the portfolio");
    expect(MONEY_FLOW_COPY.sell.externalSub).toBe("spent / sent somewhere untracked");
    expect(MONEY_FLOW_COPY.sell.externalChipBlank).toBe("S&P −withdrawal");
  });
  it("shared copy: placeholder, no-accounts sub-text, currency-lock tooltip", () => {
    expect(MONEY_FLOW_COPY.accountPlaceholder).toBe("Choose account…");
    expect(MONEY_FLOW_COPY.noAccounts).toBe("No tracked cash accounts yet");
    expect(MONEY_FLOW_COPY.currencyLockTooltip).toMatch(/account's currency/i);
  });
  it("amount-required hint phrasing differs for buy (pays) vs sell (receives)", () => {
    expect(MONEY_FLOW_COPY.amountRequiredHint("pays")).toBe(
      "Enter the amount — it's what the account pays.",
    );
    expect(MONEY_FLOW_COPY.amountRequiredHint("receives")).toBe(
      "Enter the amount — it's what the account receives.",
    );
  });
  it("overdraft template matches the exact contract format", () => {
    expect(MONEY_FLOW_COPY.overdraft("€5,000.00", "Revolut EUR")).toBe(
      "Only €5,000.00 available in Revolut EUR.",
    );
  });
});
