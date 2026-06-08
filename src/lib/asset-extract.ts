import type { AssetCategory } from "@/lib/types";

/** Strip exchange suffix: VWCE.DE → VWCE. (A leading dot at index 0 → unchanged.) */
export function extractBaseTicker(symbol: string): string {
  const dot = symbol.indexOf(".");
  return dot > 0 ? symbol.slice(0, dot) : symbol;
}

/** Infer asset category from a Yahoo quoteType. */
export function inferCategory(quoteType: string): AssetCategory {
  if (quoteType === "ETF") return "etf";
  if (quoteType === "EQUITY") return "individual_stock";
  return "other";
}
