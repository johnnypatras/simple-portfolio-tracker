"use server";

import { revalidateDashboard } from "@/lib/actions/revalidate";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { validateUUID, validateAmount } from "@/lib/validation";
import { isValidPastOrTodayDate, extractQuantity, splitDirectionForParent } from "@/lib/split-helpers";
import type { ActivityLog, EntityType, SplitLeg } from "@/lib/types";
import { round2 } from "@/lib/format";
import { captureAction } from "@/lib/actions/with-sentry";
import { CASHFLOW_PRODUCING_ENTITY_TYPES } from "@/lib/cashflow";
import { computeDeltaFromSnapshots, toUsdAndEur } from "@/lib/actions/activity-log";
import { COST_COPY } from "@/lib/cost-basis-copy";

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

  // ── Backdate-recompute: update cashflow_amount_* to historical price at new date ──
  //
  // Only applies when ALL of the following are true:
  //   - effectiveDate is being SET (not cleared — no date → no price to look up)
  //   - The entry is a real cash flow (not an adjustment — adjustments use delta_*)
  //   - The entity type produces cashflows (diary entries, etc. don't have cashflow_amount_*)
  //   - AND one of:
  //       · is_yield=true — Model B: a yield row's S&P flow IS its market value at
  //         the receipt date, so a backdate MUST revalue it to the price at the new
  //         date. A "cost" on a yield row is meaningless (cost is 0 by definition),
  //         so any cashflow_user_set flag is ignored here and cleared below.
  //       · cashflow_user_set=false — an auto-derived (market-value) amount is
  //         re-derived at the new date.
  //   A NON-yield user-supplied cost (cashflow_user_set=true) is NEVER overwritten —
  //   the user's intentional cost basis stands regardless of the effective date.
  //
  // Transfer legs are excluded by the is_adjustment check (both legs are is_adjustment=true).
  // The recompute is best-effort: a price-fetch failure logs an error but does not fail the
  // backdate operation itself (the effective_date update already succeeded).
  const cashflowUserSet = log.cashflow_user_set;
  const isYield = log.is_yield;
  const isCashflowProducingEntity = (CASHFLOW_PRODUCING_ENTITY_TYPES as readonly string[]).includes(log.entity_type);

  if (
    effectiveDate !== null &&
    !log.is_adjustment &&
    (isYield || !cashflowUserSet) &&
    isCashflowProducingEntity
  ) {
    try {
      const recomputed = await computeDeltaFromSnapshots(
        log.entity_type as EntityType,
        log.action,
        effectiveDate,
        log.before_snapshot,
        log.after_snapshot,
        supabase,
      );
      // A backdated YIELD row is now auto-derived at the new date, so its
      // provenance must read auto (cashflow_user_set=false) — a user-set "cost"
      // on a yield row is meaningless and must not survive the revalue. The
      // non-yield path writes ONLY the two amount columns (byte-identical to the
      // pre-Model-B behavior), so the payload is built conditionally.
      const cfUpdate: {
        cashflow_amount_usd: number;
        cashflow_amount_eur: number;
        cashflow_user_set?: boolean;
      } = {
        cashflow_amount_usd: round2(recomputed.usd),
        cashflow_amount_eur: round2(recomputed.eur),
      };
      if (isYield) cfUpdate.cashflow_user_set = false;
      const { error: cfUpdateErr } = await supabase
        .from("activity_log")
        .update(cfUpdate)
        .eq("id", entryId)
        .eq("user_id", user.id);
      if (cfUpdateErr) {
        console.error("[splits.backdateActivityEntry] Cashflow recompute write failed:", cfUpdateErr.message);
      }
    } catch (err) {
      // Price fetch failed (API down, missing data, etc.). The effective_date change
      // already succeeded — log the error but do not roll back or fail the operation.
      // The stale cashflow_amount_* will self-heal if the user retries or the backfill runs.
      console.error(
        "[splits.backdateActivityEntry] Cashflow recompute failed (stale amount kept):",
        err instanceof Error ? err.message : err,
      );
    }
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

  // Inherited cost-basis flags — now typed directly on ActivityLog.
  const parentIsYield = parent.is_yield;
  const parentCashflowUserSet = parent.cashflow_user_set;

  // Validate dates, quantities, and per-leg costs
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
    if (leg.cost != null) {
      // Yield has no cost (earned income, cost 0) — reject an explicit leg-cost
      // on a yield parent, mirroring the addTransaction yield contract.
      if (parentIsYield) {
        return { success: false, message: COST_COPY.yieldHasNoCost };
      }
      // Adjustments carry delta_*, not cashflow_amount_* — a per-leg cost is
      // only meaningful for real (non-adjustment) cash flows.
      if (isAdj) {
        return { success: false, message: "Cannot set a per-leg cost on an adjustment split" };
      }
      validateAmount(leg.cost.amount, "Cost");
    }
  }

  // Parent-derived split direction stored on EVERY child (legs are always
  // positive; the disposal/acquisition sign comes from the parent). A SELL
  // parent → -1 so the cost engine's quantityDelta keeps each child a disposal.
  const splitDirection = splitDirectionForParent(parent);

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

  // ── Per-leg cost overrides (DCA) ──
  // Resolve the dual-currency cost for each leg that carries an explicit cost
  // BEFORE the synchronous distribution pass. The user's typed currency is
  // stored EXACTLY (all decimals preserved); only the cross-currency derived
  // leg is round2'd — the addTransaction case-16 pattern. toUsdAndEur THROWS on
  // FX failure (never silently writes a 1:1 rate); captureAction surfaces it.
  // Cost-bearing legs are EXCLUDED from the proportional pool below.
  const legCostOverrides = new Array<{ usd: number; eur: number } | null>(legs.length).fill(null);
  for (let i = 0; i < legs.length; i++) {
    const cost = legs[i].cost;
    if (cost == null) continue;
    const derived = await toUsdAndEur(cost.amount, cost.currency, legs[i].effective_date);
    legCostOverrides[i] =
      cost.currency === "EUR"
        ? { eur: cost.amount, usd: round2(derived.usd) }
        : { usd: cost.amount, eur: round2(derived.eur) };
  }

  // The proportional remainder ("last child absorbs the rounding penny") is
  // distributed across the legs that DON'T carry an explicit cost. When no leg
  // carries a cost this is exactly the legs array, so the distribution — and
  // hence every child amount — stays byte-identical to the pre-cost behavior.
  const lastNoCostIdx = (() => {
    for (let i = legs.length - 1; i >= 0; i--) {
      if (legCostOverrides[i] == null) return i;
    }
    return -1; // every leg carries an explicit cost (non-adjustment only)
  })();

  // Pre-compute the no-cost pool: parent amount minus what costed legs claim,
  // clamped ≥ 0 so a costed-over-budget entry can't produce negative children.
  // Σ(children) == parent in BOTH currencies (last no-cost leg absorbs rounding).
  // When NO leg is costed noCostBaseUsd/Eur equals the full parent → identical to
  // the old behavior byte-for-byte.
  const noCostBaseUsd = Math.max(
    0,
    (parent.cashflow_amount_usd ?? 0) -
      legCostOverrides.reduce((s, o) => s + (o != null ? o.usd : 0), 0),
  );
  const noCostBaseEur = Math.max(
    0,
    (parent.cashflow_amount_eur ?? 0) -
      legCostOverrides.reduce((s, o) => s + (o != null ? o.eur : 0), 0),
  );
  // Fractions for no-cost legs are proportional to their share of the NO-COST
  // quantity total (not the overall totalQty which includes costed legs).
  const noCostQtyTotal = legs.reduce(
    (s, leg, i) => s + (legCostOverrides[i] == null ? leg.quantity : 0),
    0,
  );

  // ── Create children ──
  const children = [];
  let runningDeltaUsd = 0;
  let runningDeltaEur = 0;
  let runningNoCostUsd = 0;
  let runningNoCostEur = 0;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const isLast = i === legs.length - 1;
    const costOverride = legCostOverrides[i];

    // Rounding safety: last child gets the remainder
    let childDeltaUsd: number | null = null;
    let childDeltaEur: number | null = null;
    let childCashflowUsd: number | null = null;
    let childCashflowEur: number | null = null;
    // Children inherit the parent's cashflow_user_set; an explicit leg-cost
    // overrides it to true (audit-3: a split yield/user-costed lot must not
    // silently become a market-value buy the benchmark re-counts).
    let childCashflowUserSet = parentCashflowUserSet;

    if (isAdj) {
      // Adjustments never carry a per-leg cost (rejected above) — proportional
      // delta distribution, unchanged.
      const adjFraction = leg.quantity / Math.abs(totalQty);
      if (isLast) {
        childDeltaUsd = (parent.delta_usd ?? 0) - runningDeltaUsd;
        childDeltaEur = (parent.delta_eur ?? 0) - runningDeltaEur;
      } else {
        childDeltaUsd = round2((parent.delta_usd ?? 0) * adjFraction);
        childDeltaEur = round2((parent.delta_eur ?? 0) * adjFraction);
        runningDeltaUsd += childDeltaUsd;
        runningDeltaEur += childDeltaEur;
      }
    } else if (costOverride != null) {
      // Explicit per-leg cost: store the entered amount verbatim. Excluded from
      // the proportional pool, so it does NOT touch the running totals.
      childCashflowUsd = costOverride.usd;
      childCashflowEur = costOverride.eur;
      childCashflowUserSet = true;
    } else {
      // No-cost leg: proportional split of the NO-COST pool (noCostBaseUsd/Eur =
      // parent minus costed legs' amounts, clamped ≥ 0). Fractions are over the
      // NO-COST quantity total so Σ(no-cost children) === noCostBase. The LAST
      // no-cost leg absorbs the rounding remainder, guaranteeing Σ(all children)
      // === parent in BOTH currencies.
      const noCostFraction = noCostQtyTotal > 0 ? leg.quantity / noCostQtyTotal : 0;
      if (i === lastNoCostIdx) {
        childCashflowUsd = noCostBaseUsd - runningNoCostUsd;
        childCashflowEur = noCostBaseEur - runningNoCostEur;
      } else {
        childCashflowUsd = round2(noCostBaseUsd * noCostFraction);
        childCashflowEur = round2(noCostBaseEur * noCostFraction);
        runningNoCostUsd += childCashflowUsd;
        runningNoCostEur += childCashflowEur;
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
      // split_quantity STAYS POSITIVE; split_direction carries the sign so the
      // cost engine (quantityDelta) and #94 augmentation reconstruct disposals.
      details: { split_quantity: leg.quantity, split_direction: splitDirection },
      is_adjustment: parent.is_adjustment,
      // Children inherit is_yield: a split of a yield lot stays earned income
      // (cost 0), never a cost-bearing buy the benchmark counts as a contribution.
      is_yield: parentIsYield,
      cashflow_user_set: isAdj ? false : childCashflowUserSet,
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
