"use server";

import * as Sentry from "@sentry/nextjs";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActivityLog } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";
import { revalidateDashboard } from "@/lib/actions/revalidate";
import { resolveTable, remapSnapshotFields } from "@/lib/undo-remap";
import { normalizeActivityLogRow } from "@/lib/activity-log-normalize";
import { validateUUID } from "@/lib/validation";
import { PGRST_NO_ROWS } from "@/lib/supabase/error-codes";
import { computeCompensatingUpdate, IMMUTABLE_COLUMNS } from "@/lib/compensating-update";

// ─── Field classification ─────────────────────────────────
// Pure compensation logic (IMMUTABLE_COLUMNS, BADGE_COLUMNS, VALUE_FIELDS,
// computeCompensatingUpdate) lives in @/lib/compensating-update so it can be
// unit-tested without the "use server" DB-touching wrapper.

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

/** Tables that have a direct user_id column (for defense-in-depth filtering). */
const TABLES_WITH_USER_ID = new Set([
  "crypto_assets", "stock_assets", "cash_accounts",
  "wallets", "brokers", "institutions",
  "trade_entries", "diary_entries",
]);

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
  userId: string,
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
  let entityQuery = supabase
    .from(effectiveTable)
    .select("*")
    .eq("id", log.entity_id);
  if (TABLES_WITH_USER_ID.has(effectiveTable)) {
    entityQuery = entityQuery.eq("user_id", userId);
  }
  const { data: existing, error: fetchErr } = await entityQuery.single();
  // PGRST116 = no rows returned (genuinely missing record). Any other
  // error is a DB/network failure that should surface as a retry prompt
  // rather than a misleading "record no longer exists" message.
  if (fetchErr && fetchErr.code !== PGRST_NO_ROWS) {
    console.error("[undo] Entity fetch failed:", fetchErr.message);
    return {
      success: false,
      message: "Failed to load the original record — please try again",
    };
  }

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
        let q = supabase
          .from(effectiveTable)
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", log.entity_id);
        if (TABLES_WITH_USER_ID.has(effectiveTable)) q = q.eq("user_id", userId);
        const { error } = await q;
        if (error) throw error;
        break;
      }

      case "removed": {
        let q = supabase
          .from(effectiveTable)
          .update({ deleted_at: null })
          .eq("id", log.entity_id);
        if (TABLES_WITH_USER_ID.has(effectiveTable)) q = q.eq("user_id", userId);
        const { error } = await q;
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

        // Apply the compensating update — defense-in-depth user_id filter
        // matches the convention used in the "created"/"removed" branches
        // (lines ~142 / ~153). RLS already scopes by auth.uid(), but the
        // explicit filter is the documented project standard.
        let compQuery = supabase
          .from(effectiveTable)
          .update(compensatingFields)
          .eq("id", log.entity_id);
        if (TABLES_WITH_USER_ID.has(effectiveTable)) {
          compQuery = compQuery.eq("user_id", userId);
        }
        const { error } = await compQuery;
        if (error) throw error;

        // Read entity after compensation for the after_snapshot. If this
        // read fails, we'd silently write null into after_snapshot and
        // mark the entry undone — log the error so it surfaces instead.
        let afterRead = supabase
          .from(effectiveTable)
          .select("*")
          .eq("id", log.entity_id);
        if (TABLES_WITH_USER_ID.has(effectiveTable)) {
          afterRead = afterRead.eq("user_id", userId);
        }
        const { data: afterEntity, error: afterErr } = await afterRead.single();
        if (afterErr) {
          console.error(`[undo] Failed to read after-snapshot for ${effectiveTable}/${log.entity_id}:`, afterErr.message);
          Sentry.captureException(afterErr, {
            tags: { action: "undo.afterEntitySnapshot", entity_table: effectiveTable },
          });
        }

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
          const { data: compEntry, error: compErr } = await supabase
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
              delta_status: null,
              cashflow_status: null,
            })
            .select("id")
            .single();

          if (compErr) {
            console.error("[undo] Failed to insert compensation log entry:", compErr.message);
          }
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
    Sentry.captureException(err, {
      tags: {
        action: "undo.undoEntry",
        entity_type: log.entity_type,
        log_action: log.action,
      },
    });
    return { success: false, message: `Undo failed: ${msg}` };
  }

  // ── Mark the original entry as undone ─
  const { error: undoneAtError } = await supabase
    .from("activity_log")
    .update({ undone_at: new Date().toISOString() })
    .eq("id", log.id)
    .eq("user_id", userId);
  if (undoneAtError) {
    console.error("[undo] failed to set undone_at:", undoneAtError.message);
    return {
      success: true,
      message: `Undid "${log.action}" on ${log.entity_name} — warning: entry may appear re-undoable. Please refresh.`,
      compensationId,
    };
  }

  // ── If this was a compensation entry being undone (redo), restore the original ─
  if (log.compensates_for) {
    const { error: restoreErr } = await supabase
      .from("activity_log")
      .update({ undone_at: null })
      .eq("id", log.compensates_for)
      .eq("user_id", userId);
    if (restoreErr) console.error("[undo] failed to restore compensated entry:", restoreErr.message);
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
  userId: string,
): Promise<void> {
  const { data: comp } = await supabase
    .from("activity_log")
    .select("*")
    .eq("id", compensationId)
    .eq("user_id", userId)
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
    const effectiveTable = resolveTable(comp.entity_table as string);
    let entityRestore = supabase
      .from(effectiveTable)
      .update(restoreFields)
      .eq("id", comp.entity_id as string);
    if (TABLES_WITH_USER_ID.has(effectiveTable)) {
      entityRestore = entityRestore.eq("user_id", userId);
    }
    const { error: restoreErr } = await entityRestore;
    if (restoreErr) console.error("[undo] Rollback entity restore failed:", restoreErr.message);
  }

  // Clean up: delete the compensation entry and restore the original
  await supabase.from("activity_log").delete().eq("id", compensationId).eq("user_id", userId);
  await supabase
    .from("activity_log")
    .update({ undone_at: null })
    .eq("id", originalEntryId)
    .eq("user_id", userId);
}

/**
 * Undo all legs of a transfer group sequentially.
 * If any leg fails, auto-rollback all previously completed legs.
 */
async function undoTransferGroup(
  entries: ActivityLog[],
  supabase: SupabaseClient,
  userId: string,
): Promise<{ success: boolean; message: string }> {
  const completed: { compensationId: string; originalId: string }[] = [];

  for (const entry of entries) {
    if (entry.undone_at) continue;

    const result = await undoSingleEntry(entry, supabase, userId);

    if (!result.success) {
      // Auto-rollback all previously completed compensations
      for (const { compensationId, originalId } of completed) {
        try {
          await rollbackCompensation(compensationId, originalId, supabase, userId);
        } catch (rollbackErr) {
          // Best effort — rollback failure is logged but doesn't throw
          console.error(`Failed to rollback compensation ${compensationId}`, rollbackErr);
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

  validateUUID(activityLogId, "Activity log ID");

  // ── Fetch the log entry ─
  const { data: entry, error: fetchErr } = await supabase
    .from("activity_log")
    .select("*")
    .eq("id", activityLogId)
    .eq("user_id", user.id)
    .single();

  if (fetchErr || !entry) {
    return { success: false, message: "Activity log entry not found" };
  }

  const log = normalizeActivityLogRow(entry);

  // ── Split checks (before undone_at guard — split parents have undone_at set) ─

  // Check if this entry has split children (user wants to unsplit)
  const { data: splitChildren } = await supabase
    .from("activity_log")
    .select("id")
    .eq("split_from_id", log.id)
    .eq("user_id", user.id)
    .limit(1);

  if (splitChildren?.length) {
    const { unsplitActivityEntry } = await import("@/lib/actions/splits");
    const result = await unsplitActivityEntry(log.id);
    if (result.success) revalidateDashboard();
    return result;
  }

  // Check if this IS a split child (redirect to parent unsplit)
  if (log.split_from_id) {
    const { unsplitActivityEntry } = await import("@/lib/actions/splits");
    const result = await unsplitActivityEntry(log.split_from_id);
    if (result.success) revalidateDashboard();
    return result;
  }

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
      .eq("user_id", user.id)
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
      .eq("user_id", user.id)
      .is("undone_at", null)
      .order("created_at", { ascending: true });

    if (groupErr || !groupEntries?.length) {
      return { success: false, message: "Could not fetch transfer group entries" };
    }

    const result = await undoTransferGroup(
      groupEntries.map(normalizeActivityLogRow),
      supabase,
      user.id,
    );
    if (result.success) revalidateDashboard();
    return result;
  }

  // ── Single-entry undo ─
  const result = await undoSingleEntry(log, supabase, user.id);
  if (result.success) revalidateDashboard();
  return result;
}

