import { describe, it, expect } from "vitest";
import { TYPE_GUIDANCE, COST_COPY } from "@/lib/cost-basis-copy";
describe("cost-basis copy", () => {
  it("has guidance for every transaction type", () => {
    for (const k of ["buy","sell","yield","deposit","withdrawal","transfer"] as const) {
      expect(TYPE_GUIDANCE[k].length).toBeGreaterThan(20);
    }
  });
  it("yield guidance states cost 0 + benchmark exclusion in plain words", () => {
    expect(TYPE_GUIDANCE.yield).toMatch(/earned/i);
    expect(TYPE_GUIDANCE.yield).toMatch(/not.*contribution|cost.*0|free/i);
  });
  it("amount-optional hint mentions the market-value fallback", () => {
    expect(COST_COPY.amountOptionalHint).toMatch(/market value/i);
  });
  it("multi-currency tooltip explains the EUR/USD divergence", () => {
    expect(COST_COPY.fxDivergenceTooltip).toMatch(/exchange.?rate/i);
  });
});
