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
import { COST_COPY } from "@/lib/cost-basis-copy";
import { quantityDelta } from "@/lib/transaction-kind";
import { latestChangeDate } from "@/lib/split-helpers";
import {
  getAssetTransactions,
  fetchTransferCounterparts,
  toTransactionDisplayRows,
} from "@/lib/portfolio/asset-transactions";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssetRef, EntityType, FlowStatus, UsdEurAmount } from "@/lib/types";
import type { TransactionDisplayRow } from "@/components/transactions/transactions-drawer";

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
   * Single-currency cost the user typed (incl. fees) — a MAGNITUDE. When
   * present, the other currency is derived via FX-at-date (`toUsdAndEur`, which
   * THROWS on FX failure so a bad rate never silently writes a wrong cost) and
   * the pair is stored (`cashflow_user_set=true`), bypassing qty × price. The
   * stored SIGN comes from the transaction TYPE (buy/deposit/yield → +,
   * sell/withdrawal → −), applied at the signing locus in @/lib/activity-fx —
   * never from the amount itself. Absent → market-value fallback
   * (`cashflow_user_set=false`).
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
   * Override the effective date (YYYY-MM-DD). Pass null to clear (→ the entry
   * falls back to `created_at` everywhere a date is read).
   */
  effectiveDate?: string | null;
  /**
   * New single-currency cost the user typed (incl. fees). When present, the
   * other currency is derived via FX-at-the-entry's-date (`toUsdAndEur`, which
   * THROWS on FX failure so a bad rate never silently writes a wrong cost) and
   * the row's amount columns are rewritten. Pass null (or omit) to leave the
   * amount untouched. `is_yield` is NOT toggled here — that goes through the
   * separate guarded `markAsYield` action.
   */
  cost?: { amount: number; currency: "EUR" | "USD" } | null;
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
 * Direct UPDATE on an activity_log entry owned by the authenticated user. Edits
 * the entry's COST AMOUNT and/or effective date. `is_yield` is NOT toggled here
 * — that goes through the guarded `markAsYield`.
 *
 * SECURITY CONTRACT (do not weaken):
 *   1. validateUUID — reject malformed IDs before any DB contact.
 *   2. Fetch the entry (`.select("*")` — before/after snapshots + guard columns
 *      are needed) scoped to `.eq("user_id", user.id)` via the RLS server
 *      client — never admin. Returns not-found if absent (404-equiv; no leak of
 *      another user's row).
 *   3. UPDATE scoped with BOTH `.eq("id", entryId)` AND `.eq("user_id",
 *      user.id)` AND `.is("undone_at", null)` (TOCTOU guard).
 *
 * GUARDS (reject before computing any write — mirror `toggleActivityAdjustment`
 * plus split-child + compensation): transfer leg (`transfer_group_id` set),
 * split child (`split_from_id` set), undone tombstone (`undone_at` set),
 * automatic reversal (`compensates_for` set).
 *
 * THE CASHFLOW/DELTA AMOUNT + STATUS BLOCK (the heart): when `patch.cost` is present, exactly
 * ONE of {cashflow, delta} carries the new amount and the OTHER side's amount
 * AND status are nulled — NEVER both populated. The benchmark's
 * `deriveCashFlows` keys on `cashflow_status`; a stale status left behind would
 * recreate a phantom contribution.
 *   • is_adjustment=true  → write delta_*  + delta_status='complete', null all
 *                           cashflow_* columns (amount + status + asset_class).
 *   • is_adjustment=false → write cashflow_* + cashflow_status='complete' +
 *                           cashflow_asset_class + cashflow_user_set=true, null
 *                           all delta_* columns (amount + status).
 * is_adjustment itself is NEVER toggled here (that's `toggleActivityAdjustment`).
 *
 * SIGN (THE SIGN CONTRACT, see @/lib/activity-fx): `patch.cost` is a MAGNITUDE.
 * The stored amount keeps the SIGN OF THE ROW so editing the cost of a SELL never
 * flips it into a phantom positive contribution. Direction precedence:
 *   1. `quantityDelta(row)` sign (the operation: disposal → −, acquisition → +).
 *   2. When that's 0/indeterminate (e.g. a row whose snapshots can't resolve a
 *      delta), preserve the sign of the EXISTING stored amount on the side being
 *      written (cashflow for a real flow, delta for an adjustment).
 *   3. If neither yields a sign (both 0) → +1 (the safe acquisition default).
 */
export async function editTransaction(
  entryId: string,
  patch: EditTransactionPatch,
): Promise<EditTransactionResult> {
  return captureAction("transactions.editTransaction", async () => {
    // 1. Validate inputs before any DB contact.
    validateUUID(entryId, "Entry ID");
    if (patch.cost != null) {
      validateAmount(patch.cost.amount, "Cost");
    }
    if (patch.effectiveDate != null) {
      validatePastOrTodayDate(patch.effectiveDate, "Date");
    }

    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { success: false, message: "Not authenticated" };

    // 2. Fetch the FULL row scoped to the authenticated user (RLS + explicit
    //    user_id). `.select("*")` because we need snapshots + the guard columns
    //    + is_adjustment + crypto_asset_id (off the snapshot). Not found OR
    //    wrong owner → indistinguishable not-found response (no ID leak).
    const { data: row, error: fetchErr } = await supabase
      .from("activity_log")
      .select("*")
      .eq("id", entryId)
      .eq("user_id", user.id)
      .single();

    if (fetchErr || !row) {
      return { success: false, notFound: true, message: "Entry not found" };
    }

    // 3. GUARDS — reject BEFORE computing any write. Order: structural locks
    //    (transfer leg, split child) then tombstone/derived locks.
    if (row.transfer_group_id != null) {
      return { success: false, message: COST_COPY.transferLegLocked };
    }
    if (row.split_from_id != null) {
      return { success: false, message: COST_COPY.splitChildLocked };
    }
    if (row.undone_at != null) {
      return { success: false, message: "This entry was undone and can't be edited." };
    }
    if (row.compensates_for != null) {
      return {
        success: false,
        message: "This is an automatic reversal entry and can't be edited.",
      };
    }
    if (row.is_yield && patch.cost != null) {
      return { success: false, message: COST_COPY.yieldHasNoCost };
    }

    // 4. No-op short-circuit: nothing to change.
    if (patch.cost == null && patch.effectiveDate === undefined) {
      return { success: true, message: "Nothing to update" };
    }

    // 5. Build the UPDATE payload. We narrow it to the exact column shape so the
    //    compiler verifies column names + value types (a typed object avoids the
    //    TS2345 "Record<string, …> not assignable" that an index signature
    //    triggers against Supabase's RejectExcessProperties update type).
    const updatePayload: {
      effective_date?: string | null;
      delta_usd?: number | null;
      delta_eur?: number | null;
      delta_status?: FlowStatus | null;
      cashflow_amount_usd?: number | null;
      cashflow_amount_eur?: number | null;
      cashflow_status?: FlowStatus | null;
      cashflow_asset_class?: string | null;
      cashflow_user_set?: boolean;
    } = {};

    if (patch.effectiveDate !== undefined) {
      updatePayload.effective_date = patch.effectiveDate ?? null;
    }

    // 6. THE CASHFLOW/DELTA AMOUNT + STATUS BLOCK — only when a new cost is supplied.
    if (patch.cost != null) {
      // Value the cost at the entry's date: the new effective date if the
      // caller is also changing it, else the row's existing
      // effective_date ?? created_at. toUsdAndEur THROWS on FX failure, so a
      // bad rate never silently writes a wrong cost.
      const fxDate =
        patch.effectiveDate != null
          ? patch.effectiveDate
          : ((row.effective_date as string | null) ?? (row.created_at as string));
      const derived = await toUsdAndEur(
        patch.cost.amount,
        patch.cost.currency,
        fxDate,
      );
      // Preserve the typed leg verbatim (all decimals); round only the derived
      // cross-currency leg to clean money (round2 — no float dust). This is a
      // MAGNITUDE — the sign is applied below from the row's own direction.
      const magnitude: UsdEurAmount =
        patch.cost.currency === "EUR"
          ? { eur: patch.cost.amount, usd: round2(derived.usd) }
          : { usd: patch.cost.amount, eur: round2(derived.eur) };

      // THE SIGN CONTRACT: keep the row's existing direction. Precedence:
      //   1. quantityDelta(row) sign (the operation — disposal − / acquisition +).
      //   2. fall back to the sign of the EXISTING stored amount on the side being
      //      written (cashflow for a real flow, delta for an adjustment) when the
      //      qty delta is 0/indeterminate.
      //   3. +1 when neither resolves a sign.
      const qd = quantityDelta({
        entity_type: row.entity_type,
        action: row.action,
        is_yield: row.is_yield,
        is_adjustment: row.is_adjustment,
        transfer_group_id: row.transfer_group_id,
        split_from_id: row.split_from_id,
        before_snapshot: row.before_snapshot as Record<string, unknown> | null,
        after_snapshot: row.after_snapshot as Record<string, unknown> | null,
        details: row.details as Record<string, unknown> | null,
      });
      const existingSigned = row.is_adjustment
        ? (row.delta_usd as number | null) ?? (row.delta_eur as number | null)
        : (row.cashflow_amount_usd as number | null) ?? (row.cashflow_amount_eur as number | null);
      const direction: 1 | -1 =
        qd < 0 ? -1 : qd > 0 ? 1 : (existingSigned ?? 0) < 0 ? -1 : 1;
      const dual: UsdEurAmount = {
        usd: direction * Math.abs(magnitude.usd),
        eur: direction * Math.abs(magnitude.eur),
      };

      if (row.is_adjustment) {
        // Adjustment → the amount is a delta. Write delta_*, null cashflow_*
        // (amount + status + asset_class) so no stale cashflow_status survives.
        updatePayload.delta_usd = dual.usd;
        updatePayload.delta_eur = dual.eur;
        updatePayload.delta_status = "complete";
        updatePayload.cashflow_amount_usd = null;
        updatePayload.cashflow_amount_eur = null;
        updatePayload.cashflow_status = null;
        updatePayload.cashflow_asset_class = null;
      } else {
        // Real flow → the amount is a cashflow contribution. Classify the asset
        // class (stablecoin crypto → "cash", else the entity's class), mark
        // cashflow_user_set (the user explicitly set this amount), and null
        // delta_* (amount + status) so no stale delta survives.
        const { classifyAssetClass, isStablecoin } = await import("@/lib/cashflow");
        let isStable = false;
        if (row.entity_type === "crypto_position") {
          const snap = (row.after_snapshot ?? row.before_snapshot) as
            | Record<string, unknown>
            | null;
          const assetId = snap?.crypto_asset_id as string | undefined;
          if (assetId) {
            const { data: asset } = await supabase
              .from("crypto_assets")
              .select("subcategory")
              .eq("id", assetId)
              .maybeSingle();
            isStable = isStablecoin(asset?.subcategory);
          }
        }
        updatePayload.cashflow_amount_usd = dual.usd;
        updatePayload.cashflow_amount_eur = dual.eur;
        updatePayload.cashflow_status = "complete";
        updatePayload.cashflow_asset_class = classifyAssetClass(
          row.entity_type as EntityType,
          isStable,
        );
        updatePayload.cashflow_user_set = true;
        updatePayload.delta_usd = null;
        updatePayload.delta_eur = null;
        updatePayload.delta_status = null;
      }
    }

    // 7. UPDATE scoped with id + user_id + undone_at IS NULL (TOCTOU guard). If
    //    the row was undone between the fetch and the update the write matches
    //    0 rows (the undo's tombstone wins) — acceptable, no throw needed.
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

// ─── markAsYield ───────────────────────────────────────────────────────────────

export interface MarkAsYieldResult {
  /** Rows that qualified at fetch time and were targeted for is_yield=true. */
  updated: number;
  /** How many ids were rejected: not found, wrong owner, or ineligible by guard. */
  skipped: number;
}

/**
 * BULK reclassify legacy interest / staking / airdrop entries as earned income
 * by flipping `is_yield=true`. Yield = cost 0 (pure gain), and under Model B it
 * PARTICIPATES in the S&P benchmark at its market value on the receipt date —
 * `is_yield` is the single source of truth; the cashflow amount is NEVER touched,
 * so un-yield is lossless.
 *
 * Benchmark consequence (Model B): because the amounts are untouched, a flipped
 * row keeps its place in the S&P replay at its RECORDED cashflow_amount_* —
 * which is market-at-entry for an auto-priced row (cashflow_user_set=false). If
 * the row happened to carry a user-set cost, that amount stands until the row is
 * backdated; the backdate recompute then revalues it to market-at-date and
 * clears cashflow_user_set (a yield flow IS its market value on receipt — a
 * "cost" on a yield row is meaningless). So Mark-as-Yield is now a pure cost/P&L
 * reclassifier: it never shifts the S&P line.
 *
 * Defensive by design — only an ACQUISITION (units ADDED, `quantityDelta > 0`)
 * is eligible. A disposal (sell / withdrawal, `quantityDelta <= 0`) marked as
 * yield would zero its cost at €0, book no realized P&L, AND mislabel a real
 * OUTFLOW as earned income (the replay still subtracts its negative amount
 * correctly — the corruption is in cost/P&L and labeling, not the unit math) —
 * so disposals are skipped even when every other predicate term passes
 * (audit-r6 HIGH).
 *
 * SECURITY CONTRACT (do not weaken):
 *   1. validateUUID on every id — reject malformed IDs before any DB contact.
 *   2. Fetch candidates in ONE query scoped to `.eq("user_id", user.id)` via the
 *      RLS server client — NEVER admin. `.select("*")` is MANDATORY: the
 *      eligibility check reads before/after snapshots + details via
 *      `quantityDelta`; without them every row computes delta 0 and is silently
 *      skipped (audit-r7). Rows not returned (absent OR wrong owner) → skipped.
 *   3. Bulk UPDATE scoped with `.in("id", eligibleIds)` AND `.eq("user_id",
 *      user.id)` AND `.is("undone_at", null)` (TOCTOU guard).
 *
 * ELIGIBILITY (a row qualifies iff ALL hold — computed in JS over the fetched
 * rows): is_adjustment=false, transfer_group_id null, split_from_id null,
 * undone_at null, compensates_for null, cashflow_status='complete',
 * is_yield=false (already-yield → skip, keeps `updated` honest), and
 * `quantityDelta(row) > 0` (the acquisition guard).
 */
export async function markAsYield(ids: string[]): Promise<MarkAsYieldResult> {
  return captureAction("transactions.markAsYield", async () => {
    // 1. Validate every id before any DB contact. Empty list → no-op.
    if (ids.length === 0) return { updated: 0, skipped: 0 };
    const uniqueIds = [...new Set(ids)];
    for (const id of uniqueIds) {
      validateUUID(id, "Entry ID");
    }

    // 2. Auth — owner path (RLS server client, never admin).
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");

    // 3. Fetch ALL candidate rows in ONE query, scoped to the user. `.select("*")`
    //    is required — quantityDelta reads before/after snapshots + details. Rows
    //    not returned (not found OR wrong owner) implicitly count as skipped.
    const { data: rows, error: fetchErr } = await supabase
      .from("activity_log")
      .select("*")
      .in("id", uniqueIds)
      .eq("user_id", user.id);
    if (fetchErr) throw new Error(fetchErr.message);

    // 4. Filter eligible rows IN JS. A disposal (quantityDelta <= 0) is rejected
    //    even when every SQL predicate term passes — the acquisition guard.
    const eligibleIds = (rows ?? [])
      .filter((row) => {
        if (row.is_adjustment !== false) return false;
        if (row.transfer_group_id != null) return false;
        if (row.split_from_id != null) return false;
        if (row.undone_at != null) return false;
        if (row.compensates_for != null) return false;
        if (row.cashflow_status !== "complete") return false;
        if (row.is_yield !== false) return false;

        const qd = quantityDelta({
          entity_type: row.entity_type,
          action: row.action,
          is_yield: row.is_yield,
          is_adjustment: row.is_adjustment,
          transfer_group_id: row.transfer_group_id,
          split_from_id: row.split_from_id,
          before_snapshot: row.before_snapshot as Record<string, unknown> | null,
          after_snapshot: row.after_snapshot as Record<string, unknown> | null,
          details: row.details as Record<string, unknown> | null,
        });
        return qd > 0;
      })
      .map((row) => row.id);

    // 5. Bulk-update only the eligible ids in ONE statement. Touch ONLY is_yield —
    //    cashflow_amount_* and every other column stay intact (lossless un-yield).
    //    Skip entirely when nothing is eligible.
    if (eligibleIds.length > 0) {
      const { error: updateErr } = await supabase
        .from("activity_log")
        .update({ is_yield: true })
        .in("id", eligibleIds)
        .eq("user_id", user.id)
        .is("undone_at", null);
      if (updateErr) throw new Error(updateErr.message);

      await revalidateDashboard();
    }

    // 6. Honest counts: updated = eligible, skipped = everything else.
    //    `updated` reflects rows eligible at fetch time; a concurrent undo between
    //    fetch and update can make the literal write smaller — the undo's state wins
    //    (same stance as toggleActivityAdjustment).
    return {
      updated: eligibleIds.length,
      skipped: uniqueIds.length - eligibleIds.length,
    };
  });
}

// ─── loadAssetTransactions ───────────────────────────────────────────────────

/**
 * A display row enriched with the two structural-lock flags the transaction
 * modal needs when an entry is opened for edit. Both are read straight off the
 * raw activity_log row (the display mapper drops them, so we zip them back in):
 *   - `isTransferLeg` — `transfer_group_id` is set → the modal's transfer-leg
 *     lock (edit routes to the Transfer screen instead).
 *   - `isSplitChild`  — `split_from_id` is set → the modal's split-child lock
 *     (unsplit first).
 */
export interface AssetTransactionDisplayRow extends TransactionDisplayRow {
  isTransferLeg: boolean;
  isSplitChild: boolean;
}

/**
 * Owner-path read of a single asset's full transaction history, shaped for the
 * transactions drawer. Thin client-callable wrapper over `getAssetTransactions`
 * (the asset-level merge across all of the asset's wallet/broker positions) +
 * `toTransactionDisplayRows` (the pure raw→display mapper).
 *
 * The mapper is 1:1 and order-preserving, so the raw rows and the display rows
 * line up by index — we zip them to attach the two lock flags off the raw row.
 *
 * Auth: RLS server client + `getUser()` (THROWS if unauthenticated — a read of
 * "my asset's transactions" has no anonymous meaning). This is the OWNER path
 * only; the share-page read uses `getAssetTransactions` directly with the admin
 * client + the share owner's id (see that module's dual-client contract).
 *
 * No revalidation — this is a pure read.
 */
export async function loadAssetTransactions(
  assetRef: AssetRef,
  currency: "EUR" | "USD",
): Promise<AssetTransactionDisplayRow[]> {
  return captureAction("transactions.loadAssetTransactions", async () => {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");

    const raw = await getAssetTransactions(supabase, user.id, assetRef);
    // C2b: look up the OTHER leg of each transfer group so a sell/buy-type leg
    // can read "Sell (to {cash account})" / "Buy (from {cash account})". The
    // lookup degrades gracefully (failure → empty map → plain Transfer).
    const counterparts = await fetchTransferCounterparts(supabase, user.id, raw);
    const display = toTransactionDisplayRows(raw, currency, counterparts);

    if (display.length !== raw.length) {
      throw new Error("toTransactionDisplayRows must be 1:1 with its input");
    }

    // The mapper is 1:1 and order-preserving — index i of `display` is the
    // mapped form of index i of `raw`. Zip them, reading the lock flags off
    // the raw row.
    return display.map((row, i) => ({
      ...row,
      isTransferLeg: raw[i].transfer_group_id != null,
      isSplitChild: raw[i].split_from_id != null,
    }));
  });
}

// ─── loadLastChangeDate ──────────────────────────────────────────────────────

/** How many newest-by-`created_at` rows the last-change scan considers. */
const LAST_CHANGE_SCAN_LIMIT = 20;

/**
 * Most-recent change date (as `YYYY-MM-DD`) for a single entity's live history,
 * or null when the entity has no history. Powers the position editors'
 * "Backdate to last change" suggest-chip: when a correction checkbox is ON the
 * date field defaults to today, and this gives the one-click alternative of the
 * position's actual last-change date.
 *
 * The date is the MAX of `COALESCE(effective_date, created_at-day)` across the
 * entity's NON-UNDONE rows (computed in JS via `latestChangeDate`) — a backdated
 * entry recorded later still wins by the date it claims. The fetch is capped at
 * the `LAST_CHANGE_SCAN_LIMIT` newest-by-`created_at` rows and asks only for the
 * two date columns. Known trade-off: a backdated entry whose `created_at` falls
 * OUTSIDE that window is not considered, so on a heavy-history position the chip
 * can suggest a smaller date than the true max — acceptable because the chip is
 * an overridable suggestion on a plain date input, never an applied value.
 *
 * Auth: RLS server client + `getUser()` + explicit `.eq("user_id", user.id)`
 * (defense-in-depth over RLS). A malformed id is rejected before any DB contact.
 * A fetch error or no rows returns null — the chip simply doesn't show; the
 * date field still works (no dead end).
 *
 * No revalidation — pure read.
 */
export async function loadLastChangeDate(entityId: string): Promise<string | null> {
  return captureAction("transactions.loadLastChangeDate", async () => {
    validateUUID(entityId, "Entity ID");

    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");

    const { data, error } = await supabase
      .from("activity_log")
      .select("effective_date, created_at")
      .eq("entity_id", entityId)
      .eq("user_id", user.id)
      .is("undone_at", null)
      .order("created_at", { ascending: false })
      .limit(LAST_CHANGE_SCAN_LIMIT);

    if (error || !data || data.length === 0) return null;

    return latestChangeDate(data);
  });
}
