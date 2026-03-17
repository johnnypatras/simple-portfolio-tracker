"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActivityLog } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";

// ─── Cash consolidation backward-compat ───────────────────
// Historical activity_log entries reference old table/field names.

const TABLE_REMAP: Record<string, string> = {
  bank_accounts: "cash_accounts",
  exchange_deposits: "cash_accounts",
  broker_deposits: "cash_accounts",
};

const SNAPSHOT_FIELD_REMAP: Record<string, Record<string, string>> = {
  exchange_deposits: { amount: "balance" },
  broker_deposits: { amount: "balance" },
};

function resolveTable(entityTable: string): string {
  return TABLE_REMAP[entityTable] ?? entityTable;
}

function remapSnapshotFields(
  entityTable: string,
  snapshot: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!snapshot) return null;
  const remap = SNAPSHOT_FIELD_REMAP[entityTable];
  if (!remap) return snapshot;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    result[remap[key] ?? key] = value;
  }
  return result;
}

// ─── Field classification ─────────────────────────────────
// Controls how each snapshot field is handled during compensation.

/** Columns that must never be overwritten. */
const IMMUTABLE_COLUMNS = new Set([
  "id", "user_id", "created_at", "updated_at", "deleted_at",
]);

/** Ephemeral UI-state columns — skip during compensation. */
const BADGE_COLUMNS = new Set([
  "last_was_adjustment", "last_was_transfer",
]);

/**
 * Value fields per table — accumulated quantities that need delta reversal.
 * All other mutable fields are treated as identity (restore-if-unchanged).
 */
const VALUE_FIELDS: Record<string, string[]> = {
  cash_accounts: ["balance"],
  bank_accounts: ["balance"],
  exchange_deposits: ["amount"],
  broker_deposits: ["amount"],
  crypto_positions: ["quantity"],
  stock_positions: ["quantity"],
};

/** Tables that support undo operations. */
const ALLOWED_UNDO_TABLES = new Set([
  "crypto_assets", "crypto_positions",
  "stock_assets", "stock_positions",
  "wallets", "brokers",
  "cash_accounts",
  // Keep old names — historical activity_log entries still reference them
  "bank_accounts", "exchange_deposits", "broker_deposits",
  "trade_entries",
]);

// ─── Compensating update computation ─────────────────────

/**
 * Compute the fields to update for a compensating transaction.
 *
 * - Value fields (balance, amount, quantity): delta reversal.
 *   new = current + (before - after)
 *
 * - Identity fields (name, currency, etc.): restore before_snapshot
 *   value ONLY if the current value still matches after_snapshot.
 *   If someone changed it since, skip to avoid clobbering.
 */
function computeCompensatingUpdate(
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

    // Skip unchanged fields
    if (JSON.stringify(beforeVal) === JSON.stringify(afterVal)) continue;

    if (valueFieldSet.has(key)) {
      // Delta reversal: apply inverse of (after - before) to current
      const delta = (Number(beforeVal) || 0) - (Number(afterVal) || 0);
      const currentVal = Number(currentEntity[key]) || 0;
      update[key] = currentVal + delta;
    } else {
      // Identity field: restore only if current still matches after_snapshot
      if (JSON.stringify(currentEntity[key]) === JSON.stringify(afterVal)) {
        update[key] = beforeVal;
      }
      // else: skip — changed since, don't clobber
    }
  }

  return update;
}

// ─── Description builder ────────────────────────────────

function fmtVal(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") {
    return v.toLocaleString("en-US", { maximumFractionDigits: 6 });
  }
  return String(v);
}

function buildCompensationDescription(
  entityName: string,
  compensatingFields: Record<string, unknown>,
  beforeEntity: Record<string, unknown>,
): string {
  const changes: string[] = [];
  for (const [key, newVal] of Object.entries(compensatingFields)) {
    const oldVal = beforeEntity[key];
    const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ");
    changes.push(`${label}: ${fmtVal(oldVal)} → ${fmtVal(newVal)}`);
  }
  if (changes.length === 0) return `Undid update on ${entityName}`;
  return `Undid update on ${entityName} (${changes.join(", ")})`;
}

// ─── Single-entry undo ──────────────────────────────────

/**
 * Undo a single activity log entry. For "updated" actions, uses compensating
 * transactions (delta reversal) instead of snapshot restoration.
 */
async function undoSingleEntry(
  log: ActivityLog,
  supabase: SupabaseClient,
): Promise<{ success: boolean; message: string; compensationId?: string }> {
  // ── Guard: missing undo metadata ─
  if (!log.entity_id || !log.entity_table) {
    return {
      success: false,
      message: "This action predates the undo system and cannot be reversed",
    };
  }

  // ── Guard: table whitelist ─
  if (!ALLOWED_UNDO_TABLES.has(log.entity_table)) {
    return { success: false, message: "Undo not supported for this entity type" };
  }

  // ── Resolve legacy table/field names (cash consolidation) ─
  const effectiveTable = resolveTable(log.entity_table);
  const beforeSnapshot = remapSnapshotFields(log.entity_table, log.before_snapshot);
  const afterSnapshot = remapSnapshotFields(log.entity_table, log.after_snapshot);

  // ── Fetch current entity state ─
  const { data: existing } = await supabase
    .from(effectiveTable)
    .select("*")
    .eq("id", log.entity_id)
    .single();

  if (!existing) {
    return {
      success: false,
      message: "The original record no longer exists (may have been permanently deleted)",
    };
  }

  const entity = existing as Record<string, unknown>;

  // ── State guards ─
  if (log.action === "created" && entity.deleted_at !== null) {
    return { success: false, message: "This entity has already been deleted" };
  }
  if (log.action === "removed" && entity.deleted_at === null) {
    return { success: false, message: "This entity has already been restored" };
  }
  if (log.action === "updated" && entity.deleted_at !== null) {
    return { success: false, message: "Cannot undo update — the entity has been deleted" };
  }

  // ── Perform the reversal ─
  let compensationId: string | undefined;

  try {
    switch (log.action) {
      case "created": {
        const { error } = await supabase
          .from(effectiveTable)
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", log.entity_id);
        if (error) throw error;
        break;
      }

      case "removed": {
        const { error } = await supabase
          .from(effectiveTable)
          .update({ deleted_at: null })
          .eq("id", log.entity_id);
        if (error) throw error;
        break;
      }

      case "updated": {
        if (!beforeSnapshot || !afterSnapshot) {
          return { success: false, message: "No snapshots available for compensation" };
        }

        const compensatingFields = computeCompensatingUpdate(
          effectiveTable,
          entity,
          beforeSnapshot,
          afterSnapshot,
        );

        if (Object.keys(compensatingFields).length === 0) {
          return {
            success: false,
            message: "No fields to reverse (all changes have been superseded)",
          };
        }

        // Apply the compensating update
        const { error } = await supabase
          .from(effectiveTable)
          .update(compensatingFields)
          .eq("id", log.entity_id);
        if (error) throw error;

        // Read entity after compensation for the after_snapshot
        const { data: afterEntity } = await supabase
          .from(effectiveTable)
          .select("*")
          .eq("id", log.entity_id)
          .single();

        // Log compensation entry — insert directly to get the ID back
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          const description = buildCompensationDescription(
            log.entity_name,
            compensatingFields,
            entity,
          );
          const { data: compEntry } = await supabase
            .from("activity_log")
            .insert({
              user_id: user.id,
              action: "updated",
              entity_type: log.entity_type,
              entity_name: log.entity_name,
              description,
              entity_id: log.entity_id,
              entity_table: effectiveTable,
              before_snapshot: entity,
              after_snapshot: afterEntity,
              compensates_for: log.id,
              is_adjustment: false,
              delta_usd: null,
              delta_eur: null,
            })
            .select("id")
            .single();

          compensationId = compEntry?.id;
        }

        break;
      }

      default:
        return {
          success: false,
          message: `Cannot undo action type "${log.action}"`,
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { success: false, message: `Undo failed: ${msg}` };
  }

  // ── Mark the original entry as undone ─
  await supabase
    .from("activity_log")
    .update({ undone_at: new Date().toISOString() })
    .eq("id", log.id);

  // ── If this was a compensation entry being undone (redo), restore the original ─
  if (log.compensates_for) {
    await supabase
      .from("activity_log")
      .update({ undone_at: null })
      .eq("id", log.compensates_for);
  }

  // For created/removed, log a simple non-undoable undo entry
  if (log.action !== "updated") {
    await logActivity({
      action: "undone",
      entity_type: log.entity_type,
      entity_name: log.entity_name,
      description: `Undid "${log.action}" on ${log.entity_name}`,
    });
  }

  return {
    success: true,
    message: `Successfully undid "${log.action}" on ${log.entity_name}`,
    compensationId,
  };
}

// ─── Transfer group undo ────────────────────────────────

/**
 * Rollback a compensation entry when a multi-leg transfer undo fails
 * partway through. Uses snapshot restoration — safe because the
 * compensation was created milliseconds ago (no intermediate changes).
 */
async function rollbackCompensation(
  compensationId: string,
  originalEntryId: string,
  supabase: SupabaseClient,
): Promise<void> {
  const { data: comp } = await supabase
    .from("activity_log")
    .select("*")
    .eq("id", compensationId)
    .single();

  if (!comp?.entity_id || !comp?.entity_table || !comp?.before_snapshot) return;

  const snapshot = comp.before_snapshot as Record<string, unknown>;
  const restoreFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (!IMMUTABLE_COLUMNS.has(key)) {
      restoreFields[key] = value;
    }
  }

  if (Object.keys(restoreFields).length > 0) {
    await supabase
      .from(resolveTable(comp.entity_table as string))
      .update(restoreFields)
      .eq("id", comp.entity_id as string);
  }

  // Clean up: delete the compensation entry and restore the original
  await supabase.from("activity_log").delete().eq("id", compensationId);
  await supabase
    .from("activity_log")
    .update({ undone_at: null })
    .eq("id", originalEntryId);
}

/**
 * Undo all legs of a transfer group sequentially.
 * If any leg fails, auto-rollback all previously completed legs.
 */
async function undoTransferGroup(
  entries: ActivityLog[],
  supabase: SupabaseClient,
): Promise<{ success: boolean; message: string }> {
  const completed: { compensationId: string; originalId: string }[] = [];

  for (const entry of entries) {
    if (entry.undone_at) continue;

    const result = await undoSingleEntry(entry, supabase);

    if (!result.success) {
      // Auto-rollback all previously completed compensations
      for (const { compensationId, originalId } of completed) {
        try {
          await rollbackCompensation(compensationId, originalId, supabase);
        } catch {
          // Best effort — rollback failure is logged but doesn't throw
          console.error(`Failed to rollback compensation ${compensationId}`);
        }
      }
      return { success: false, message: `Transfer undo failed: ${result.message}` };
    }

    if (result.compensationId) {
      completed.push({ compensationId: result.compensationId, originalId: entry.id });
    }
  }

  return {
    success: true,
    message: `Transfer reversed (${completed.length} leg${completed.length !== 1 ? "s" : ""} undone)`,
  };
}

// ─── Main entry point ───────────────────────────────────

/**
 * Undo a previously logged activity.
 *
 * - "created"  → soft-delete the entity
 * - "removed"  → restore the entity (clear deleted_at)
 * - "updated"  → compensating transaction (delta reversal for value fields,
 *                safe restore for identity fields)
 * - Transfer groups → sequential undo with auto-rollback on failure
 */
export async function undoActivity(
  activityLogId: string
): Promise<{ success: boolean; message: string }> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, message: "Not authenticated" };

  // ── Fetch the log entry ─
  const { data: entry, error: fetchErr } = await supabase
    .from("activity_log")
    .select("*")
    .eq("id", activityLogId)
    .single();

  if (fetchErr || !entry) {
    return { success: false, message: "Activity log entry not found" };
  }

  const log = entry as ActivityLog;

  // ── Guard: already undone ─
  if (log.undone_at) {
    return { success: false, message: "This action has already been undone" };
  }

  // ── Guard: already compensated (double-undo prevention) ─
  if (log.action === "updated") {
    const { data: existingComp } = await supabase
      .from("activity_log")
      .select("id")
      .eq("compensates_for", log.id)
      .is("undone_at", null)
      .limit(1);

    if (existingComp?.length) {
      return { success: false, message: "This action has already been reversed" };
    }
  }

  // ── Transfer group undo — sequential with auto-rollback ─
  if (log.transfer_group_id) {
    const { data: groupEntries, error: groupErr } = await supabase
      .from("activity_log")
      .select("*")
      .eq("transfer_group_id", log.transfer_group_id)
      .is("undone_at", null)
      .order("created_at", { ascending: true });

    if (groupErr || !groupEntries?.length) {
      return { success: false, message: "Could not fetch transfer group entries" };
    }

    const result = await undoTransferGroup(
      groupEntries as ActivityLog[],
      supabase,
    );
    if (result.success) revalidateDashboard();
    return result;
  }

  // ── Single-entry undo ─
  const result = await undoSingleEntry(log, supabase);
  if (result.success) revalidateDashboard();
  return result;
}

/** Revalidate all dashboard paths after a successful undo. */
function revalidateDashboard() {
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/crypto");
  revalidatePath("/dashboard/stocks");
  revalidatePath("/dashboard/accounts");
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard/diary");
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/history");
}
