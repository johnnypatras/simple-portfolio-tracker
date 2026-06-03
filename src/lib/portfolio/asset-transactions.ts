/**
 * Asset-scoped transaction read + pure raw→display mapper.
 *
 * This module is intentionally NOT a `"use server"` module: `getAssetTransactions`
 * takes a live SupabaseClient as its first argument (the dual-client contract),
 * and a SupabaseClient is not serializable, so it could never be a server action.
 * It mirrors `fetchHistoricalPriceInputsFor` in
 * `historical-prices-augmentation.ts`, which lives in a plain lib module for the
 * same reason.
 *
 * Dual-client contract (audit-r5):
 *   - OWNER path: pass the RLS-scoped server client + auth.uid().
 *   - SHARE-PAGE path: pass the service-role admin client + share.owner_id.
 * Because the admin client BYPASSES RLS, every query here is EXPLICITLY scoped by
 * `userId` (on the asset-owner join for position resolution, and on
 * `.eq("user_id", userId)` for the activity_log read). Never rely on RLS alone.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { AssetRef } from "@/lib/types";
import { fetchAllPaginated } from "@/lib/supabase/pagination";
import {
  classifyTransaction,
  quantityDelta,
  type TransactionRow,
} from "@/lib/transaction-kind";
// Type-only import — safe from a lib module (no client-component runtime pulled in).
import type { TransactionDisplayRow } from "@/components/transactions/transactions-drawer";

/**
 * Raw activity_log row, asset-scoped. Selects EXACTLY the columns the cost engine
 * (Task 3.1) and the drawer mapper need. Json columns (before/after_snapshot,
 * details) stay `unknown` and are narrowed at use-site (the boundary-normalization
 * convention) — never widened with `as any`.
 */
export interface AssetTransactionRow {
  id: string;
  entity_id: string | null;
  entity_type: string;
  action: string;
  is_yield: boolean;
  is_adjustment: boolean;
  transfer_group_id: string | null;
  split_from_id: string | null;
  cashflow_amount_usd: number | null;
  cashflow_amount_eur: number | null;
  delta_usd: number | null;
  delta_eur: number | null;
  before_snapshot: unknown; // Json column — keep unknown, narrow at use-site
  after_snapshot: unknown;
  details: unknown;
  effective_date: string | null;
  created_at: string;
}

/** Columns selected for the activity_log read — kept in one place for parity. */
const ACTIVITY_SELECT =
  "id, entity_id, entity_type, action, is_yield, is_adjustment, transfer_group_id, split_from_id, cashflow_amount_usd, cashflow_amount_eur, delta_usd, delta_eur, before_snapshot, after_snapshot, details, effective_date, created_at";

/**
 * Resolve a crypto AssetRef to the position ids that belong to `userId`.
 *
 * One asset can be held across multiple positions (e.g. the same coin in two
 * wallets); their activity_log streams merge into a single per-asset history.
 *
 * Explicit `.eq("crypto_assets.user_id", userId)` scopes the join to the owner —
 * the admin client bypasses RLS, so this is the only thing keeping a share-page
 * read from leaking another user's positions.
 *
 * Intentionally NO `.is("deleted_at", null)`: a fully-sold position is
 * soft-deleted, but its activity_log rows are still needed (same rationale as
 * `loadCryptoPositionMeta`). Paginated past the max_rows cap — a heavy asset
 * exceeding 1000 positions is improbable but the cost of paging is trivial and a
 * silent truncation would drop part of the history.
 *
 * Crypto and stock resolution are kept as two functions (not one generic helper)
 * because the typed Supabase query builder can't be parameterized over the two
 * tables' distinct foreign-key columns (`crypto_asset_id` vs `stock_asset_id`)
 * without an `as` cast — the project forbids those, so we pay a little
 * duplication to keep the column names strongly typed.
 */
async function resolveCryptoPositionIds(
  supabase: SupabaseClient<Database>,
  userId: string,
  assetId: string,
): Promise<string[]> {
  const rows = await fetchAllPaginated<{ id: string }>(
    (from, to) =>
      supabase
        .from("crypto_positions")
        .select("id, crypto_assets!inner(user_id)")
        .eq("crypto_asset_id", assetId)
        .eq("crypto_assets.user_id", userId) // explicit user scope — admin bypasses RLS
        .order("id", { ascending: true })
        .range(from, to),
    1000,
    { label: "asset-transactions:crypto_positions" },
  ).catch((e: unknown) => {
    throw new Error(
      `Failed to resolve crypto_positions for asset: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  });
  return rows.map((r) => r.id);
}

/** Stock counterpart of {@link resolveCryptoPositionIds}; see its doc comment. */
async function resolveStockPositionIds(
  supabase: SupabaseClient<Database>,
  userId: string,
  assetId: string,
): Promise<string[]> {
  const rows = await fetchAllPaginated<{ id: string }>(
    (from, to) =>
      supabase
        .from("stock_positions")
        .select("id, stock_assets!inner(user_id)")
        .eq("stock_asset_id", assetId)
        .eq("stock_assets.user_id", userId) // explicit user scope — admin bypasses RLS
        .order("id", { ascending: true })
        .range(from, to),
    1000,
    { label: "asset-transactions:stock_positions" },
  ).catch((e: unknown) => {
    throw new Error(
      `Failed to resolve stock_positions for asset: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  });
  return rows.map((r) => r.id);
}

/**
 * Read a single asset's full transaction history from the activity_log, merging
 * across every position that holds the asset (crypto/stock) or directly for a
 * cash account.
 *
 * Returns rows sorted ascending by `COALESCE(effective_date, created_at)`,
 * tie-broken by created_at then id (deterministic). Undone rows are excluded; a
 * still-live split parent whose children are present is de-duped out (audit-r6).
 *
 * @see fetchHistoricalPriceInputsFor for the client-contract this mirrors.
 */
export async function getAssetTransactions(
  supabase: SupabaseClient<Database>,
  userId: string,
  assetRef: AssetRef,
): Promise<AssetTransactionRow[]> {
  // 1. Resolve assetRef → the entity_ids whose activity_log rows we read.
  let entityIds: string[];
  if (assetRef.class === "crypto") {
    entityIds = await resolveCryptoPositionIds(supabase, userId, assetRef.assetId);
  } else if (assetRef.class === "stock") {
    entityIds = await resolveStockPositionIds(supabase, userId, assetRef.assetId);
  } else {
    // cash: the account id IS the entity_id. Ownership is enforced by the
    // .eq("user_id", userId) on the activity_log read below — a foreign
    // accountId simply yields zero rows.
    entityIds = [assetRef.accountId];
  }

  // 2. Short-circuit: never issue `.in("entity_id", [])` (matches everything in
  //    some PostgREST versions / is wasteful at best).
  if (entityIds.length === 0) return [];

  // 3. Read activity_log, scoped + filtered, paginated for page stability.
  //    Order by created_at,id for deterministic page boundaries; the
  //    COALESCE(effective_date, created_at) ordering is done as a stable
  //    in-memory sort below (PostgREST can't cleanly order by a COALESCE expr,
  //    and page integrity needs a real column order).
  const range = (from: number, to: number) =>
    supabase
      .from("activity_log")
      .select(ACTIVITY_SELECT)
      .eq("user_id", userId) // defense-in-depth: positions carry no user_id; admin bypasses RLS
      .in("entity_id", entityIds) // cash: single-element array is fine
      .is("undone_at", null) // exclude undone rows
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }) // stable secondary key for deterministic pages
      .range(from, to);

  const rows = await fetchAllPaginated<AssetTransactionRow>(range, 1000, {
    label: "asset-transactions",
  }).catch((e: unknown) => {
    throw new Error(
      `Failed to load asset transactions: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  });

  // 4. Split-orphan de-dup (audit-r6). A split inserts children then marks the
  //    parent undone in a SEPARATE statement (not one transaction), so a crash
  //    mid-split can leave a LIVE parent alongside its LIVE children — a
  //    double-count. Defensively drop any row whose id is referenced as a
  //    split_from_id by another live row in this set.
  const childParentIds = new Set(
    rows.map((r) => r.split_from_id).filter((v): v is string => v != null),
  );
  const deduped = rows.filter((r) => !childParentIds.has(r.id));

  // 5. Stable sort by COALESCE(effective_date, created_at) asc, tie-break by
  //    created_at then id (deterministic). Within a single calendar day, a
  //    date-only `effective_date` sorts before a same-day full-timestamp
  //    `created_at` row (lexical prefix); this is intentional and the cost
  //    engine relies only on day-granular ordering.
  deduped.sort((a, b) => {
    const da = a.effective_date ?? a.created_at;
    const db = b.effective_date ?? b.created_at;
    if (da !== db) return da < db ? -1 : 1;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return deduped;
}

/**
 * Narrow a raw `unknown` Json snapshot to the shape `quantityDelta` /
 * `classifyTransaction` expect (`Record<string, unknown> | null`). Object values
 * pass through; anything else (string, number, array, null) becomes null — the
 * helpers treat a null snapshot as 0 for that field. This is the boundary
 * normalization the project convention requires at Json column read sites.
 */
function asSnapshot(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Map raw asset transaction rows → the drawer's display shape. PURE (no async,
 * no DB).
 *
 * Per row:
 *   - kind     = classifyTransaction(row)
 *   - quantity = quantityDelta(row)  (SIGNED — the engine/classifier convention)
 *   - amount   = ABSOLUTE value of the relevant column (C3 rule):
 *       transfer/adjustment legs carry value in delta_*; real buys/sells in
 *       cashflow_*. A null column stays null → the drawer renders "—".
 *   - date     = effective_date ?? created_at
 *
 * Direction is conveyed by the sign of `quantity` and the kind badge, so `amount`
 * is shown as a magnitude.
 */
export function toTransactionDisplayRows(
  rows: AssetTransactionRow[],
  currency: "EUR" | "USD",
): TransactionDisplayRow[] {
  return rows.map((row) => {
    const classifierRow: TransactionRow = {
      entity_type: row.entity_type,
      action: row.action,
      is_yield: row.is_yield,
      is_adjustment: row.is_adjustment,
      transfer_group_id: row.transfer_group_id,
      split_from_id: row.split_from_id,
      before_snapshot: asSnapshot(row.before_snapshot),
      after_snapshot: asSnapshot(row.after_snapshot),
      details: asSnapshot(row.details),
    };

    // C3: transfer/adjustment legs carry value in delta_*; real buys/sells in
    // cashflow_*. null stays null ("—"); for yield rows the cashflow is
    // typically null/0 → renders "—"/0, which is correct.
    const useDelta = row.is_adjustment || row.transfer_group_id != null;
    const raw =
      currency === "EUR"
        ? useDelta
          ? row.delta_eur
          : row.cashflow_amount_eur
        : useDelta
          ? row.delta_usd
          : row.cashflow_amount_usd;
    const amount = raw == null ? null : Math.abs(raw);

    return {
      id: row.id,
      kind: classifyTransaction(classifierRow),
      quantity: quantityDelta(classifierRow), // signed
      amount,
      currency,
      date: row.effective_date ?? row.created_at,
    };
  });
}
