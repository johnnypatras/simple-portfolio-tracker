"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ActivityLog } from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";

/** Columns that must never be overwritten when restoring a before_snapshot. */
const IMMUTABLE_COLUMNS = new Set([
  "id",
  "user_id",
  "created_at",
  "updated_at",
  "deleted_at",
]);

/**
 * Undo a previously logged activity.
 *
 * - Undo "created"  → soft-delete the entity
 * - Undo "removed"  → restore the entity (clear deleted_at; cascade trigger restores children)
 * - Undo "updated"  → restore before_snapshot field values
 */
export async function undoActivity(
  activityLogId: string
): Promise<{ success: boolean; message: string }> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, message: "Not authenticated" };

  // ── Fetch the log entry ──────────────────────────────────
  const { data: entry, error: fetchErr } = await supabase
    .from("activity_log")
    .select("*")
    .eq("id", activityLogId)
    .single();

  if (fetchErr || !entry) {
    return { success: false, message: "Activity log entry not found" };
  }

  const log = entry as ActivityLog;

  // ── Guard: already undone ────────────────────────────────
  if (log.undone_at) {
    return { success: false, message: "This action has already been undone" };
  }

  // ── Guard: missing undo metadata (pre-migration entries) ─
  if (!log.entity_id || !log.entity_table) {
    return {
      success: false,
      message: "This action predates the undo system and cannot be reversed",
    };
  }

  // ── Guard: entity still exists and is in the correct state ─
  const { data: existing } = await supabase
    .from(log.entity_table)
    .select("id, deleted_at")
    .eq("id", log.entity_id)
    .single();

  if (!existing) {
    return {
      success: false,
      message: "The original record no longer exists (may have been permanently deleted)",
    };
  }

  // Verify the entity is in the expected state for the undo operation
  if (log.action === "created" && existing.deleted_at !== null) {
    return { success: false, message: "This entity has already been deleted" };
  }
  if (log.action === "removed" && existing.deleted_at === null) {
    return { success: false, message: "This entity has already been restored" };
  }
  if (log.action === "updated" && existing.deleted_at !== null) {
    return { success: false, message: "Cannot undo update — the entity has been deleted" };
  }

  // ── Perform the reversal ─────────────────────────────────
  try {
    switch (log.action) {
      case "created": {
        // Undo creation → soft-delete the entity
        const { error } = await supabase
          .from(log.entity_table)
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", log.entity_id);

        if (error) throw error;
        break;
      }

      case "removed": {
        // Undo removal → restore the entity (cascade trigger restores children)
        const { error } = await supabase
          .from(log.entity_table)
          .update({ deleted_at: null })
          .eq("id", log.entity_id);

        if (error) throw error;
        break;
      }

      case "updated": {
        // Undo update → restore before_snapshot values
        if (!log.before_snapshot) {
          return {
            success: false,
            message: "No before-snapshot available to restore",
          };
        }

        // Strip immutable columns from the snapshot
        const restoreFields: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(log.before_snapshot)) {
          if (!IMMUTABLE_COLUMNS.has(key)) {
            restoreFields[key] = value;
          }
        }

        if (Object.keys(restoreFields).length === 0) {
          return { success: false, message: "No restorable fields in snapshot" };
        }

        const { error } = await supabase
          .from(log.entity_table)
          .update(restoreFields)
          .eq("id", log.entity_id);

        if (error) throw error;
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

  // ── Mark the log entry as undone ─────────────────────────
  await supabase
    .from("activity_log")
    .update({ undone_at: new Date().toISOString() })
    .eq("id", activityLogId);

  // ── Log the undo itself (no entity_id so this entry is non-undoable) ──
  await logActivity({
    action: "updated",
    entity_type: log.entity_type,
    entity_name: log.entity_name,
    description: `Undid "${log.action}" on ${log.entity_name}`,
  });

  // ── Revalidate all dashboard paths ───────────────────────
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/crypto");
  revalidatePath("/dashboard/stocks");
  revalidatePath("/dashboard/accounts");
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard/diary");
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/history");

  return { success: true, message: `Successfully undid "${log.action}" on ${log.entity_name}` };
}
