/**
 * Compute the fields that should be UPDATEd during an undo operation.
 *
 * This is a pure function with no I/O — extracted from the `undo.ts` server
 * action module so it can be unit-tested without mocking Supabase.
 *
 * Two kinds of fields are handled differently:
 *
 * 1. **Value fields** (e.g. `balance`, `amount`, `quantity`): apply
 *    **delta reversal**.
 *
 *    `new = current + (before - after)`
 *
 *    This preserves any concurrent changes that happened after the
 *    original mutation — we only reverse the specific delta introduced
 *    by the action being undone.
 *
 * 2. **Identity fields** (e.g. `name`, `currency`, `chain`): restore the
 *    `before_snapshot` value **only if** the current value still matches
 *    `after_snapshot`. If someone edited the field since, we skip it to
 *    avoid clobbering their change.
 */

/** Columns that must never be overwritten (PK, FK, audit timestamps). */
export const IMMUTABLE_COLUMNS = new Set([
  "id",
  "user_id",
  "created_at",
  "updated_at",
  "deleted_at",
]);

/** Ephemeral UI-state columns — skip during compensation. */
export const BADGE_COLUMNS = new Set([
  "last_was_adjustment",
  "last_was_transfer",
]);

/**
 * Value fields per table — accumulated quantities that need delta reversal.
 * All other mutable fields are treated as identity (restore-if-unchanged).
 */
export const VALUE_FIELDS: Record<string, string[]> = {
  cash_accounts: ["balance"],
  bank_accounts: ["balance"],
  exchange_deposits: ["amount"],
  broker_deposits: ["amount"],
  crypto_positions: ["quantity"],
  stock_positions: ["quantity"],
};

/**
 * Compute the fields to update for a compensating transaction.
 *
 * @param entityTable    The DB table name (e.g. "crypto_positions")
 * @param currentEntity  The current row state (may diverge from after_snapshot)
 * @param beforeSnapshot Snapshot captured before the mutation being undone
 * @param afterSnapshot  Snapshot captured after the mutation being undone
 * @returns              Object containing only the fields to be written back
 */
export function computeCompensatingUpdate(
  entityTable: string,
  currentEntity: Record<string, unknown>,
  beforeSnapshot: Record<string, unknown>,
  afterSnapshot: Record<string, unknown>,
): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  const valueFieldSet = new Set(VALUE_FIELDS[entityTable] ?? []);

  for (const key of Object.keys(afterSnapshot)) {
    if (IMMUTABLE_COLUMNS.has(key) || BADGE_COLUMNS.has(key)) continue;

    const beforeVal = beforeSnapshot[key];
    const afterVal = afterSnapshot[key];

    // Skip unchanged fields — nothing to reverse
    if (JSON.stringify(beforeVal) === JSON.stringify(afterVal)) continue;

    if (valueFieldSet.has(key)) {
      // Delta reversal: apply inverse of (after - before) to current.
      // Audit R1 Phase 5: `Number(x) || 0` silently masked NaN/undefined/
      // garbage as zero — a hand-edited or corrupted snapshot would have
      // its field zeroed out via `update[key] = current + (0 - 0)`. Now
      // we explicitly require finite numbers; undo fails loudly on
      // corruption rather than writing a destructive value.
      const before = Number(beforeVal);
      const after = Number(afterVal);
      const current = Number(currentEntity[key]);
      if (!Number.isFinite(before) || !Number.isFinite(after) || !Number.isFinite(current)) {
        throw new Error(
          `Cannot compute compensating update for ${entityTable}.${key}: non-finite value (before=${JSON.stringify(beforeVal)}, after=${JSON.stringify(afterVal)}, current=${JSON.stringify(currentEntity[key])})`,
        );
      }
      update[key] = current + (before - after);
    } else {
      // Identity field: restore only if current still matches after_snapshot.
      // If it was changed since, skip to avoid clobbering.
      if (JSON.stringify(currentEntity[key]) === JSON.stringify(afterVal)) {
        update[key] = beforeVal;
      }
    }
  }

  return update;
}
