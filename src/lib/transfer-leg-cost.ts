import type { TransferSide } from "@/lib/types";

/**
 * The conversion INPUT for a transfer's POSITION leg in a cash↔position
 * conversion. A buy/sell is a conversion: cost basis (buy) / proceeds (sell) =
 * the cash moved, NOT the position's market value. Returns the cash side's
 * {amount, currency}; `executeTransfer` converts it ONCE (toUsdAndEur +
 * deriveDualAmount) into the dual {usd, eur} override the position primitive
 * consumes — the primitive signs it by quantityDelta. Returns null for `move`
 * (keep market) or a defensively non-cash side.
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
