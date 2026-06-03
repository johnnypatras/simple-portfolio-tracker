"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidateDashboard } from "@/lib/actions/revalidate";
import { upsertPosition } from "@/lib/actions/crypto";
import { upsertStockPosition } from "@/lib/actions/stocks";
import { updateCashAccount } from "@/lib/actions/cash-accounts";
import { toUsdAndEur } from "@/lib/actions/activity-log";
import {
  validateUUID,
  validateQuantity,
  validateAmount,
  validatePastOrTodayDate,
} from "@/lib/validation";
import { round2 } from "@/lib/format";
import { captureAction } from "@/lib/actions/with-sentry";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssetRef, UsdEurAmount } from "@/lib/types";

// ─── addTransaction ──────────────────────────────────────────────────────────

/**
 * The transaction kinds `addTransaction` handles. This is intentionally the
 * modal's `TransactionType` MINUS `transfer` — a transfer routes out at the UI
 * layer as a two-legged sell/buy/move and never reaches this action. Kept
 * module-private (not exported) so it can't be mistaken for the modal's
 * 6-member `TransactionType`.
 *
 * Direction is derived from the type, never from the sign of `quantity`
 * (which is always > 0): buy / deposit / yield ADD; sell / withdrawal SUBTRACT.
 */
type AddTransactionType = "buy" | "sell" | "yield" | "deposit" | "withdrawal";

export interface AddTransactionParams {
  /** The kind of transaction. Determines direction + yield/cost semantics. */
  type: AddTransactionType;
  /** Units TRANSACTED (a positive delta). For cash this IS the cash amount. */
  quantity: number;
  /**
   * Single-currency cost the user typed (incl. fees). When present, the other
   * currency is derived via FX-at-date (`toUsdAndEur`, which THROWS on FX
   * failure so a bad rate never silently writes a wrong cost) and the pair is
   * stored verbatim (`cashflow_user_set=true`), bypassing qty × price.
   * Absent → market-value fallback (`cashflow_user_set=false`).
   */
  cost?: { amount: number; currency: "EUR" | "USD" } | null;
  /** Effective date (YYYY-MM-DD). Absent → today. */
  effectiveDate?: string;
  isAdjustment?: boolean;
  /** The wallet that owns this crypto position (required for crypto writes). */
  walletId?: string;
  /** The broker that owns this stock position (required for stock writes). */
  brokerId?: string;
  /** Market price in USD — used for the no-cost fallback (qty × price). */
  currentPriceUsd?: number;
  /** Market price in EUR — used for the no-cost fallback (qty × price). */
  currentPriceEur?: number;
}

/**
 * Signed direction for a transaction type. Buy / deposit / yield are
 * acquisitions (+); sell / withdrawal are disposals (−). Yield is a
 * quantity-UP acquisition (its cost is 0 — `is_yield` is the single source
 * of truth, the amount is never zeroed so un-yield is lossless).
 */
function signedDelta(type: AddTransactionType, quantity: number): number {
  return type === "sell" || type === "withdrawal" ? -quantity : quantity;
}

/**
 * Routes a Buy / Sell / Yield / Deposit / Withdrawal on a crypto, stock, or
 * cash asset to the underlying mutation primitive.
 *
 * The modal's "Quantity" is the units TRANSACTED (a delta), but the position
 * primitives take the new ABSOLUTE quantity — so this action reads the current
 * position quantity (RLS-scoped, owner-only) and resolves
 * `newAbsolute = currentQty + signedDelta` before calling the primitive. A
 * full sell that lands the absolute at exactly 0 soft-deletes the position
 * (correct). A sell that would land it below 0 is rejected as an oversell.
 *
 * Cost capture: a single-currency `cost` is converted to a dual-currency
 * { usd, eur } pair via `toUsdAndEur` (FX-at-date) and threaded as the
 * primitive's `cashflowOverride` (stored verbatim, `cashflow_user_set=true`).
 * Without a cost, the primitive computes market value from the prices passed.
 *
 * Error model: THROWS on failure (returns `Promise<void>`), consistent with
 * `upsertPosition` / `upsertStockPosition`; the modal's `onSubmit` surfaces the
 * message.
 *
 * `transfer` is NOT handled here — it routes out at the UI as a two-legged
 * operation.
 */
export async function addTransaction(
  assetRef: AssetRef,
  params: AddTransactionParams,
): Promise<void> {
  return captureAction("transactions.addTransaction", async () => {
    // ── Boundary validation ──────────────────────────────────────────────
    validateQuantity(params.quantity, "Quantity");
    if (params.effectiveDate !== undefined) {
      validatePastOrTodayDate(params.effectiveDate, "Date");
    }
    if (params.cost != null) {
      validateAmount(params.cost.amount, "Cost");
    }

    const isYield = params.type === "yield";

    // ── Single-currency cost → dual-currency override (case-16 FX) ────────
    // toUsdAndEur calls getFXRates, which THROWS on FX failure — a bad rate
    // never silently writes a wrong cost. The user's typed currency is stored
    // EXACTLY (preserving all decimals); only the cross-currency derived leg
    // is rounded to 2 dp (round2 keeps the derived currency clean money, no
    // float dust). Yield carries no override (cost 0).
    let cashflowOverride: UsdEurAmount | undefined;
    if (params.cost != null && !isYield) {
      const derived = await toUsdAndEur(
        params.cost.amount,
        params.cost.currency,
        params.effectiveDate,
      );
      cashflowOverride =
        params.cost.currency === "EUR"
          ? { eur: params.cost.amount, usd: round2(derived.usd) }
          : { usd: params.cost.amount, eur: round2(derived.eur) };
    }

    if (assetRef.class === "crypto") {
      if (!params.walletId) {
        throw new Error("walletId is required for a crypto transaction");
      }
      const supabase = await createServerSupabaseClient();
      const currentQty = await readCryptoQty(
        supabase,
        assetRef.assetId,
        params.walletId,
      );
      const newAbsolute = currentQty + signedDelta(params.type, params.quantity);
      if (newAbsolute < 0) {
        throw new Error(
          `Cannot sell ${params.quantity} — only ${currentQty} held in this wallet.`,
        );
      }

      await upsertPosition(
        {
          crypto_asset_id: assetRef.assetId,
          wallet_id: params.walletId,
          quantity: newAbsolute,
        },
        {
          currentPriceUsd: params.currentPriceUsd,
          currentPriceEur: params.currentPriceEur,
          cashflowOverride,
          isAdjustment: params.isAdjustment,
          isYield,
          effectiveDate: params.effectiveDate,
        },
      );
    } else if (assetRef.class === "stock") {
      if (!params.brokerId) {
        throw new Error("brokerId is required for a stock transaction");
      }
      const supabase = await createServerSupabaseClient();
      const currentQty = await readStockQty(
        supabase,
        assetRef.assetId,
        params.brokerId,
      );
      const newAbsolute = currentQty + signedDelta(params.type, params.quantity);
      if (newAbsolute < 0) {
        throw new Error(
          `Cannot sell ${params.quantity} — only ${currentQty} held in this broker.`,
        );
      }

      // The native price is only needed for the no-cost fallback (the override
      // bypasses qty × price). Fetch the asset's trading currency so the
      // fallback converts correctly; pass currentPriceUsd as a best-effort
      // native price only when the asset trades in USD, else leave the fallback
      // to mark cashflow_status='pending' (the user should provide a cost).
      let assetCurrency = "USD";
      let currentPriceNative: number | undefined;
      if (cashflowOverride == null) {
        assetCurrency = await readStockCurrency(supabase, assetRef.assetId);
        if (assetCurrency === "USD") currentPriceNative = params.currentPriceUsd;
      }

      await upsertStockPosition(
        {
          stock_asset_id: assetRef.assetId,
          broker_id: params.brokerId,
          quantity: newAbsolute,
        },
        {
          currentPriceNative,
          assetCurrency,
          cashflowOverride,
          isAdjustment: params.isAdjustment,
          isYield,
          effectiveDate: params.effectiveDate,
        },
      );
    } else {
      // ── Cash: deposit / withdrawal / yield ──────────────────────────────
      // quantity IS the cash amount. Read the current balance (RLS-scoped),
      // resolve the new balance, and update only `balance` — partialUpdate()
      // leaves currency / apy / name untouched.
      const supabase = await createServerSupabaseClient();
      const currentBalance = await readCashBalance(supabase, assetRef.accountId);
      const newBalance =
        currentBalance + signedDelta(params.type, params.quantity);
      if (newBalance < 0) {
        throw new Error(
          `Cannot withdraw ${params.quantity} — only ${currentBalance} available.`,
        );
      }

      await updateCashAccount(
        assetRef.accountId,
        { balance: newBalance },
        {
          cashflowOverride,
          isYield,
          effectiveDate: params.effectiveDate,
          isAdjustment: params.isAdjustment,
        },
      );
    }

    await revalidateDashboard();
  });
}

/**
 * Read the current absolute quantity of a crypto position (RLS-scoped to the
 * authenticated user via the server client). Returns 0 when no live position
 * exists — the first buy then creates it at exactly the transacted quantity.
 */
async function readCryptoQty(
  supabase: SupabaseClient,
  assetId: string,
  walletId: string,
): Promise<number> {
  const { data } = await supabase
    .from("crypto_positions")
    .select("quantity")
    .eq("crypto_asset_id", assetId)
    .eq("wallet_id", walletId)
    .is("deleted_at", null)
    .maybeSingle();
  return data ? Number(data.quantity) : 0;
}

/**
 * Read the current absolute quantity of a stock position (RLS-scoped).
 * Returns 0 when no live position exists.
 */
async function readStockQty(
  supabase: SupabaseClient,
  assetId: string,
  brokerId: string,
): Promise<number> {
  const { data } = await supabase
    .from("stock_positions")
    .select("quantity")
    .eq("stock_asset_id", assetId)
    .eq("broker_id", brokerId)
    .is("deleted_at", null)
    .maybeSingle();
  return data ? Number(data.quantity) : 0;
}

/**
 * Read a stock asset's native trading currency (RLS-scoped). Defaults to USD
 * when the asset can't be resolved — the no-cost fallback path then converts
 * using a sensible default rather than crashing.
 */
async function readStockCurrency(
  supabase: SupabaseClient,
  assetId: string,
): Promise<string> {
  const { data } = await supabase
    .from("stock_assets")
    .select("currency")
    .eq("id", assetId)
    .is("deleted_at", null)
    .maybeSingle();
  return data?.currency ? String(data.currency) : "USD";
}

/**
 * Read a cash account's current balance (RLS-scoped). Throws if the account
 * isn't found for this user — a deposit/withdrawal against a missing account
 * is a hard error, not a silent no-op.
 */
async function readCashBalance(
  supabase: SupabaseClient,
  accountId: string,
): Promise<number> {
  validateUUID(accountId, "Cash account ID");
  const { data, error } = await supabase
    .from("cash_accounts")
    .select("balance")
    .eq("id", accountId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Cash account not found");
  return Number(data.balance);
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
