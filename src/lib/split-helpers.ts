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

/**
 * Derive the single, parent-level split direction stored on every child of a
 * split (`details.split_direction`). Legs are always positive (splits.ts rejects
 * `leg.quantity <= 0`), so the disposal/acquisition sign comes from the parent:
 * splitting a SELL (negative qty delta) → -1, so the cost engine's
 * `quantityDelta` (split_direction × split_quantity) keeps each child a disposal.
 *
 * Zero-quantity guard: `Math.sign(0) = 0` and a null parent quantity (e.g. a
 * "removed" parent extractQuantity can't resolve) both resolve to +1 — the safe
 * "buy" default. In practice splitActivityEntry already rejects a 0/null parent
 * quantity before any child is created, so the guard is defensive belt-and-braces.
 */
export function splitDirectionForParent(log: ActivityLog): 1 | -1 {
  const qty = extractQuantity(log);
  if (qty == null) return 1;
  return Math.sign(qty) < 0 ? -1 : 1;
}

/**
 * Resolve the literal split sign for an activity-log row at augmentation read
 * time. New children carry an explicit `details.split_direction` (1 or -1);
 * legacy #94 children carry NONE. For those legacy rows the fallback
 * `(action === "removed" ? -1 : 1)` replicates the OLD augmentation formula
 * EXACTLY, guaranteeing byte-identical lot deltas for every pre-Task-4.1 child
 * (including the theoretical removed-action child). An explicit split_direction
 * always wins over the action-derived legacy default.
 *
 * INTENTIONAL ENGINE/AUGMENTATION DIVERGENCE: for a hypothetical legacy child
 * whose parent action is "removed" and that carries NO `split_direction` (this
 * path is UNREACHABLE via splitActivityEntry — verified through git history;
 * splitActivityEntry only ever creates children from "created"/"updated" parents),
 * the cost engine (`transaction-kind.ts:quantityDelta`) defaults split_direction
 * to +1 (via `Math.sign(sdRaw) || 1` when sdRaw is undefined), while THIS
 * augmentation function returns −1 via the legacy `removed → −1` fallback.
 * This divergence is intentional and safe: the engine row is unreachable in
 * practice, and the augmentation is bound by #94 byte-identity which requires
 * replicating the old formula. See also `quantityDelta` in transaction-kind.ts.
 */
export function splitSignWithLegacyFallback(
  splitDirection: number | null | undefined,
  action: string | null | undefined,
): 1 | -1 {
  if (typeof splitDirection === "number") {
    return Math.sign(splitDirection) < 0 ? -1 : 1;
  }
  return action === "removed" ? -1 : 1;
}
