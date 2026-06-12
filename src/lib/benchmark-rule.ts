/**
 * THE S&P RULE (Law 1) in code — the single predicate for "does this activity
 * row count in the S&P benchmark comparison?".
 *
 * Five-verb model (docs/ux-clarity/06-the-one-rule.html):
 *   FLOW           money crosses the tracked-portfolio boundary   → COUNTS (±)
 *   MOVE           money relocates between tracked places         → neutral
 *   TRACK/UNTRACK  the boundary itself grows/shrinks (owned $)    → COUNTS (±) at the date
 *   CORRECT        record ≠ reality, no money moved               → off-book
 *   UNDO           the record was a mistake                       → excluded (undone_at)
 *
 * C3 (2026-06): editing surfaces now frame CORRECT as the subordinate
 * "cosmetic number fix" escape behind the "Does this reflect real value?"
 * question — no longer a peer verb in editor UI. Mechanics unchanged.
 *
 * Mechanically, benchmark participation is encoded at WRITE time by
 * `is_adjustment`: adjustments fill `delta_*` (off-book); everything else fills
 * `cashflow_*` (counts). UNDO is a separate lifecycle filter (`undone_at`), not
 * this predicate. So the rule reduces to: counts ⇔ NOT a correction.
 *
 * Pure, dependency-free — safe to import from client or server code.
 */
export function countsInBenchmark(row: { is_adjustment?: boolean | null }): boolean {
  return !row.is_adjustment;
}

/**
 * Rule-correct default for a freshly-seeded cash-account opening balance.
 * Money entering the tracked portfolio COUNTS (it's a TRACK event), so a new
 * opening balance defaults to a real cashflow, NOT an adjustment.
 *
 * Consumed by the transfer dialog's seed-balance control. Phase 2 (#9 / #14)
 * relabels that control under the rule; this constant keeps the *default*
 * correct from Phase 0 onward.
 */
export const SEED_BALANCE_DEFAULT_IS_ADJUSTMENT = false;
