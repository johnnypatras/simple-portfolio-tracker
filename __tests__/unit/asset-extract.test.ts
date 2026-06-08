import { describe, it, expect } from "vitest";
import { extractBaseTicker, inferCategory } from "@/lib/asset-extract";

describe("asset-extract", () => {
  it("extractBaseTicker strips the exchange suffix", () => {
    expect(extractBaseTicker("VWCE.DE")).toBe("VWCE");
    expect(extractBaseTicker("AAPL")).toBe("AAPL");
    expect(extractBaseTicker(".HIDDEN")).toBe(".HIDDEN"); // dot at index 0 → unchanged
  });
  it("inferCategory maps Yahoo quoteType", () => {
    expect(inferCategory("ETF")).toBe("etf");
    expect(inferCategory("EQUITY")).toBe("individual_stock");
    expect(inferCategory("MUTUALFUND")).toBe("other");
  });
});
