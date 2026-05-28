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

export type LegacyAdjustmentMigrationResult = {
  total_candidates: number;
  migrated: number;
  errors: number;
  details: Array<{
    id: string;
    entity_type: string;
    entity_name: string;
    status: "migrated" | "error";
    error_message?: string;
  }>;
};

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
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const rows = await fetchAllPaginated<{ entity_type: string }>((from, to) =>
    buildCandidateQuery(supabase, user.id)
      .select("entity_type")
      .order("created_at", { ascending: true })
      .range(from, to),
  );

  const by_entity_type: Record<string, number> = {};
  for (const row of rows) {
    const key = row.entity_type;
    by_entity_type[key] = (by_entity_type[key] ?? 0) + 1;
  }

  return { count: rows.length, by_entity_type };
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
 * `errors` counter and the `details` array, and the loop continues.
 * Rows are processed in `created_at` ascending order for deterministic
 * progress.
 *
 * Idempotency / concurrency contract:
 *   • The operation is idempotent: re-running on already-migrated rows is a
 *     no-op at the DB level because the candidate filter (`is_adjustment=true`)
 *     excludes rows that were already flipped to `false` by a prior run.
 *   • Concurrent invocations are safe: two simultaneous calls will each fetch
 *     the current candidate set. The second caller will see fewer (or zero)
 *     candidates because the first caller already flipped those rows. Result
 *     counts from concurrent invocations do not sum to the original total,
 *     but no row is double-processed and no row is skipped.
 *   • For a bulletproof concurrency guard, a Postgres advisory lock could be
 *     added — currently relying on the idempotency property above.
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
        .range(from, to),
    );

    const result: LegacyAdjustmentMigrationResult = {
      total_candidates: candidates.length,
      migrated: 0,
      errors: 0,
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

    for (const row of candidates) {
      try {
        await toggleActivityAdjustment(row.id, false);
        result.migrated++;
        result.details.push({
          id: row.id,
          entity_type: row.entity_type,
          entity_name: row.entity_name,
          status: "migrated",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Per-row failures must not abort the migration. Capture each one
        // individually so operators can see the failed IDs without losing
        // the rest of the run.
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
          status: "error",
          error_message: message,
        });
      }
    }

    // Revalidate all dashboard paths if any rows were migrated so the user
    // sees updated snapshot/cashflow data immediately on next navigation.
    if (result.migrated > 0) {
      await revalidateDashboard();
    }

    return result;
  });
}
