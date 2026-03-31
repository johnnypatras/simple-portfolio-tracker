/**
 * Pure helper functions for the split/backdate system.
 * Extracted from actions/splits.ts so they can be exported
 * without the "use server" constraint (which only allows async exports).
 */

import type { ActivityLog } from "@/lib/types";
import { CASH_ENTITY_TYPES as CASH_ENTITY_TYPES_ARRAY, cashAmountField, type CashEntityType } from "@/lib/deltas";

const CASH_ENTITY_TYPES = new Set<string>(CASH_ENTITY_TYPES_ARRAY);

export function isValidPastOrTodayDate(dateStr: string): boolean {
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return false;
  const today = new Date();
  today.setUTCHours(23, 59, 59, 999);
  return d <= today;
}

/**
 * Extract the original quantity from an activity log entry's snapshots.
 * Entity-type-aware: crypto/stock use "quantity", cash entities use the
 * field returned by cashAmountField() ("balance" or "amount" depending on type).
 */
export function extractQuantity(log: ActivityLog): number | null {
  const qtyField = CASH_ENTITY_TYPES.has(log.entity_type)
    ? cashAmountField(log.entity_type as CashEntityType)
    : "quantity";

  if (log.action === "created") {
    const after = log.after_snapshot as Record<string, unknown> | null;
    if (!after) return null;
    const val = after[qtyField];
    return typeof val === "number" ? val : null;
  }
  if (log.action === "updated") {
    const before = log.before_snapshot as Record<string, unknown> | null;
    const after = log.after_snapshot as Record<string, unknown> | null;
    if (!before || !after) return null;
    const beforeVal = typeof before[qtyField] === "number" ? before[qtyField] as number : 0;
    const afterVal = typeof after[qtyField] === "number" ? after[qtyField] as number : 0;
    return afterVal - beforeVal;
  }
  return null;
}
