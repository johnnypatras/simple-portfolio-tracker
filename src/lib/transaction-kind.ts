/**
 * Pure transaction classification helpers — no DB, no async, no "use server".
 * Entity-aware: cash positions use `balance`/`amount` fields (B2 correction),
 * split children use `split_direction × split_quantity` (B3/C1 correction).
 */

import { CASH_ENTITY_TYPES, cashAmountField, type CashEntityType } from "@/lib/deltas";

/** Minimal input shape the two helpers require. */
export interface TransactionRow {
  entity_type: string;
  action?: string;
  is_yield?: boolean;
  is_adjustment?: boolean;
  transfer_group_id?: string | null;
  split_from_id?: string | null;
  before_snapshot?: Record<string, unknown> | null;
  after_snapshot?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
}

export type TransactionKind =
  | "buy"
  | "sell"
  | "yield"
  | "deposit"
  | "withdrawal"
  | "transfer"
  | "adjustment";

/**
 * Safely read a numeric field off a snapshot object.
 * Returns 0 when the snapshot is absent, not an object, or the field is not a number.
 */
function val(snapshot: Record<string, unknown> | null | undefined, field: string): number {
  if (!snapshot || typeof snapshot !== "object") return 0;
  const v = snapshot[field];
  return typeof v === "number" ? v : 0;
}

/**
 * Compute the signed quantity delta for an activity-log row.
 *
 * Split-child path (both snapshots null + `details.split_quantity` present):
 *   delta = split_quantity × split_direction  (split_direction defaults to +1 when absent)
 *
 * All other rows:
 *   delta = val(after, field) − val(before, field)
 *   where `field` is determined by `cashAmountField` for cash entities
 *   ("balance" for bank_account/cash_account, "amount" for exchange_deposit/broker_deposit)
 *   and "quantity" for position entities.
 *   "removed" rows have a null after_snapshot — val() returns 0, giving delta = −before.
 */
export function quantityDelta(row: TransactionRow): number {
  // Split-child path: both snapshots absent and split_quantity present in details
  const isSplitChild =
    row.before_snapshot == null &&
    row.after_snapshot == null &&
    row.details != null &&
    typeof row.details["split_quantity"] === "number";

  if (isSplitChild) {
    const sq = row.details!["split_quantity"] as number;
    const sdRaw = row.details!["split_direction"];
    // Default +1 when split_direction is absent (legacy #94 children). Note: a
    // legacy child whose parent action is "removed" would get +1 here, while the
    // augmentation (splitSignWithLegacyFallback in split-helpers.ts) returns −1 via
    // the old formula. This is an intentional divergence — the "removed" parent
    // path is UNREACHABLE via splitActivityEntry (verified through git history), and
    // the augmentation is bound by #94 byte-identity. See split-helpers.ts for the
    // full rationale.
    const sd = typeof sdRaw === "number" ? Math.sign(sdRaw) || 1 : 1;
    return sq * sd;
  }

  const f = (CASH_ENTITY_TYPES as readonly string[]).includes(row.entity_type)
    ? cashAmountField(row.entity_type as CashEntityType) // "balance" or "amount" per the four cash types
    : "quantity";

  return val(row.after_snapshot, f) - val(row.before_snapshot, f);
}

/**
 * Classify an activity-log row into a human-readable transaction kind.
 *
 * Priority order:
 *   1. is_yield → "yield"
 *   2. transfer_group_id present → "transfer"
 *   3. is_adjustment → "adjustment"
 *   4. cash entity → "deposit" | "withdrawal"  (based on quantityDelta >= 0)
 *   5. position entity → "buy" | "sell"         (based on quantityDelta >= 0)
 */
export function classifyTransaction(row: TransactionRow): TransactionKind {
  if (row.is_yield) return "yield";
  if (row.transfer_group_id) return "transfer";
  if (row.is_adjustment) return "adjustment";

  const up = quantityDelta(row) >= 0;
  const isCash = (CASH_ENTITY_TYPES as readonly string[]).includes(row.entity_type);

  if (isCash) return up ? "deposit" : "withdrawal";
  return up ? "buy" : "sell";
}
