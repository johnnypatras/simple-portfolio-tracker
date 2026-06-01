"use server";

/**
 * One-shot migration: convert legacy bulk-flagged real imports from
 * `is_adjustment=true` to `is_adjustment=false` so they appear as real cash
 * flows in the S&P benchmark.
 *
 * Background: pre-Phase-4, the bulk back-fill formula was tolerant of
 * historical "created" actions being flagged `is_adjustment=true`, because
 * the formula compensated for them. Post-Phase-4, those rows are invisible
 * to the benchmark cash-flow stream, leaving a ~€110K user-visible gap
 * between the portfolio and S&P lines for users who imported via CSV.
 *
 * The fix is per-row: each candidate is flipped via the existing
 * `toggleActivityAdjustment(id, false)` server action — the SAME code path
 * the UI uses when a user un-checks "Portfolio adjustment" on a single row.
 * That primitive already handles all the edge cases we need:
 *   • historical price lookup via `computeDeltaFromSnapshots`
 *   • stablecoin reclassification to the 'cash' bucket via `isStablecoin`
 *   • cashflow_amount_usd/eur and cashflow_asset_class population
 *   • cashflow_status='complete'
 *   • delta_usd/eur cleared
 *
 * CRITICAL: transfer destination legs (`transfer_group_id IS NOT NULL`)
 * MUST be excluded. They are correctly `is_adjustment=true` by design and
 * are benchmark-invisible on purpose (the benchmark accounts for transfer
 * fees via delta differences only, not as deposits). A previous attempt
 * caught 4 transfer destinations by mistake and produced €30K of phantom
 * benchmark deposits.
 *
 * Reversibility: re-running `toggleActivityAdjustment(id, true)` flips a
 * migrated row back, restoring `is_adjustment=true`, recomputing delta_*,
 * and clearing cashflow_*.
 */

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { toggleActivityAdjustment } from "@/lib/actions/activity-log";
import { captureAction } from "@/lib/actions/with-sentry";
import { revalidateDashboard } from "@/lib/actions/revalidate";
import { fetchAllPaginated } from "@/lib/supabase/pagination";
import { CASHFLOW_PRODUCING_ENTITY_TYPES } from "@/lib/cashflow";
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { LegacyAdjustmentMigrationResult } from "@/lib/types";

/**
 * Wall-clock budget for the per-row migration loop, in milliseconds. Kept
 * well below the route's `maxDuration` (60s on settings/page.tsx) so the
 * action returns a clean partial result instead of being killed mid-row by
 * the platform. When the budget fires, un-attempted rows are reported via
 * `result.remaining` and the UI offers a manual "Continue".
 *
 * Headroom rationale (R2-5): the budget is checked at the TOP of each loop
 * iteration, so a row admitted at ~budget-1ms still runs to completion. A
 * single in-flight `toggleActivityAdjustment` can take up to ~16s in the
 * worst case (Yahoo 8s timeout + a 429 retry + an FX retry), so the budget
 * must leave at least that much slack under `maxDuration`. 40s leaves 20s of
 * headroom — enough to absorb one worst-case in-flight row without crossing
 * 60s. The cost is purely one extra "Continue" click on huge cold-cache
 * migrations; the Continue flow already re-scopes the remaining rows.
 */
const MIGRATION_TIME_BUDGET_MS = 40_000;

/**
 * Builds the SELECT query for legacy bulk-flagged real-import candidates.
 * Shared by previewLegacyAdjustmentMigration + migrateLegacyAdjustmentFlags
 * to ensure filter drift is structurally impossible.
 *
 * Entity types are sourced from CASHFLOW_PRODUCING_ENTITY_TYPES in
 * cashflow.ts — the canonical set of types that generate cashflows.
 *
 * Caller chains `.select(columns).order(...).range(from, to)` to specialize.
 */
function buildCandidateQuery(
  supabase: SupabaseClient<Database>,
  userId: string,
) {
  return supabase
    .from("activity_log")
    .select("*")
    .eq("user_id", userId)
    .eq("action", "created")
    .eq("is_adjustment", true)
    .is("transfer_group_id", null)
    .is("undone_at", null)
    .in("entity_type", [...CASHFLOW_PRODUCING_ENTITY_TYPES]);
}

/**
 * Read-only preview: count how many legacy bulk-flagged real imports the
 * calling user has that the migration WOULD process. Used by the UI to
 * surface a count before the user clicks "Migrate". Identical filter to
 * `migrateLegacyAdjustmentFlags` below — see notes there.
 *
 * Uses fetchAllPaginated to handle users with >1000 candidates (PostgREST
 * silently truncates at max_rows=1000 without pagination).
 */
export async function previewLegacyAdjustmentMigration(): Promise<{
  count: number;
  by_entity_type: Record<string, number>;
}> {
  return captureAction("activity-log.preview-legacy-adjustments", async () => {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");

    const rows = await fetchAllPaginated<{ entity_type: string }>((from, to) =>
      buildCandidateQuery(supabase, user.id)
        .select("entity_type")
        .order("created_at", { ascending: true })
        // Stable `id` tiebreaker (R2-6): bulk CSV imports share an identical
        // created_at across many rows. Without a deterministic secondary sort,
        // a timestamp collision straddling a 1000-row page boundary can skip a
        // row. Mirrors every other paginated query in the project.
        .order("id", { ascending: true })
        .range(from, to),
    );

    const by_entity_type: Record<string, number> = {};
    for (const row of rows) {
      const key = row.entity_type;
      by_entity_type[key] = (by_entity_type[key] ?? 0) + 1;
    }

    return { count: rows.length, by_entity_type };
  });
}

/**
 * Migrates legacy bulk-flagged real imports from `is_adjustment=true` to
 * `false`, row-by-row via `toggleActivityAdjustment(id, false)`.
 *
 * Filter (identical to preview — enforced via buildCandidateQuery):
 *   user_id = caller
 *   action = 'created'
 *   is_adjustment = true
 *   transfer_group_id IS NULL          (excludes transfer legs)
 *   undone_at IS NULL                  (excludes undone entries)
 *   entity_type IN (CASHFLOW_PRODUCING_ENTITY_TYPES)
 *
 * Per-row errors do NOT abort the migration — they are captured in the
 * `errors` counter (and, for the UI, as entity-only entries in `details`;
 * the raw error goes to Sentry only), and the loop continues. Rows are
 * processed in `created_at` ascending order (with an `id` tiebreaker) for
 * deterministic progress.
 *
 * Pending / skipped accounting (R2-4, F3): `toggleActivityAdjustment` returns
 * `{ status, changed }`. On a real flip (`changed: true`) a row whose cashflow
 * couldn't be priced returns status 'pending' — it counts in `migrated` (the
 * flag DID flip, so it's out of the candidate set) but is ALSO tallied in
 * `result.pending`, the subset not yet reflected in the S&P benchmark. A
 * `changed: false` no-op (a concurrent run already flipped the row) counts in
 * `result.skipped`, never `migrated`. The UI surfaces these so the success
 * message stays honest; pending rows self-heal via the backfill cron.
 *
 * Timeout safety: the loop runs under a wall-clock budget
 * (`MIGRATION_TIME_BUDGET_MS`, below the route `maxDuration`). When the
 * budget fires the loop stops attempting new rows and reports the
 * un-attempted tail via `result.remaining`. The UI surfaces a manual
 * "Continue" — there is no auto-retry, so persistent-error rows cannot loop
 * forever (errored rows stay candidates but are never auto-re-attempted).
 *
 * Idempotency / concurrency contract:
 *   • The operation is idempotent: re-running on already-migrated rows is a
 *     no-op at the DB level because the candidate filter (`is_adjustment=true`)
 *     excludes rows that were already flipped to `false` by a prior run.
 *   • Concurrent invocations are safe AND honestly counted: two simultaneous
 *     calls fetch overlapping candidate sets, but for any row a prior caller
 *     already flipped, `toggleActivityAdjustment` returns `changed: false`. The
 *     migration counts such rows in `skipped`, never `migrated`, so the two
 *     runs never both claim the same row. `migrated` reflects only the flips
 *     THIS run performed, and the counts always partition the candidate set
 *     (migrated + skipped + errors + remaining === total_candidates). This
 *     closes the F3 count-inflation race without an advisory lock (which is
 *     impractical under PostgREST connection pooling anyway — a session lock
 *     may not span the migration's many separate round-trips).
 *
 * Revalidation: calls revalidateDashboard() after a successful migration so
 * the snapshot/cashflow view reflects the newly computed cashflows immediately
 * on next navigation without waiting for the next route fetch.
 */
export async function migrateLegacyAdjustmentFlags(): Promise<LegacyAdjustmentMigrationResult> {
  return captureAction("activity-log.migrate-legacy-adjustments", async () => {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");

    // Same filter as preview — fetch the row IDs + lightweight context for
    // per-row error reporting. We rely on toggleActivityAdjustment to do
    // the heavy snapshot/price work, so we don't need the full row here.
    // Uses fetchAllPaginated to handle users with >1000 bulk-flagged entries
    // (PostgREST silently truncates at max_rows=1000 without pagination).
    const candidates = await fetchAllPaginated<{
      id: string;
      entity_type: string;
      entity_name: string;
    }>((from, to) =>
      buildCandidateQuery(supabase, user.id)
        .select("id, entity_type, entity_name")
        .order("created_at", { ascending: true })
        // Stable `id` tiebreaker (R2-6) — see preview's note. Critical here:
        // a skipped row would be silently left un-migrated AND not counted in
        // `remaining` (the budget only tracks rows we never reached, not rows
        // pagination dropped).
        .order("id", { ascending: true })
        .range(from, to),
    );

    const result: LegacyAdjustmentMigrationResult = {
      total_candidates: candidates.length,
      migrated: 0,
      pending: 0,
      skipped: 0,
      errors: 0,
      remaining: 0,
      details: [],
    };

    // Breadcrumb on entry so any individual-row failure captured below has
    // upstream scope context (how many rows the migration scoped, who).
    Sentry.addBreadcrumb({
      category: "migrate-legacy-adjustments",
      message: "Legacy adjustment migration scoped",
      data: {
        user_id: user.id,
        total_candidates: candidates.length,
      },
      level: "info",
    });

    // Each toggle does external-API work (historical price + FX) per row, so
    // a large cold-cache migration can exceed the platform function timeout.
    // We chunk by wall-clock: stop attempting new rows once the budget fires
    // and report the un-attempted tail via `result.remaining`. The UI offers a
    // manual "Continue" — this is intentionally NOT auto-retry.
    const startedAt = Date.now();
    let attempted = 0;

    for (const row of candidates) {
      if (Date.now() - startedAt > MIGRATION_TIME_BUDGET_MS) break;
      attempted++;
      try {
        // `changed: false` is the M1 idempotency no-op — a concurrent run (or a
        // prior partial run) already flipped this row. It IS migrated, just not
        // by THIS run, so count it as `skipped`; two concurrent runs then never
        // both claim it as `migrated` (F3 count-inflation fix).
        //
        // On a real flip (`changed: true`): the flag flips regardless of whether
        // the cashflow could be priced. A 'pending' status means the row is
        // migrated but its cashflow is unresolved — count it in `migrated` AND
        // track it in the `pending` subset so the UI doesn't overstate success
        // (R2-4). Pending rows self-heal later via the backfill cron.
        const { status, changed } = await toggleActivityAdjustment(row.id, false);
        if (changed) {
          result.migrated++;
          if (status === "pending") result.pending++;
        } else {
          result.skipped++;
        }
      } catch (err) {
        // Per-row failures must not abort the migration. Capture each one
        // individually (with the raw error) so operators can see the failed
        // IDs in Sentry. The UI never sees raw PG text — only entity context.
        Sentry.captureException(err, {
          tags: {
            action: "activity-log.migrate-legacy-adjustments.row",
            activity_id: row.id,
            entity_type: row.entity_type,
          },
        });
        result.errors++;
        result.details.push({
          id: row.id,
          entity_type: row.entity_type,
          entity_name: row.entity_name,
        });
      }
    }

    // `remaining` is the un-attempted tail the budget cut off — computed
    // directly from how many rows we reached (`attempted`), independent of how
    // the attempted rows partitioned into migrated/skipped/errors. It is 0 on a
    // full pass. The four counts partition the candidate set exactly:
    //   migrated + skipped + errors + remaining === total_candidates.
    // Migrated/skipped rows are out of the candidate filter; errored rows stay
    // is_adjustment=true and re-appear on the next fetch. A manual Continue
    // re-scopes the surviving candidates from the DB.
    result.remaining = candidates.length - attempted;

    // Revalidate all dashboard paths if any rows were migrated so the user
    // sees updated snapshot/cashflow data immediately on next navigation.
    if (result.migrated > 0) {
      await revalidateDashboard();
    }

    return result;
  });
}
