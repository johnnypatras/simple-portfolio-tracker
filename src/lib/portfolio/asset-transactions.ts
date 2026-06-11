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
import { CASH_ENTITY_TYPES } from "@/lib/deltas";
import {
  classifyTransaction,
  classifyTransferRole,
  quantityDelta,
  asSnapshot,
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
  /** True when the user explicitly typed the cashflow amount. Inert to the cost
   *  engine + drawer (both read only their own field subsets); consumed by the
   *  cost-basis SERIES (buildCostBasisSeries) as the market-minus-cost GAP gate. */
  cashflow_user_set: boolean;
  before_snapshot: unknown; // Json column — keep unknown, narrow at use-site
  after_snapshot: unknown;
  details: unknown;
  effective_date: string | null;
  created_at: string;
  /** Magnitude the user transacted, in `original_currency`. Display metadata
   *  ONLY (drawer "· paid £500" annotation) — the engine never reads it.
   *  NULL = market-derived or pre-feature row. */
  original_amount: number | null;
  /** ISO-4217 code the user transacted in. Stamped together with
   *  `original_amount` (both-or-neither at the write boundaries). */
  original_currency: string | null;
}

/** Columns selected for the activity_log read — kept in one place for parity. */
const ACTIVITY_SELECT =
  "id, entity_id, entity_type, action, is_yield, is_adjustment, transfer_group_id, split_from_id, cashflow_amount_usd, cashflow_amount_eur, delta_usd, delta_eur, cashflow_user_set, before_snapshot, after_snapshot, details, effective_date, created_at, original_amount, original_currency";

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
      // Exclude undo COMPENSATION rows: undoing an "updated" position mutation
      // (buy-more / partial-sell / transfer leg) inserts a compensating row with
      // is_adjustment=false + cashflow_*=null. The cost engine would read it as a
      // real €0 transaction → corrupted avg cost / realized / unrealized. The
      // ORIGINAL row is already excluded (undo sets undone_at on it), so dropping
      // the compensation too makes the stream behave as "the action never
      // happened" — exactly correct. (Audit trail / History reads keep it.)
      .is("compensates_for", null)
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

  // 4. + 5. Split-orphan de-dup then stable ordering (shared with the bulk read).
  return dedupeAndSortAssetRows(rows);
}

// ─── Transfer counterpart lookup (C2b display enrichment) ────────────────────

/** The counterpart leg of a transfer group, keyed by `transfer_group_id`. Only
 *  the two fields the role helper + annotation need. Module-local — only the
 *  exported `TransferCounterpartMap` alias is consumed externally. */
interface TransferCounterpart {
  entityType: string;
  entityName: string;
}
export type TransferCounterpartMap = Map<string, TransferCounterpart>;

/**
 * For the asset's transfer legs, look up the OTHER leg in each transfer group so
 * the drawer can label a sell/buy-type leg "Sell (to {cash account})" /
 * "Buy (from {cash account})" (C2b). The counterpart is a different entity's
 * activity_log row sharing the same `transfer_group_id`; the mode was never
 * stored, so it is inferred at display time from the two legs' entity types.
 *
 * ONE extra query for all groups (selecting only `id, transfer_group_id,
 * entity_type, entity_name`), scoped exactly like the module's other reads:
 * `.eq("user_id", userId)` (defense-in-depth — the admin client bypasses RLS).
 * Rows already in hand (`excludeIds`) are filtered out in JS so each group's
 * "other" leg remains. A group with >2 legs is degenerate (transfers are
 * two-legged); the first non-excluded leg wins — deterministic via the id order.
 *
 * GRACEFUL DEGRADATION: a lookup failure logs (the module's error convention is
 * a thrown Error wrapped with context; here we instead WARN and return an empty
 * map) so the caller proceeds WITHOUT enrichment — every leg falls back to the
 * plain teal Transfer presentation. No throw, no dead end.
 *
 * @param rows        the asset's already-fetched rows (their group ids + ids).
 * @param excludeIds  ids already in `rows` — excluded so the counterpart is the
 *                    OTHER leg, not the same row.
 */
export async function fetchTransferCounterparts(
  supabase: SupabaseClient<Database>,
  userId: string,
  rows: Pick<AssetTransactionRow, "id" | "transfer_group_id">[],
): Promise<TransferCounterpartMap> {
  const groupIds = [
    ...new Set(
      rows
        .map((r) => r.transfer_group_id)
        .filter((v): v is string => v != null),
    ),
  ];
  if (groupIds.length === 0) return new Map();

  const excludeIds = new Set(rows.map((r) => r.id));

  try {
    const legs = await fetchAllPaginated<{
      id: string;
      transfer_group_id: string | null;
      entity_type: string;
      entity_name: string;
    }>(
      (from, to) =>
        supabase
          .from("activity_log")
          .select("id, transfer_group_id, entity_type, entity_name")
          .eq("user_id", userId) // defense-in-depth — admin bypasses RLS
          .in("transfer_group_id", groupIds)
          .is("undone_at", null)
          .order("id", { ascending: true }) // deterministic counterpart pick
          .range(from, to),
      1000,
      { label: "asset-transactions:transfer-counterparts" },
    );

    const map: TransferCounterpartMap = new Map();
    for (const leg of legs) {
      if (leg.transfer_group_id == null) continue;
      if (excludeIds.has(leg.id)) continue; // the asset's own leg, not the counterpart
      if (map.has(leg.transfer_group_id)) continue; // first non-self leg wins
      map.set(leg.transfer_group_id, {
        entityType: leg.entity_type,
        entityName: leg.entity_name,
      });
    }
    return map;
  } catch (e: unknown) {
    // Graceful: enrichment is optional. Warn and degrade to plain Transfer.
    console.warn(
      `[fetchTransferCounterparts] counterpart lookup failed; rendering plain Transfer: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    // A silent lookup failure strips the Sell/Buy labels off every transfer leg
    // (they fall back to plain "Transfer"), so leave a production breadcrumb for
    // signal without raising alert noise. Fire-and-forget, lazy-imported exactly
    // like the pagination warn path — Sentry's absence never blocks the read.
    void import("@sentry/nextjs")
      .then((Sentry) =>
        Sentry.addBreadcrumb({
          category: "asset-transactions",
          message: "transfer counterpart lookup failed; rendering plain Transfer",
          level: "warning",
          data: { groupCount: groupIds.length },
        }),
      )
      .catch(() => {});
    return new Map();
  }
}

/**
 * Split-orphan de-dup (audit-r6) + stable ordering, shared by
 * {@link getAssetTransactions} (single asset) and {@link getAllAssetTransactions}
 * (per-group, bulk). Extracted so the two read paths can never drift apart.
 *
 * De-dup: a split inserts children then marks the parent undone in a SEPARATE
 * statement (not one transaction), so a crash mid-split can leave a LIVE parent
 * alongside its LIVE children — a double-count. Drop any row whose id is
 * referenced as a `split_from_id` by another live row in the SAME group. (The
 * Set is rebuilt per group by the bulk caller so a child in one asset can never
 * suppress a same-id parent in another — ids are UUIDs, so this is academic, but
 * the per-group scope keeps the invariant local and obvious.)
 *
 * Sort, by economically-faithful key (you cannot dispose before acquiring on the
 * same day): (1) the row's day-granular ECONOMIC date asc, then (2)
 * ACQUISITIONS BEFORE DISPOSALS within the same day, then (3) the full
 * `created_at` recording instant, then (4) `id` (deterministic).
 *
 * (1) The economic date is `effective_date` (already date-only) for a backdated
 *     row, else `created_at` NORMALIZED TO ITS DAY (`.slice(0, 10)`).
 *     Day-normalizing the fallback is load-bearing: comparing a date-only
 *     `effective_date` ("2026-01-01") against a same-day full timestamptz
 *     `created_at` ("2026-01-01T09:00:00+00:00") lexically would sort the
 *     backdated row FIRST on every same-day tie (the date is a string prefix of
 *     the timestamp). With both sides at day granularity same-day rows fall
 *     through to the next key. Mirrors `latestChangeDate` in split-helpers.ts.
 * (2) When the day ties, an ACQUISITION (`quantityDelta > 0`) sorts before a
 *     DISPOSAL (`quantityDelta <= 0`). Two failure modes this fixes: a bulk
 *     import with identical `created_at` would otherwise fall to the random `id`
 *     and let a same-day sell land before its same-day buy ~50% of the time; and
 *     a backdated SELL recorded BEFORE its same-day backdated BUY would order
 *     sell-first by `created_at`. Either mis-attributes realized/unrealized P&L
 *     (and can spuriously oversell) even though `totalPnL` stays invariant. The
 *     sign is precomputed once per row (O(n)) into `signById` so the comparator
 *     is a cheap lookup, not an O(n log n) re-derivation.
 * (3)+(4) Same-day same-direction rows fall through to the real recording order
 *     (`created_at`) then `id`.
 *
 * Returns a NEW array (does not mutate the input). Exported for unit coverage of
 * the comparator (the ordering invariant the cost engine + the #94 cost series
 * both depend on); production callers stay inside this module.
 */
export function dedupeAndSortAssetRows(rows: AssetTransactionRow[]): AssetTransactionRow[] {
  const childParentIds = new Set(
    rows.map((r) => r.split_from_id).filter((v): v is string => v != null),
  );
  const deduped = rows.filter((r) => !childParentIds.has(r.id));

  // Precompute the disposal/acquisition sign per row ONCE (O(n)) so the
  // comparator does not re-run quantityDelta on every comparison. An acquisition
  // (qd > 0) gets order key 0; a disposal or qty-neutral row (qd <= 0) gets 1, so
  // acquisitions sort first on a same-day tie.
  const signById = new Map<string, 0 | 1>();
  for (const r of deduped) {
    const qd = quantityDelta({
      entity_type: r.entity_type,
      action: r.action,
      is_yield: r.is_yield,
      is_adjustment: r.is_adjustment,
      transfer_group_id: r.transfer_group_id,
      split_from_id: r.split_from_id,
      before_snapshot: asSnapshot(r.before_snapshot),
      after_snapshot: asSnapshot(r.after_snapshot),
      details: asSnapshot(r.details),
    });
    signById.set(r.id, qd > 0 ? 0 : 1);
  }

  deduped.sort((a, b) => {
    const da = a.effective_date ?? a.created_at.slice(0, 10);
    const db = b.effective_date ?? b.created_at.slice(0, 10);
    if (da !== db) return da < db ? -1 : 1;
    const sa = signById.get(a.id) ?? 1;
    const sb = signById.get(b.id) ?? 1;
    if (sa !== sb) return sa - sb; // acquisition (0) before disposal (1)
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return deduped;
}

/**
 * Stable per-asset key for the bulk transaction map. The string form (not an
 * object) is deliberate: this Record/Map is keyed by it AND, once threaded onto
 * the portfolio summary as `pnlByAsset`, serializes across the RSC boundary —
 * an object key cannot. crypto/stock keys carry the ASSET id (positions merge
 * into one asset stream); cash carries the account id (which IS the entity_id).
 */
export type AssetKey = `crypto:${string}` | `stock:${string}` | `cash:${string}`;

/**
 * position_id → asset_id for every crypto position owned by `userId`.
 *
 * Mirrors `loadCryptoPositionMeta` in historical-prices-augmentation.ts:
 *   - `crypto_assets!inner(user_id)` + explicit `.eq("crypto_assets.user_id", userId)`
 *     scopes to the owner (the admin client bypasses RLS — this is the only guard).
 *   - NO `.is("deleted_at", null)`: a fully-sold position is soft-deleted but its
 *     activity_log history still feeds the cost engine (realized P&L).
 *   - Paginated past the PostgREST max_rows cap (silent truncation would drop part
 *     of a heavy account's positions → orphaned rows → lost history).
 */
async function loadCryptoPositionAssetMap(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Map<string, string>> {
  const rows = await fetchAllPaginated<{ id: string; crypto_asset_id: string }>(
    (from, to) =>
      supabase
        .from("crypto_positions")
        .select("id, crypto_asset_id, crypto_assets!inner(user_id)")
        .eq("crypto_assets.user_id", userId) // explicit user scope — admin bypasses RLS
        .order("id", { ascending: true })
        .range(from, to),
    1000,
    { label: "all-asset-transactions:crypto_positions" },
  ).catch((e: unknown) => {
    throw new Error(
      `Failed to load crypto position→asset map: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  });
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.id, r.crypto_asset_id);
  return map;
}

/** Stock counterpart of {@link loadCryptoPositionAssetMap}; see its doc comment. */
async function loadStockPositionAssetMap(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Map<string, string>> {
  const rows = await fetchAllPaginated<{ id: string; stock_asset_id: string }>(
    (from, to) =>
      supabase
        .from("stock_positions")
        .select("id, stock_asset_id, stock_assets!inner(user_id)")
        .eq("stock_assets.user_id", userId) // explicit user scope — admin bypasses RLS
        .order("id", { ascending: true })
        .range(from, to),
    1000,
    { label: "all-asset-transactions:stock_positions" },
  ).catch((e: unknown) => {
    throw new Error(
      `Failed to load stock position→asset map: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  });
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.id, r.stock_asset_id);
  return map;
}

/**
 * Read EVERY relevant activity_log row for `userId` in ONE pass and group it by
 * asset into the per-asset streams the cost engine consumes — the bulk
 * counterpart of {@link getAssetTransactions}, for whole-portfolio aggregation
 * (dashboard + share page) where issuing one read per asset would be N+1.
 *
 * Dual-client contract (identical to getAssetTransactions / #97):
 *   - OWNER path: RLS-scoped server client + auth.uid().
 *   - SHARE-PAGE path: service-role admin client + share.owner_id.
 * The admin client BYPASSES RLS, so ownership is enforced EXPLICITLY everywhere:
 * `.eq("user_id", userId)` on the activity read AND `.eq(..._assets.user_id, userId)`
 * on the two position→asset joins. Never rely on RLS alone.
 *
 * Grouping:
 *   - crypto/stock rows: entity_id (a position id) → asset id via the meta maps →
 *     key `crypto:{assetId}` / `stock:{assetId}` (positions of one asset merge).
 *     A row whose position is NOT in the meta map is an ORPHAN (the position was
 *     hard-deleted, or belongs to another user) → SKIPPED, counted, and logged once.
 *   - cash rows: entity_id IS the account id → key `cash:{entity_id}`.
 *
 * Each group is then run through the SAME {@link dedupeAndSortAssetRows} as the
 * single-asset path, so a per-asset slice of this map is byte-for-byte what
 * `getAssetTransactions` would have returned for that asset.
 *
 * Returns rows typed as {@link AssetTransactionRow} (assignable to the engine's
 * CostBasisTxn — a `.test-d.ts` guards it).
 */
export async function getAllAssetTransactions(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Map<AssetKey, AssetTransactionRow[]>> {
  // Per-entity-type paginated reads, mirroring fetchHistoricalPriceInputsFor:
  // each read carries the SAME ACTIVITY_SELECT columns, the user scope, the
  // undone filter, and a deterministic created_at,id order for page stability.
  // `entity_type` is a typed PG enum — the parameter takes the generated enum
  // type (CASH_ENTITY_TYPES is a subset of it) so `.eq` stays strongly typed.
  type EntityType = Database["public"]["Enums"]["entity_type"];
  const entityTypeRange =
    (entityType: EntityType) => (from: number, to: number) =>
      supabase
        .from("activity_log")
        .select(ACTIVITY_SELECT)
        .eq("user_id", userId) // defense-in-depth — admin bypasses RLS
        .eq("entity_type", entityType)
        .is("undone_at", null)
        // Exclude undo COMPENSATION rows (see getAssetTransactions for the full
        // rationale): is_adjustment=false + cashflow_*=null compensation rows
        // would fold as spurious €0 transactions and corrupt the cost basis.
        .is("compensates_for", null)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }) // stable secondary key for deterministic pages
        .range(from, to);

  const loadEntity = (entityType: EntityType, label: string) =>
    fetchAllPaginated<AssetTransactionRow>(entityTypeRange(entityType), 1000, {
      label,
    }).catch((e: unknown) => {
      throw new Error(
        `Failed to load ${entityType} transactions: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    });

  // Activity reads (per entity type) + the two position→asset meta maps, all in
  // parallel — they are independent. Cash needs no meta map (entity_id IS the key).
  const [cryptoRows, stockRows, cryptoAssetMap, stockAssetMap, ...cashRowsByType] =
    await Promise.all([
      loadEntity("crypto_position", "all-asset-transactions:crypto"),
      loadEntity("stock_position", "all-asset-transactions:stock"),
      loadCryptoPositionAssetMap(supabase, userId),
      loadStockPositionAssetMap(supabase, userId),
      ...CASH_ENTITY_TYPES.map((t) =>
        loadEntity(t, `all-asset-transactions:${t}`),
      ),
    ]);

  // Group raw rows by AssetKey (no de-dup/sort yet — done per group at the end).
  const groups = new Map<AssetKey, AssetTransactionRow[]>();
  const push = (key: AssetKey, row: AssetTransactionRow) => {
    const arr = groups.get(key);
    if (arr) arr.push(row);
    else groups.set(key, [row]);
  };

  let cryptoOrphans = 0;
  for (const row of cryptoRows) {
    const assetId = row.entity_id ? cryptoAssetMap.get(row.entity_id) : undefined;
    if (!assetId) {
      cryptoOrphans++;
      continue;
    }
    push(`crypto:${assetId}`, row);
  }

  let stockOrphans = 0;
  for (const row of stockRows) {
    const assetId = row.entity_id ? stockAssetMap.get(row.entity_id) : undefined;
    if (!assetId) {
      stockOrphans++;
      continue;
    }
    push(`stock:${assetId}`, row);
  }

  // Cash: entity_id IS the account id; ownership already enforced by the
  // .eq("user_id", userId) on the read. A null entity_id is skipped (cannot key).
  for (const rows of cashRowsByType) {
    for (const row of rows) {
      if (!row.entity_id) continue;
      push(`cash:${row.entity_id}`, row);
    }
  }

  // Orphan rows mean a position was hard-deleted (or, with the admin client, a
  // scoping bug). One aggregated warn per type — not per row — keeps the signal
  // without flooding logs; the count is the actionable part.
  if (cryptoOrphans > 0 || stockOrphans > 0) {
    console.warn(
      `[getAllAssetTransactions] skipped orphan activity rows (position not in meta map): crypto=${cryptoOrphans}, stock=${stockOrphans}`,
    );
  }

  // De-dup + stable-sort each group exactly as the single-asset read does, so a
  // per-asset slice equals getAssetTransactions(asset) for that asset.
  const out = new Map<AssetKey, AssetTransactionRow[]>();
  for (const [key, rows] of groups) {
    out.set(key, dedupeAndSortAssetRows(rows));
  }
  return out;
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
 *   - originalAmount/originalCurrency = original_* (Task 9), populated only
 *     when BOTH columns are non-null — the user's as-typed money event for the
 *     drawer's "· paid £500" annotation.
 *
 * Direction is conveyed by the sign of `quantity` and the kind badge, so `amount`
 * is shown as a magnitude.
 *
 * `counterparts` (C2b, optional): when supplied — the {@link fetchTransferCounterparts}
 * map — a transfer leg whose counterpart is a tracked cash account is enriched
 * with `transferRole` ("sell"/"buy") + `counterpartName` so the drawer renders
 * "Sell (to Alpha Bank)" / "Buy (from Alpha Bank)". The leg's `kind` STAYS
 * "transfer" — only the presentation changes. A leg resolving to "move" (or with
 * no counterpart, or when the map is omitted) leaves both fields absent → plain
 * Transfer. Stays PURE: the map is precomputed by the caller, not fetched here.
 */
export function toTransactionDisplayRows(
  rows: AssetTransactionRow[],
  currency: "EUR" | "USD",
  counterparts?: TransferCounterpartMap,
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

    const display: TransactionDisplayRow = {
      id: row.id,
      kind: classifyTransaction(classifierRow),
      quantity: quantityDelta(classifierRow), // signed
      amount,
      currency,
      date: row.effective_date ?? row.created_at,
    };

    // Task 9: thread the user's original (amount, currency) through — populated
    // ONLY when both halves are present (they are stamped together; a half-set
    // pair is treated as absent). Same-currency suppression is the drawer's
    // rule, not the mapper's: values pass through mechanically.
    if (row.original_amount != null && row.original_currency != null) {
      display.originalAmount = row.original_amount;
      display.originalCurrency = row.original_currency;
    }

    // C2b: enrich a sell/buy-type transfer leg with its display role + the
    // counterpart account name. `kind` stays "transfer" — this is presentation
    // only. Set the two fields ONLY for "sell"/"buy" (a "move" leg keeps the
    // plain Transfer presentation, so both stay absent).
    if (counterparts && row.transfer_group_id != null) {
      const counterpart = counterparts.get(row.transfer_group_id) ?? null;
      const role = classifyTransferRole(
        { entityType: row.entity_type, quantityDelta: display.quantity },
        counterpart,
      );
      if ((role === "sell" || role === "buy") && counterpart) {
        display.transferRole = role;
        display.counterpartName = counterpart.entityName;
      }
    }

    return display;
  });
}
