import { describe, it, expect } from "vitest";
import { TYPE_GUIDANCE, COST_COPY } from "@/lib/cost-basis-copy";
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
  it("multi-currency tooltip explains the EUR/USD divergence", () => {
    expect(COST_COPY.fxDivergenceTooltip).toMatch(/exchange.?rate/i);
  });
  it("yieldHasNoCost copy exists and mentions earned income", () => {
    expect(COST_COPY.yieldHasNoCost).toMatch(/earned income/i);
    expect(COST_COPY.yieldHasNoCost).toMatch(/yield/i);
  });
});
