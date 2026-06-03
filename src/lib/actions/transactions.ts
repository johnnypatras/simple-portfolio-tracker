"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidateDashboard } from "@/lib/actions/revalidate";
import { upsertPosition } from "@/lib/actions/crypto";
import { upsertStockPosition } from "@/lib/actions/stocks";
import { validateUUID } from "@/lib/validation";
import { captureAction } from "@/lib/actions/with-sentry";
import type { AssetRef, UsdEurAmount } from "@/lib/types";

// ─── addTransaction ──────────────────────────────────────────────────────────

export interface AddTransactionParams {
  /** "buy" increases quantity; "sell" decreases. Task 2.5 adds full action routing. */
  action: "buy" | "sell";
  quantity: number;
  /** Market price in USD — used as cashflow fallback when costAmount is absent. */
  currentPriceUsd?: number;
  /** Market price in EUR — used as cashflow fallback when costAmount is absent. */
  currentPriceEur?: number;
  /**
   * Caller-supplied cost basis. When present the primitive layer stores it
   * verbatim (cashflow_user_set=true). When absent the action falls back to
   * market-value (cashflow_user_set=false).
   *
   * Task 2.5 expands: single-currency input → FX-at-date derivation (so the
   * caller can pass just EUR or just USD and have the other computed), full
   * guard set, markAsYield, deposit/withdrawal/transfer/yield routing.
   */
  costAmount?: UsdEurAmount | null;
  /** Effective date override (YYYY-MM-DD). */
  effectiveDate?: string;
  isAdjustment?: boolean;
  /**
   * The wallet that owns this crypto position (crypto writes only).
   * Lives here — not in AssetRef — so AssetRef stays asset-level and
   * `getAssetTransactions` can resolve all positions across wallets.
   */
  walletId?: string;
  /**
   * The broker that owns this stock position (stock writes only).
   * Lives here — not in AssetRef — so AssetRef stays asset-level.
   */
  brokerId?: string;
}

/**
 * Thin wrapper — routes a Buy/Sell on crypto or stock to the underlying
 * `upsertPosition` / `upsertStockPosition` primitive, threading through the
 * cashflowOverride when the caller supplies a cost amount.
 *
 * Task 2.5 expands: full action routing (deposit/withdrawal/transfer/yield),
 * single-currency → FX-at-date derivation, markAsYield, all guards (transfer
 * leg, split child, compensation row), and the 8-column is_adjustment branch.
 */
export async function addTransaction(
  assetRef: AssetRef,
  params: AddTransactionParams,
): Promise<void> {
  return captureAction("transactions.addTransaction", async () => {
    const cashflowOverride = params.costAmount ?? undefined;

    if (assetRef.class === "crypto") {
      if (!params.walletId) {
        throw new Error("walletId is required for a crypto transaction");
      }
      await upsertPosition(
        {
          crypto_asset_id: assetRef.assetId,
          wallet_id: params.walletId,
          quantity: params.quantity,
        },
        {
          currentPriceUsd: params.currentPriceUsd,
          currentPriceEur: params.currentPriceEur,
          cashflowOverride,
          isAdjustment: params.isAdjustment,
          effectiveDate: params.effectiveDate,
          // isYield threading: Task 2.5 adds markAsYield routing here
        },
      );
    } else if (assetRef.class === "stock") {
      if (!params.brokerId) {
        throw new Error("brokerId is required for a stock transaction");
      }
      await upsertStockPosition(
        {
          stock_asset_id: assetRef.assetId,
          broker_id: params.brokerId,
          quantity: params.quantity,
        },
        {
          // currentPriceNative and assetCurrency are required by the stocks
          // primitive for correct FX derivation. Task 2.5 provides these from
          // the caller; for now fall back to currentPriceUsd if supplied.
          currentPriceNative: params.currentPriceUsd,
          assetCurrency: "USD",
          cashflowOverride,
          isAdjustment: params.isAdjustment,
          effectiveDate: params.effectiveDate,
        },
      );
    }
    // Task 2.5 expands: cash deposit/withdrawal/transfer/yield routing.

    await revalidateDashboard();
  });
}

// ─── editTransaction ─────────────────────────────────────────────────────────

export interface EditTransactionPatch {
  /**
   * Override the effective date (YYYY-MM-DD). Pass null to clear.
   * Task 2.5 expands with: amount, is_adjustment, delta_* branch, markAsYield,
   * transfer-leg guard, split-child guard, compensation-row guard.
   */
  effectiveDate?: string | null;
}

export interface EditTransactionResult {
  success: boolean;
  /**
   * Set to true when the entry was not found OR does not belong to the
   * authenticated user — indistinguishable on purpose (no leaking of other
   * users' IDs).
   */
  notFound?: boolean;
  message?: string;
}

/**
 * Direct UPDATE on an activity_log entry owned by the authenticated user.
 *
 * SECURITY CONTRACT (must be preserved when Task 2.5 expands this):
 *   1. validateUUID — reject malformed IDs before any DB contact.
 *   2. Fetch the entry scoped to `.eq("user_id", user.id)` via the RLS
 *      server client — never admin. Returns not-found if absent (404-equiv).
 *   3. UPDATE scoped with BOTH `.eq("id", entryId)` AND `.eq("user_id",
 *      user.id)` AND `.is("undone_at", null)` (TOCTOU guard).
 *
 * Task 2.5 expands: full patch fields (amount, is_adjustment, delta_*,
 * markAsYield), transfer-leg guard (reject if transfer_group_id set),
 * split-child guard (reject if split_from_id set), compensation-row guard
 * (reject if compensates_for set), and the 8-column is_adjustment→delta_*
 * recompute branch.
 */
export async function editTransaction(
  entryId: string,
  patch: EditTransactionPatch,
): Promise<EditTransactionResult> {
  return captureAction("transactions.editTransaction", async () => {
    // 1. Validate ID format before any DB contact
    validateUUID(entryId, "Entry ID");

    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { success: false, message: "Not authenticated" };

    // 2. Fetch the row scoped to the authenticated user (RLS + explicit user_id).
    //    Not found OR wrong owner → indistinguishable not-found response.
    const { data: entry, error: fetchErr } = await supabase
      .from("activity_log")
      .select("id, user_id, undone_at")
      .eq("id", entryId)
      .eq("user_id", user.id)
      .single();

    if (fetchErr || !entry) {
      return { success: false, notFound: true, message: "Entry not found" };
    }

    // 3. Build the patch — only apply fields the caller explicitly provided.
    //    We narrow the payload type to the activity_log Update shape so the
    //    compiler can verify the column names and value types. Using a typed
    //    intersection avoids the TS2345 "Record<string, …> not assignable"
    //    error that generic index signatures trigger with Supabase's strict
    //    RejectExcessProperties update type.
    const updatePayload: { effective_date?: string | null } = {};
    if (patch.effectiveDate !== undefined) {
      updatePayload.effective_date = patch.effectiveDate ?? null;
    }

    if (Object.keys(updatePayload).length === 0) {
      return { success: true, message: "Nothing to update" };
    }

    // 4. UPDATE scoped with id + user_id + undone_at IS NULL (TOCTOU guard).
    //    If the row was undone between the fetch and the update the write is
    //    a no-op (0 rows affected) which is acceptable; a future expansion can
    //    add a rowCount check here.
    const { error: updateErr } = await supabase
      .from("activity_log")
      .update(updatePayload)
      .eq("id", entryId)
      .eq("user_id", user.id)
      .is("undone_at", null);

    if (updateErr) {
      return { success: false, message: updateErr.message };
    }

    await revalidateDashboard();
    return { success: true };
  });
}
