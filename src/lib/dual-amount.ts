import { round2 } from "@/lib/format";
import type { UsdEurAmount } from "@/lib/types";

/**
 * THE VERBATIM-LEG RULE — the single source for deriving the stored dual
 * { usd, eur } pair from a single-currency money amount (a cost, proceeds,
 * or transfer-conversion amount) plus its FX-derived counterpart:
 *
 * - typed EUR → the eur leg is the typed amount BYTE-EXACT (all decimals
 *   preserved); only the derived usd sibling is round2'd to clean money.
 * - typed USD → mirror: usd verbatim, eur derived + round2'd.
 * - any other ISO → no stored leg of its own: BOTH legs derived + round2'd
 *   (the typed face amount survives in `original_*`).
 *
 * `conv` is the FX conversion of `amount` (normally `toUsdAndEur(amount,
 * currency, date)`, which THROWS on FX failure — a bad rate never reaches
 * here). This is load-bearing financial logic shared by every cost boundary:
 * addTransaction / editTransaction, upsertPosition (crypto),
 * upsertStockPosition, split per-leg costs, and the transfer conversion-cost
 * override. New boundaries MUST call this instead of re-deriving the pair.
 */
export function deriveDualAmount(
  amount: number,
  currency: string,
  conv: { usd: number; eur: number },
): UsdEurAmount {
  return currency === "EUR"
    ? { eur: amount, usd: round2(conv.usd) }
    : currency === "USD"
      ? { usd: amount, eur: round2(conv.eur) }
      : { usd: round2(conv.usd), eur: round2(conv.eur) };
}
