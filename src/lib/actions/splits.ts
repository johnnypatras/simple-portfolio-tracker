"use server";

import { revalidateDashboard } from "@/lib/actions/revalidate";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { validateUUID } from "@/lib/validation";
import { isValidPastOrTodayDate, extractQuantity } from "@/lib/split-helpers";
import type { ActivityLog, SplitLeg } from "@/lib/types";
import { round2 } from "@/lib/format";
import { captureAction } from "@/lib/actions/with-sentry";

// ── Helpers ──────────────────────────────────────────────

// ── Operation 1: Simple Backdate ─────────────────────────

export async function backdateActivityEntry(
  entryId: string,
  effectiveDate: string | null,
): Promise<{ success: boolean; message: string }> {
  return captureAction("splits.backdateActivityEntry", async () => {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, message: "Not authenticated" };

  validateUUID(entryId, "Entry ID");
  if (effectiveDate !== null) {
    if (!isValidPastOrTodayDate(effectiveDate)) {
      return { success: false, message: "Effective date must be a valid past or today date" };
    }
  }

  // Fetch entry
  const { data: entry, error } = await supabase
    .from("activity_log")
    .select("*")
    .eq("id", entryId)
    .eq("user_id", user.id)
    .single();

  if (error || !entry) return { success: false, message: "Entry not found" };
  const log = entry as ActivityLog;

  if (log.undone_at) return { success: false, message: "Cannot backdate an undone entry" };
  if (log.split_from_id) return { success: false, message: "Cannot backdate a split child — unsplit first" };

  // For transfer legs: set on all legs in the group
  if (log.transfer_group_id) {
    const { error: updateErr } = await supabase
      .from("activity_log")
      .update({ effective_date: effectiveDate })
      .eq("transfer_group_id", log.transfer_group_id)
      .eq("user_id", user.id);
    if (updateErr) return { success: false, message: updateErr.message };
  } else {
    const { error: updateErr } = await supabase
      .from("activity_log")
      .update({ effective_date: effectiveDate })
      .eq("id", entryId)
      .eq("user_id", user.id);
    if (updateErr) return { success: false, message: updateErr.message };
  }

  revalidateDashboard();
  return { success: true, message: effectiveDate ? `Effective date set to ${effectiveDate}` : "Effective date cleared" };
  });
}

// ── Operation 2: Split + Backdate ────────────────────────

export async function splitActivityEntry(
  parentId: string,
  legs: SplitLeg[],
): Promise<{ success: boolean; message: string }> {
  return captureAction("splits.splitActivityEntry", async () => {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, message: "Not authenticated" };

  validateUUID(parentId, "Parent entry ID");

  // Fetch parent
  const { data: entry, error } = await supabase
    .from("activity_log")
    .select("*")
    .eq("id", parentId)
    .eq("user_id", user.id)
    .single();

  if (error || !entry) return { success: false, message: "Entry not found" };
  const parent = entry as ActivityLog;

  // ── Validations ──
  if (parent.undone_at) return { success: false, message: "Cannot split an undone entry" };
  if (parent.split_from_id) return { success: false, message: "Cannot split a child entry (no recursive splits)" };
  if (parent.compensates_for) return { success: false, message: "Cannot split a compensation entry" };
  if (parent.transfer_group_id) return { success: false, message: "Cannot split a transfer leg" };

  const isAdj = parent.is_adjustment;
  if (isAdj && parent.delta_status !== "complete") {
    return { success: false, message: "Cannot split — delta status is not complete" };
  }
  if (!isAdj && parent.cashflow_status !== "complete") {
    return { success: false, message: "Cannot split — cashflow status is not complete" };
  }

  if (legs.length < 2) return { success: false, message: "Need at least 2 date allocations" };

  // Validate dates
  const dates = new Set<string>();
  for (const leg of legs) {
    if (!isValidPastOrTodayDate(leg.effective_date)) {
      return { success: false, message: `Invalid date: ${leg.effective_date}` };
    }
    if (dates.has(leg.effective_date)) {
      return { success: false, message: `Duplicate date: ${leg.effective_date}` };
    }
    dates.add(leg.effective_date);
    if (leg.quantity <= 0) {
      return { success: false, message: "All quantities must be positive" };
    }
  }

  // Extract original quantity
  const totalQty = extractQuantity(parent);
  if (totalQty === null || totalQty === 0) {
    return { success: false, message: "Cannot determine original quantity from snapshots" };
  }

  const legSum = legs.reduce((s, l) => s + l.quantity, 0);
  const tolerance = Math.abs(totalQty) * 0.0001; // 0.01% tolerance for floating point
  if (Math.abs(legSum - Math.abs(totalQty)) > tolerance) {
    return { success: false, message: `Leg quantities (${legSum}) must equal original quantity (${Math.abs(totalQty)})` };
  }

  // ── Create children ──
  const children = [];
  let runningDeltaUsd = 0;
  let runningDeltaEur = 0;
  let runningCashflowUsd = 0;
  let runningCashflowEur = 0;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const isLast = i === legs.length - 1;
    const fraction = leg.quantity / Math.abs(totalQty);

    // Rounding safety: last child gets the remainder
    let childDeltaUsd: number | null = null;
    let childDeltaEur: number | null = null;
    let childCashflowUsd: number | null = null;
    let childCashflowEur: number | null = null;

    if (isAdj) {
      if (isLast) {
        childDeltaUsd = (parent.delta_usd ?? 0) - runningDeltaUsd;
        childDeltaEur = (parent.delta_eur ?? 0) - runningDeltaEur;
      } else {
        childDeltaUsd = round2((parent.delta_usd ?? 0) * fraction);
        childDeltaEur = round2((parent.delta_eur ?? 0) * fraction);
        runningDeltaUsd += childDeltaUsd;
        runningDeltaEur += childDeltaEur;
      }
    } else {
      if (isLast) {
        childCashflowUsd = (parent.cashflow_amount_usd ?? 0) - runningCashflowUsd;
        childCashflowEur = (parent.cashflow_amount_eur ?? 0) - runningCashflowEur;
      } else {
        childCashflowUsd = round2((parent.cashflow_amount_usd ?? 0) * fraction);
        childCashflowEur = round2((parent.cashflow_amount_eur ?? 0) * fraction);
        runningCashflowUsd += childCashflowUsd;
        runningCashflowEur += childCashflowEur;
      }
    }

    children.push({
      user_id: user.id,
      action: parent.action,
      entity_type: parent.entity_type,
      entity_id: parent.entity_id,
      entity_table: parent.entity_table,
      entity_name: parent.entity_name,
      description: `Split: ${leg.quantity} effective ${leg.effective_date}`,
      details: { split_quantity: leg.quantity },
      is_adjustment: parent.is_adjustment,
      effective_date: leg.effective_date,
      split_from_id: parent.id,
      delta_usd: childDeltaUsd,
      delta_eur: childDeltaEur,
      delta_status: isAdj ? "complete" : null,
      cashflow_amount_usd: childCashflowUsd,
      cashflow_amount_eur: childCashflowEur,
      cashflow_asset_class: isAdj ? null : parent.cashflow_asset_class,
      cashflow_status: isAdj ? null : "complete",
      before_snapshot: null,
      after_snapshot: null,
    });
  }

  // Insert children
  const { error: insertErr } = await supabase.from("activity_log").insert(children);
  if (insertErr) return { success: false, message: `Failed to create split children: ${insertErr.message}` };

  // Mark parent as undone (only undone_at — preserve all financial fields)
  const { error: undoErr } = await supabase
    .from("activity_log")
    .update({ undone_at: new Date().toISOString() })
    .eq("id", parentId)
    .eq("user_id", user.id);
  if (undoErr) return { success: false, message: `Failed to mark parent as undone: ${undoErr.message}` };

  revalidateDashboard();
  return { success: true, message: `Split into ${legs.length} date allocations` };
  });
}

// ── Operation 3: Unsplit ─────────────────────────────────

export async function unsplitActivityEntry(
  parentId: string,
): Promise<{ success: boolean; message: string }> {
  return captureAction("splits.unsplitActivityEntry", async () => {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, message: "Not authenticated" };

  validateUUID(parentId, "Parent entry ID");

  // Find children
  const { data: children, error: childErr } = await supabase
    .from("activity_log")
    .select("id, undone_at")
    .eq("split_from_id", parentId)
    .eq("user_id", user.id);

  if (childErr) return { success: false, message: childErr.message };
  if (!children?.length) return { success: false, message: "No split children found" };

  // Block unsplit if any child has been individually undone
  if (children.some((c) => c.undone_at !== null)) {
    return { success: false, message: "Cannot unsplit — one or more split legs have been individually undone. Redo them first." };
  }

  // Hard-delete children
  const { error: deleteErr } = await supabase
    .from("activity_log")
    .delete()
    .eq("split_from_id", parentId)
    .eq("user_id", user.id);
  if (deleteErr) return { success: false, message: `Failed to delete children: ${deleteErr.message}` };

  // Restore parent (clear undone_at)
  const { error: restoreErr } = await supabase
    .from("activity_log")
    .update({ undone_at: null })
    .eq("id", parentId)
    .eq("user_id", user.id);
  if (restoreErr) return { success: false, message: `Failed to restore parent: ${restoreErr.message}` };

  revalidateDashboard();
  return { success: true, message: "Split reversed — original entry restored" };
  });
}
