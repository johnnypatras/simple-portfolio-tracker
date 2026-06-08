import type { TransferSide } from "@/lib/types";

/**
 * The COST override for a transfer's POSITION leg in a cash↔position conversion.
 * A buy/sell is a conversion: cost basis (buy) / proceeds (sell) = the cash moved,
 * NOT the position's market value. Returns the cash side's {amount, currency} so the
 * position primitive books delta = amount-paid. Returns null for `move` (keep market)
 * or a defensively non-cash side. THE position primitive signs it by quantityDelta.
 */
export function conversionLegCost(
  mode: "buy" | "sell" | "move",
  cashSide: TransferSide,
  cashCurrency: string,
): { amount: number; currency: string } | null {
  if (mode === "move") return null;
  if (cashSide.type !== "cash_account") return null;
  return { amount: cashSide.amount, currency: cashCurrency };
}
