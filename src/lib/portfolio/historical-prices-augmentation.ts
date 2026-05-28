import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import type { Database } from "@/types/database";
import { createAdminClient } from "@/lib/supabase/admin";
import { positionQtyDelta, cashDelta } from "@/lib/deltas";
import { isStablecoin } from "@/lib/cashflow";
import { pickJoinedRecord } from "@/lib/supabase/join-utils";
import { fetchAllPaginated } from "@/lib/supabase/pagination";
import {
  fetchYahooDailyHistory,
  fetchFxUsdPivotHistory,
} from "@/lib/prices/historical";
import type { ActionType, PortfolioSnapshot, CashFlowEvent } from "@/lib/types";

/**
 * One cached historical price. `asset_key` is canonical per kind:
 *   crypto = coingecko_id, stock = yahoo_ticker, fx = currency code
 *   (price = USD per 1 unit of that currency).
 * Kept in this pure module (no "use server") so synthesis is unit-testable
 * without Supabase, Next.js, or RLS — mirrors manual-nav-augmentation.ts.
 */
export type HistoricalPriceRow = {
  asset_kind: "crypto" | "stock" | "fx";
  asset_key: string;
  price_date: string; // YYYY-MM-DD
  price: number;
  currency: string;
};

/** A single quantity change for a position, dated by effective_date. */
export type QtyDelta = {
  effective_date: string;
  qty_delta: number;
  /** Phase 2: true when this delta came from an is_adjustment activity row
   *  (excluded from deriveCashFlows → needs a synthetic benchmark cash flow). */
  is_adjustment?: boolean;
};

/**
 * A backdated crypto/stock/cash lot needing historical reconstruction.
 *   - asset_key: storage/lookup key (coingecko_id | yahoo_ticker | cash_account.id)
 *   - fetch_symbol: Yahoo symbol used by the fetch layer
 *       (`${ticker}-USD` for crypto, yahoo_ticker for stock, "" for cash — unused)
 *   - native_currency: "USD" for crypto (Yahoo {SYM}-USD is USD-denominated);
 *       the native trading currency for stock; the account's currency for cash
 *   - capture_date: the date the daily cron first included this lot in
 *       snapshots (= date of the position's earliest activity_log entry).
 *       Augment ONLY snapshot dates < capture_date — on/after it the cron
 *       already prices the lot, so augmenting would double-count.
 *   - deltas: quantity (or balance, for cash) changes by effective_date
 *       (need not be pre-sorted).
 *
 * Cash lots: face value (no Yahoo fetch). asset_key is synthetic (cash_account.id),
 * fetch_symbol is "" (unused), cumulativeAtDate replays balance changes directly.
 */
export type HistoricalLot = {
  position_id: string;
  asset_kind: "crypto" | "stock" | "cash";
  asset_key: string;
  fetch_symbol: string;
  native_currency: string;
  asset_class: "crypto" | "stocks" | "cash";
  capture_date: string;
  deltas: QtyDelta[];
};

/** Map key for the price index: `${asset_kind}:${asset_key}`. */
function priceKey(asset_kind: string, asset_key: string): string {
  return `${asset_kind}:${asset_key}`;
}

/**
 * Binary search for the largest-date price at-or-before `targetDate`.
 * `pricesAsc` MUST be sorted ascending by price_date. Forward-fill semantics
 * (returns the most-recent prior price across weekend/holiday gaps).
 * O(log n). Mirrors findNavAtOrBefore in manual-nav-augmentation.ts.
 */
export function findPriceAtOrBefore(
  pricesAsc: HistoricalPriceRow[],
  targetDate: string,
): number | null {
  if (pricesAsc.length === 0) return null;
  let lo = 0;
  let hi = pricesAsc.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (pricesAsc[mid].price_date <= targetDate) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result >= 0 ? pricesAsc[result].price : null;
}

/**
 * Group price rows by `${asset_kind}:${asset_key}`, each list sorted ascending
 * by price_date for binary search regardless of caller-supplied order.
 */
export function buildPriceIndex(
  rows: HistoricalPriceRow[],
): Map<string, HistoricalPriceRow[]> {
  const index = new Map<string, HistoricalPriceRow[]>();
  for (const row of rows) {
    const key = priceKey(row.asset_kind, row.asset_key);
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push(row);
  }
  for (const list of index.values()) {
    list.sort((a, b) => a.price_date.localeCompare(b.price_date));
  }
  return index;
}

/**
 * Cumulative quantity at `date` = sum of every qty_delta whose effective_date
 * is on-or-before `date`. Returns 0 before the first delta — this is the
 * building block of the "$0 before purchase" invariant. Used for position
 * quantity (Phase 1) and cash balance.
 *
 * Float accumulation order is iteration order; floating-point addition is
 * not associative, so two callers iterating the same input in different
 * orders may differ in the last few ULPs. For portfolio-scale quantities
 * (typically <1e10 with <20 decimal places, per the NUMERIC(28, 18) column
 * type) the cumulative error stays well below display precision (rendering
 * already rounds to 6 decimal places for sub-$1 crypto, 2 otherwise).
 */
export function cumulativeAtDate(deltas: QtyDelta[], date: string): number {
  let qty = 0;
  for (const d of deltas) {
    if (d.effective_date <= date) qty += d.qty_delta;
  }
  return qty;
}

/**
 * USD per 1 unit of `currency` at `date`. USD is the pivot: "USD" → 1 without
 * touching the index. Foreign currencies are looked up from fx rows
 * (asset_kind='fx', asset_key=currency, price=USD per 1 unit), forward-filled.
 * Returns null when no rate is available at-or-before `date`.
 */
export function usdPerUnit(
  fxIndex: Map<string, HistoricalPriceRow[]>,
  currency: string,
  date: string,
): number | null {
  if (currency === "USD") return 1;
  const list = fxIndex.get(priceKey("fx", currency));
  if (!list) return null;
  const rate = findPriceAtOrBefore(list, date);
  return rate !== null && Number.isFinite(rate) ? rate : null;
}

/**
 * One lot's contribution to a snapshot date, in USD and EUR.
 *
 *   qty   = cumulativeAtDate(lot.deltas, date)        // 0 before purchase
 *   price = findPriceAtOrBefore(prices[kind:key], date) // forward-filled
 *   valueNative = qty × price (in lot.native_currency)
 *   usd  = valueNative × usdPerUnit(native_currency, date)
 *   eur  = usd × eurPerUsd(date), eurPerUsd = 1 / usdPerUnit("EUR", date)
 *
 * Returns:
 *   { usd: 0, eur: 0 } when qty is 0 (the $0-before-purchase invariant, and
 *       after a full sell) — a real, intentional zero contribution.
 *   null when a value cannot be computed (no price yet, or NaN/Infinity, or no
 *       USD rate for the native currency) — caller skips, never fabricates.
 *
 * The EUR mirror is skipped (eur stays 0) when no EUR fx rate is available,
 * rather than writing a 1:1 identity copy (the audit R1 Phase 5 contract).
 */
export function lotContributionAtDate(
  lot: HistoricalLot,
  date: string,
  priceIndex: Map<string, HistoricalPriceRow[]>,
  fxIndex: Map<string, HistoricalPriceRow[]>,
): { usd: number; eur: number } | null {
  const qty = cumulativeAtDate(lot.deltas, date);
  if (!Number.isFinite(qty)) return null;
  if (qty === 0) return { usd: 0, eur: 0 };
  // Negative net qty signals a data-integrity issue or an unsupported short
  // position. Skip (null) rather than inject a negative contribution that
  // would silently depress chart totals. Phase 1 produces only qty >= 0.
  if (qty < 0) return null;

  let valueNative: number;
  if (lot.asset_kind === "cash") {
    // Cash: face value. No historical price lookup — cumulativeAtDate is the
    // balance at `date` in the account's native currency. FX still applies
    // below (same usdRate / EUR-mirror logic as crypto/stock).
    valueNative = qty;
  } else {
    const prices = priceIndex.get(priceKey(lot.asset_kind, lot.asset_key));
    if (!prices) return null;
    const priceNative = findPriceAtOrBefore(prices, date);
    if (priceNative === null || !Number.isFinite(priceNative) || priceNative <= 0) {
      return null;
    }
    valueNative = qty * priceNative;
    if (!Number.isFinite(valueNative)) return null;
  }

  // Native → USD.
  const usdRate = usdPerUnit(fxIndex, lot.native_currency, date);
  if (usdRate === null || !Number.isFinite(usdRate) || usdRate <= 0) return null;
  const usd = valueNative * usdRate;
  if (!Number.isFinite(usd)) return null;

  // USD → EUR via eurPerUsd = 1 / usdPerUnit("EUR"). Skip mirror if unknown.
  const usdPerEur = usdPerUnit(fxIndex, "EUR", date);
  let eur = 0;
  if (usdPerEur !== null && Number.isFinite(usdPerEur) && usdPerEur > 0) {
    eur = usd / usdPerEur;
    if (!Number.isFinite(eur)) eur = 0;
  }

  return { usd, eur };
}

/** Iterate dates from `start` to `end` inclusive, daily, as YYYY-MM-DD. */
function* eachDay(start: string, end: string): Generator<string> {
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

/** Add a USD+EUR contribution to the right asset-class columns + totals. */
function addContribution(
  snap: PortfolioSnapshot,
  assetClass: "crypto" | "stocks" | "cash",
  usd: number,
  eur: number,
): PortfolioSnapshot {
  if (assetClass === "crypto") {
    return {
      ...snap,
      crypto_value_usd: (snap.crypto_value_usd ?? 0) + usd,
      crypto_value_eur: (snap.crypto_value_eur ?? 0) + eur,
      total_value_usd: (snap.total_value_usd ?? 0) + usd,
      total_value_eur: (snap.total_value_eur ?? 0) + eur,
    };
  }
  if (assetClass === "stocks") {
    return {
      ...snap,
      stocks_value_usd: (snap.stocks_value_usd ?? 0) + usd,
      stocks_value_eur: (snap.stocks_value_eur ?? 0) + eur,
      total_value_usd: (snap.total_value_usd ?? 0) + usd,
      total_value_eur: (snap.total_value_eur ?? 0) + eur,
    };
  }
  // cash: route to cash_value_* + total (mirrors crypto/stocks routing).
  return {
    ...snap,
    cash_value_usd: (snap.cash_value_usd ?? 0) + usd,
    cash_value_eur: (snap.cash_value_eur ?? 0) + eur,
    total_value_usd: (snap.total_value_usd ?? 0) + usd,
    total_value_eur: (snap.total_value_eur ?? 0) + eur,
  };
}

/**
 * Build a fresh synthesized snapshot for `date` from all lots active then.
 * Synthetic rows are flagged with id `synthetic:<date>` and inherit user_id
 * from `template` (the earliest real snapshot, or a stub if none exist).
 */
function synthesizeRow(
  date: string,
  lots: HistoricalLot[],
  priceIndex: Map<string, HistoricalPriceRow[]>,
  fxIndex: Map<string, HistoricalPriceRow[]>,
  template: PortfolioSnapshot | null,
): PortfolioSnapshot {
  let row: PortfolioSnapshot = {
    id: `synthetic:${date}`,
    user_id: template?.user_id ?? "",
    snapshot_date: date,
    total_value_usd: 0,
    total_value_eur: 0,
    crypto_value_usd: 0,
    stocks_value_usd: 0,
    cash_value_usd: 0,
    crypto_value_eur: 0,
    stocks_value_eur: 0,
    cash_value_eur: 0,
    stocks_eur_denominated_value: 0,
    cash_eur_denominated_value: 0,
    created_at: `${date}T00:00:00Z`,
  };
  for (const lot of lots) {
    const c = lotContributionAtDate(lot, date, priceIndex, fxIndex);
    if (c === null) continue;
    row = addContribution(row, lot.asset_class, c.usd, c.eur);
  }
  return row;
}

/**
 * Extend and augment the snapshot series with exact historical-price
 * contributions for backdated crypto/stock lots.
 *
 *   AUGMENT: for each existing snapshot whose date is in [effective, capture)
 *     for a lot, add that lot's qty × historical-price contribution. (On/after
 *     capture_date the cron already prices it — left untouched to avoid
 *     double-counting.)
 *   SYNTHESIZE: for every day in [earliest effective_date, first-snapshot-date)
 *     create a new row summing all lots active that day.
 *
 * Returns a new array sorted ascending by snapshot_date. Pure. Caller must pass
 * only lots that actually have cached prices (graceful degradation upstream).
 *
 * EUR completeness depends on FX coverage spanning the synthesized range: a
 * date with no FX rate at-or-before it yields eur=0 (honest no-fabrication —
 * never a 1:1 copy). The fetch layer pads the FX fetch backward so a prior
 * rate always exists to forward-fill from. The no-real-snapshots branch reads
 * the wall clock (the only impurity in this otherwise pure function).
 */
export function augmentAndExtendSnapshots(
  snapshots: PortfolioSnapshot[],
  lots: HistoricalLot[],
  prices: HistoricalPriceRow[],
): PortfolioSnapshot[] {
  if (lots.length === 0) return snapshots;

  const priceIndex = buildPriceIndex(prices);
  const fxIndex = priceIndex; // fx rows live in the same index under "fx:<cur>"

  // ── AUGMENT existing snapshots in [effective, capture) per lot ──────────
  const augmented = snapshots.map((snap) => {
    let row = snap;
    for (const lot of lots) {
      if (snap.snapshot_date >= lot.capture_date) continue; // cron already has it
      const c = lotContributionAtDate(lot, snap.snapshot_date, priceIndex, fxIndex);
      if (c === null) continue;
      if (c.usd === 0 && c.eur === 0) continue; // before effective_date / sold out
      row = addContribution(row, lot.asset_class, c.usd, c.eur);
    }
    return row;
  });

  // ── SYNTHESIZE pre-first-snapshot rows ──────────────────────────────────
  const sortedReal = [...augmented].sort((a, b) =>
    a.snapshot_date.localeCompare(b.snapshot_date),
  );
  const firstSnapshotDate = sortedReal.length > 0 ? sortedReal[0].snapshot_date : null;

  let earliestEffective: string | null = null;
  for (const lot of lots) {
    for (const d of lot.deltas) {
      if (earliestEffective === null || d.effective_date < earliestEffective) {
        earliestEffective = d.effective_date;
      }
    }
  }
  if (earliestEffective === null) return sortedReal;

  const synthFloor = isoDaysAgo(MAX_SYNTHESIS_DAYS);
  if (earliestEffective < synthFloor) earliestEffective = synthFloor;

  const synthEnd = firstSnapshotDate
    ? isoDayBefore(firstSnapshotDate)
    : new Date().toISOString().slice(0, 10);

  const synthesized: PortfolioSnapshot[] = [];
  if (earliestEffective <= synthEnd) {
    const template = sortedReal[0] ?? null;
    for (const date of eachDay(earliestEffective, synthEnd)) {
      synthesized.push(synthesizeRow(date, lots, priceIndex, fxIndex, template));
    }
  }

  return [...synthesized, ...sortedReal];
}

/** YYYY-MM-DD for the day before `date`. */
function isoDayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD for `days` days before today (UTC). */
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Cap how far back synthesis runs. effective_date is only validated as
 * past-or-today, so a typo (e.g. 1900) would otherwise fan out tens of
 * thousands of synthesized rows per SSR render. 25 years covers any realistic
 * crypto/stock holding while bounding pathological input.
 */
const MAX_SYNTHESIS_DAYS = 9131; // ~25 years

// ─────────────────────────────────────────────────────────────────────────────
// I/O layer (Task 6) — queries, cache fill, public orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read ALL historical_prices rows for the given asset_keys, paging past the
 * server-side max_rows cap. A single multi-year asset exceeds 1000 rows; an
 * unpaged read silently truncates — synthesis loses price dates and later keys
 * (e.g. fx:EUR) fall off the first page entirely, collapsing the EUR mirror to
 * 0 (zero-ramp). Verified via a real 2 BTC / 3-year smoke (1097 BTC + 770 EUR;
 * a single .limit(100_000) read returned only 1000). Stable order over the
 * UNIQUE(asset_kind, asset_key, price_date) columns guarantees page integrity.
 */
async function readAllHistoricalPrices(
  client: SupabaseClient<Database>,
  assetKeys: string[],
): Promise<HistoricalPriceRow[]> {
  if (assetKeys.length === 0) return [];
  // Single-source pagination via fetchAllPaginated: keeps the ".order(...)
  // before .range(...)" invariant + the "stop-on-short-page" semantics in one
  // tested place. Error wrapping preserves the original message and attaches
  // the raw error via `cause` (ES2022) for upstream stack chains.
  type Row = {
    asset_kind: string;
    asset_key: string;
    price_date: string;
    price: number | string;
    currency: string;
  };
  const rows = await fetchAllPaginated<Row>((from, to) =>
    client
      .from("historical_prices")
      .select("asset_kind, asset_key, price_date, price, currency")
      .in("asset_key", assetKeys)
      .order("asset_kind", { ascending: true })
      .order("asset_key", { ascending: true })
      .order("price_date", { ascending: true })
      .range(from, to),
  ).catch((e: unknown) => {
    throw new Error(
      `historical_prices read failed: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  });
  return rows.map<HistoricalPriceRow>((r) => ({
    asset_kind: r.asset_kind as HistoricalPriceRow["asset_kind"],
    asset_key: r.asset_key,
    price_date: r.price_date,
    price: Number(r.price),
    currency: r.currency,
  }));
}

/**
 * Position/account IDs whose activity is BACKDATED — exactly the set of
 * entities that buildHistoricalLots would emit as lots (criterion: earliest
 * non-null effective_date < earliest created_at::date over the entity's
 * activity).
 *
 * Surfaces lot-level granularity for callers that need to reason about which
 * positions/accounts contribute backdated value (vs. today-dated only). The
 * augmentation pipeline derives the same set internally via buildHistoricalLots;
 * this helper exposes it for direct consumers.
 *
 * Paginated past the server max_rows cap. Bounded to crypto_position +
 * stock_position + cash_account activity for the user.
 */
export async function readBackdatedPositionIds(
  client: SupabaseClient<Database>,
  userId: string,
): Promise<Set<string>> {
  // Single-source pagination via fetchAllPaginated. Aggregation (entity_id →
  // MIN effective_date / created_at) happens after the full read; safe
  // because the in-memory fold is O(N) and N is bounded by the user's
  // total activity_log rows for crypto/stock/cash entities.
  type Row = {
    entity_id: string | null;
    effective_date: string | null;
    created_at: string | null;
  };
  const rows = await fetchAllPaginated<Row>((from, to) =>
    client
      .from("activity_log")
      .select("entity_id, effective_date, created_at")
      .eq("user_id", userId)
      .in("entity_type", ["crypto_position", "stock_position", "cash_account"])
      .is("undone_at", null)
      .order("entity_id", { ascending: true })
      .order("created_at", { ascending: true })
      .range(from, to),
  ).catch((e: unknown) => {
    throw new Error(
      `Failed to load activity for backdated detection: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  });
  const minEff = new Map<string, string>(); // entity_id → MIN non-null effective_date
  const minCap = new Map<string, string>(); // entity_id → MIN created_at::date
  for (const r of rows) {
    const id = r.entity_id;
    if (!id) continue;
    const eff = r.effective_date;
    const capRaw = r.created_at;
    if (!capRaw) continue;
    const cap = capRaw.slice(0, 10);
    if (eff && (!minEff.has(id) || eff < minEff.get(id)!)) minEff.set(id, eff);
    if (!minCap.has(id) || cap < minCap.get(id)!) minCap.set(id, cap);
  }
  const backdated = new Set<string>();
  for (const [id, eff] of minEff) {
    const cap = minCap.get(id);
    if (cap && eff < cap) backdated.add(id);
  }
  return backdated;
}

/**
 * Distinct cached `${asset_kind}:${asset_key}` keys among `candidateKeys`,
 * paging past the max_rows cap. Used by the cache-coverage skip-check and the
 * back-fill exclusion gate — both must NOT under-detect coverage (a missed key
 * → wasteful re-fetch, or worse, a lot not excluded from the back-fill →
 * double-count). Selecting only the two key columns keeps pages dense, but the
 * server still caps row COUNT (one row per date), so paging is required.
 */
export async function readHistoricalCoverageKeys(
  client: SupabaseClient<Database>,
  candidateKeys: string[],
): Promise<Set<string>> {
  const covered = new Set<string>();
  if (candidateKeys.length === 0) return covered;
  // Single-source pagination via fetchAllPaginated. The ordering matches
  // readAllHistoricalPrices for parity (same table, same composite key).
  type Row = { asset_kind: string; asset_key: string; price_date: string };
  const rows = await fetchAllPaginated<Row>((from, to) =>
    client
      .from("historical_prices")
      .select("asset_kind, asset_key, price_date")
      .in("asset_key", candidateKeys)
      .order("asset_kind", { ascending: true })
      .order("asset_key", { ascending: true })
      .order("price_date", { ascending: true })
      .range(from, to),
  ).catch((e: unknown) => {
    throw new Error(
      `historical_prices coverage read failed: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  });
  for (const r of rows) covered.add(`${r.asset_kind}:${r.asset_key}`);
  return covered;
}

/** One activity-log row joined with its asset metadata, for lot building. */
export type ActivityForLot = {
  entity_id: string;
  entity_type: string; // "crypto_position" | "stock_position" | "cash_account"
  action: string;
  effective_date: string | null;
  created_at: string;
  before_quantity: number | null;
  after_quantity: number | null;
  /** Override for split-child rows + cash entries (cash uses balance via cashDelta). */
  qty_delta_override?: number;
  is_adjustment: boolean;
  asset_kind: "crypto" | "stock" | "cash";
  asset_key: string;       // coingecko_id | yahoo_ticker | cash_account.id
  fetch_symbol: string;    // `${ticker}-USD` | yahoo_ticker | "" (unused for cash)
  native_currency: string;
  asset_class: "crypto" | "stocks" | "cash";
};

/**
 * Group activity rows into HistoricalLots. Pure.
 *   - capture_date = date of the position's earliest created_at (when the cron
 *     first captured it). crypto_positions/stock_positions have no created_at
 *     column, so this comes from activity_log.
 *   - deltas = positionQtyDelta(action, before, after) per row, dated by
 *     COALESCE(effective_date, created_at-date).
 *   - A lot is kept only if backdated: earliest effective_date < capture_date.
 *     Otherwise its augment range [effective, capture) is empty (no work).
 */
export function buildHistoricalLots(rows: ActivityForLot[]): HistoricalLot[] {
  const byPos = new Map<string, ActivityForLot[]>();
  for (const r of rows) {
    if (!byPos.has(r.entity_id)) byPos.set(r.entity_id, []);
    byPos.get(r.entity_id)!.push(r);
  }

  const lots: HistoricalLot[] = [];
  for (const [positionId, group] of byPos) {
    const first = group[0];
    let captureDate = group[0].created_at.slice(0, 10);
    const deltas: QtyDelta[] = [];
    for (const r of group) {
      const day = r.created_at.slice(0, 10);
      if (day < captureDate) captureDate = day;
      const qtyDelta = r.qty_delta_override ?? positionQtyDelta(
        r.action as ActionType,
        r.before_quantity ?? 0,
        r.after_quantity ?? 0,
      );
      if (qtyDelta === 0) continue;
      deltas.push({
        effective_date: r.effective_date ?? day,
        qty_delta: qtyDelta,
        is_adjustment: r.is_adjustment,
      });
    }
    if (deltas.length === 0) continue;

    const earliestEffective = deltas.reduce(
      (min, d) => (d.effective_date < min ? d.effective_date : min),
      deltas[0].effective_date,
    );
    if (earliestEffective >= captureDate) continue; // not backdated → skip

    lots.push({
      position_id: positionId,
      asset_kind: first.asset_kind,
      asset_key: first.asset_key,
      fetch_symbol: first.fetch_symbol,
      native_currency: first.native_currency,
      asset_class: first.asset_class,
      capture_date: captureDate,
      deltas,
    });
  }
  return lots;
}

/**
 * Ensure the cache holds prices for every lot's asset over [earliestEffective,
 * captureEnd], plus USD-pivot FX for every native currency + EUR. Fetches only
 * MISSING (asset_key) series (coarse, idempotent — re-fetch is harmless thanks
 * to the UNIQUE constraint), upserts via the service-role admin client (the
 * only role allowed to write), and returns ALL relevant cached rows. Network
 * failures degrade gracefully (the lot simply won't be in the returned set →
 * caller leaves it on the back-fill).
 *
 * Cache invariant: exactly one currency per (asset_kind, asset_key) — crypto is
 * USD (Yahoo {SYM}-USD), stock is its native currency, fx is USD-per-unit.
 */
export async function ensureHistoricalPricesCached(
  lots: HistoricalLot[],
): Promise<HistoricalPriceRow[]> {
  if (lots.length === 0) return [];
  const admin = createAdminClient();

  let rangeStart = lots[0].deltas[0].effective_date;
  let rangeEnd = lots[0].capture_date;
  const currencies = new Set<string>(["EUR"]); // always need EUR for the mirror
  const assetSeries = new Map<
    string,
    { kind: "crypto" | "stock"; symbol: string; currency: string }
  >();
  for (const lot of lots) {
    for (const d of lot.deltas) {
      if (d.effective_date < rangeStart) rangeStart = d.effective_date;
    }
    if (lot.capture_date > rangeEnd) rangeEnd = lot.capture_date;
    // Cash lots: face value — no Yahoo asset fetch — but their native currency
    // still needs an FX series for the USD/EUR mirror at synthesized dates.
    if (lot.native_currency !== "USD") currencies.add(lot.native_currency);
    if (lot.asset_kind === "cash") continue;
    assetSeries.set(`${lot.asset_kind}:${lot.asset_key}`, {
      kind: lot.asset_kind,
      symbol: lot.fetch_symbol,
      currency: lot.native_currency,
    });
  }

  const relevantKeys = [
    ...new Set([
      ...[...assetSeries.keys()].map((k) => k.slice(k.indexOf(":") + 1)),
      ...currencies,
    ]),
  ];
  const cachedKeys = await readHistoricalCoverageKeys(admin, relevantKeys);

  const toUpsert: Array<Database["public"]["Tables"]["historical_prices"]["Insert"]> = [];

  for (const [key, meta] of assetSeries) {
    // NOTE: coarse per-asset_key coverage gate. If an asset was previously
    // cached for a later date range and a NEW lot needs earlier dates, the
    // earlier range won't be re-fetched (those synthesized dates get no price
    // → graceful no-contribution, not wrong data). Acceptable for Phase 1
    // (single-user, rare); a future fix tracks MIN(price_date) per asset_key.
    if (cachedKeys.has(key)) continue;
    const assetKey = key.slice(key.indexOf(":") + 1);
    const points = await fetchYahooDailyHistory(meta.symbol, rangeStart, rangeEnd);
    for (const p of points) {
      toUpsert.push({
        asset_kind: meta.kind,
        asset_key: assetKey,
        price_date: p.date,
        price: p.price,
        currency: meta.currency,
      });
    }
  }

  for (const cur of currencies) {
    if (cachedKeys.has(`fx:${cur}`)) continue;
    const points = await fetchFxUsdPivotHistory(cur, rangeStart, rangeEnd);
    for (const p of points) {
      toUpsert.push({
        asset_kind: "fx",
        asset_key: cur,
        price_date: p.date,
        price: p.price,
        currency: "USD",
      });
    }
  }

  if (toUpsert.length > 0) {
    const { error } = await admin
      .from("historical_prices")
      .upsert(toUpsert, {
        onConflict: "asset_kind,asset_key,price_date",
        ignoreDuplicates: true,
      });
    if (error) {
      console.error("[historical] cache upsert failed:", error.message);
      Sentry.captureException(
        new Error(`historical_prices upsert failed: ${error.message}`),
      );
    }
  }

  const assetKeys = [...assetSeries.keys()].map((k) => k.slice(k.indexOf(":") + 1));
  const allKeys = [...new Set([...assetKeys, ...currencies])];
  try {
    return await readAllHistoricalPrices(admin, allKeys);
  } catch (err) {
    console.error("[historical] cache read failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Gather a user's backdated crypto/stock/cash lots from the activity log + asset
 * joins, build HistoricalLots, ensure their prices are cached, and return both.
 * Mirrors fetchManualNavInputsFor's client contract:
 *   - Authenticated server client + resolved auth.uid() → RLS-scoped read.
 *   - Admin client + explicit owner userId → cross-user (share/comparison).
 * Cache WRITES always use the service-role admin client internally (the only
 * role allowed to write historical_prices), regardless of the read client.
 */
export async function fetchHistoricalPriceInputsFor(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<{ lots: HistoricalLot[]; prices: HistoricalPriceRow[] }> {
  // Paginate past the PostgREST max_rows cap (default 1000): heavy DCA users
  // can exceed 1000 activity rows per asset class. A silently truncated read
  // would drop the most-recent (= largest by created_at) rows, breaking lot
  // delta reconstruction and the historical back-extension contract.
  // Ordering MUST come before .range() for deterministic page integrity.
  // Stable secondary key on `id` (UUID, UNIQUE) guarantees deterministic page
  // boundaries even when two rows share the same created_at.
  const cryptoActivityRange = (from: number, to: number) =>
    supabase
      .from("activity_log")
      .select(
        "entity_id, action, effective_date, created_at, before_snapshot, after_snapshot, details, split_from_id, is_adjustment",
      )
      .eq("user_id", userId)
      .eq("entity_type", "crypto_position")
      .is("undone_at", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
  const stockActivityRange = (from: number, to: number) =>
    supabase
      .from("activity_log")
      .select(
        "entity_id, action, effective_date, created_at, before_snapshot, after_snapshot, details, split_from_id, is_adjustment",
      )
      .eq("user_id", userId)
      .eq("entity_type", "stock_position")
      .is("undone_at", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
  const cashActivityRange = (from: number, to: number) =>
    supabase
      .from("activity_log")
      .select(
        "entity_id, action, effective_date, created_at, before_snapshot, after_snapshot, is_adjustment",
      )
      .eq("user_id", userId)
      .eq("entity_type", "cash_account")
      .is("undone_at", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
  // Explicit row shapes for the three selects above. Mirrors the explicit-shape
  // pattern used by loadCryptoPositionMeta/loadStockPositionMeta/loadCashAccountMeta
  // below — at shape-divergence points the project convention is
  // `fetchAllPaginated<{ ... }>` listing the exact columns selected, NOT
  // `Awaited<ReturnType<...>>` inference (opaque to readers and easy to drift
  // out of sync silently when the .select() list changes). Json-typed columns
  // (before_snapshot / after_snapshot / details) stay `unknown` here and are
  // narrowed at use-site with explicit `as { ... } | null` casts (the
  // boundary-normalization pattern documented in CLAUDE.md).
  type CryptoOrStockActivityRow = {
    entity_id: string | null;
    action: ActionType;
    effective_date: string | null;
    created_at: string;
    before_snapshot: unknown;
    after_snapshot: unknown;
    details: unknown;
    split_from_id: string | null;
    is_adjustment: boolean;
  };
  type CashActivityRow = {
    entity_id: string | null;
    action: ActionType;
    effective_date: string | null;
    created_at: string;
    before_snapshot: unknown;
    after_snapshot: unknown;
    is_adjustment: boolean;
  };
  const [cryptoRows, stockRows, cashRows] = await Promise.all([
    fetchAllPaginated<CryptoOrStockActivityRow>(cryptoActivityRange).catch((e: unknown) => {
      throw new Error(
        `Failed to load crypto activity: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }),
    fetchAllPaginated<CryptoOrStockActivityRow>(stockActivityRange).catch((e: unknown) => {
      throw new Error(
        `Failed to load stock activity: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }),
    fetchAllPaginated<CashActivityRow>(cashActivityRange).catch((e: unknown) => {
      throw new Error(
        `Failed to load cash activity: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }),
  ]);

  const [cryptoMeta, stockMeta, cashMeta] = await Promise.all([
    loadCryptoPositionMeta(supabase, userId),
    loadStockPositionMeta(supabase, userId),
    loadCashAccountMeta(supabase, userId),
  ]);

  const activity: ActivityForLot[] = [];

  for (const r of cryptoRows) {
    const meta = cryptoMeta.get(r.entity_id as string);
    if (!meta) continue;
    const before = r.before_snapshot as { quantity?: number } | null;
    const after = r.after_snapshot as { quantity?: number } | null;
    const splitFromId = r.split_from_id as string | null;
    const details = r.details as { split_quantity?: number } | null;
    const qtyOverride =
      splitFromId && details?.split_quantity != null
        ? (r.action === "removed" ? -1 : 1) * Number(details.split_quantity)
        : undefined;
    // Mirror aggregate.ts:135 reclassification: stablecoin crypto_positions
    // contribute to cash_value_* in snapshots, NOT crypto_value_*. Without
    // this, a backdated USDC lot would route to crypto_value_usd in
    // synthesized rows, so pre-snapshot dates would show the value in the
    // wrong bucket. Total is correct; per-class breakdown is the part that
    // breaks. asset_kind stays "crypto" (historical_prices keys stablecoins
    // by coingecko_id).
    const isStable = isStablecoin(meta.subcategory);
    activity.push({
      entity_id: r.entity_id as string,
      entity_type: "crypto_position",
      action: r.action as string,
      effective_date: (r.effective_date as string | null) ?? null,
      created_at: r.created_at as string,
      before_quantity: (before?.quantity ?? null) as number | null,
      after_quantity: (after?.quantity ?? null) as number | null,
      qty_delta_override: qtyOverride,
      is_adjustment: (r.is_adjustment as boolean) ?? false,
      asset_kind: "crypto",
      asset_key: meta.coingecko_id,
      fetch_symbol: `${meta.ticker.toUpperCase()}-USD`,
      native_currency: "USD",
      asset_class: isStable ? "cash" : "crypto",
    });
  }

  for (const r of stockRows) {
    const meta = stockMeta.get(r.entity_id as string);
    if (!meta || !meta.yahoo_ticker) continue; // kind='manual' has no ticker → skip
    const before = r.before_snapshot as { quantity?: number } | null;
    const after = r.after_snapshot as { quantity?: number } | null;
    const splitFromId = r.split_from_id as string | null;
    const details = r.details as { split_quantity?: number } | null;
    const qtyOverride =
      splitFromId && details?.split_quantity != null
        ? (r.action === "removed" ? -1 : 1) * Number(details.split_quantity)
        : undefined;
    activity.push({
      entity_id: r.entity_id as string,
      entity_type: "stock_position",
      action: r.action as string,
      effective_date: (r.effective_date as string | null) ?? null,
      created_at: r.created_at as string,
      before_quantity: (before?.quantity ?? null) as number | null,
      after_quantity: (after?.quantity ?? null) as number | null,
      qty_delta_override: qtyOverride,
      is_adjustment: (r.is_adjustment as boolean) ?? false,
      asset_kind: "stock",
      asset_key: meta.yahoo_ticker,
      fetch_symbol: meta.yahoo_ticker,
      native_currency: meta.currency ?? "USD",
      asset_class: "stocks",
    });
  }

  for (const r of cashRows) {
    const meta = cashMeta.get(r.entity_id as string);
    if (!meta) continue;
    const before = r.before_snapshot as { balance?: number } | null;
    const after = r.after_snapshot as { balance?: number } | null;
    // Cash uses cashDelta (balance-based), pushed as qty_delta_override so
    // buildHistoricalLots picks it up via the same mechanism as split children.
    const qtyDelta = cashDelta(
      r.action as ActionType,
      before?.balance ?? 0,
      after?.balance ?? 0,
    );
    activity.push({
      entity_id: r.entity_id as string,
      entity_type: "cash_account",
      action: r.action as string,
      effective_date: (r.effective_date as string | null) ?? null,
      created_at: r.created_at as string,
      before_quantity: null,            // unused — cash routes through qty_delta_override
      after_quantity: null,
      qty_delta_override: qtyDelta,
      is_adjustment: (r.is_adjustment as boolean) ?? false,
      asset_kind: "cash",
      asset_key: r.entity_id as string, // synthetic; never stored in historical_prices
      fetch_symbol: "",                 // unused — cash never goes to Yahoo
      native_currency: meta.currency,
      asset_class: "cash",
    });
  }

  const lots = buildHistoricalLots(activity);

  Sentry.addBreadcrumb({
    category: "historical-prices",
    message: "Historical price inputs fetched",
    data: { backdatedLots: lots.length },
    level: lots.length > 0 ? "info" : "debug",
  });

  if (lots.length === 0) return { lots: [], prices: [] };
  const prices = await ensureHistoricalPricesCached(lots);

  // Cash lots have no Yahoo asset-price coverage (face value); they always pass.
  // Crypto/stock lots stay gated by the cache-coverage check.
  const pricedKeys = new Set(prices.map((p) => `${p.asset_kind}:${p.asset_key}`));
  const pricedLots = lots.filter((l) =>
    l.asset_kind === "cash" || pricedKeys.has(`${l.asset_kind}:${l.asset_key}`),
  );
  return { lots: pricedLots, prices };
}

/**
 * position_id → { coingecko_id, ticker, subcategory } for the user's crypto
 * positions. `subcategory` is needed to mirror aggregate.ts:135's stablecoin
 * reclassification — backdated USDC/USDT/etc. lots route to cash_value_* in
 * synthesized snapshots so the per-class breakdown matches the rest of the
 * system.
 *
 * Paginated past the server max_rows cap (1000 by default). A user with >1000
 * crypto positions is improbable but the cost of pagination is trivial and the
 * cost of silent truncation is wrong meta → wrong asset_class routing.
 */
async function loadCryptoPositionMeta(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Map<string, { coingecko_id: string; ticker: string; subcategory: string | null }>> {
  // NOTE: intentionally no .is("deleted_at", null) — a full sell soft-deletes
  // the position row but its activity_log entries remain. We need metadata for
  // ALL positions that ever appeared in the log (including sold ones) so their
  // buy+sell deltas can be replayed. Asset metadata (coingecko_id/ticker) is
  // immutable, so including deleted positions is safe.
  const rows = await fetchAllPaginated<{
    id: string;
    crypto_assets: unknown;
  }>((from, to) =>
    supabase
      .from("crypto_positions")
      .select("id, crypto_assets!inner(coingecko_id, ticker, subcategory, user_id)")
      .eq("crypto_assets.user_id", userId)
      .order("id", { ascending: true })
      .range(from, to),
  ).catch((e: unknown) => {
    throw new Error(
      `Failed to load crypto position meta: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  });
  const map = new Map<string, { coingecko_id: string; ticker: string; subcategory: string | null }>();
  for (const row of rows) {
    const a = pickJoinedRecord<{
      coingecko_id: string;
      ticker: string;
      subcategory: string | null;
    }>(row.crypto_assets);
    if (a) map.set(row.id, {
      coingecko_id: a.coingecko_id,
      ticker: a.ticker,
      subcategory: a.subcategory ?? null,
    });
  }
  return map;
}

/**
 * position_id → { yahoo_ticker, currency } for the user's stock positions.
 * Paginated past the server max_rows cap (1000 by default).
 */
async function loadStockPositionMeta(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Map<string, { yahoo_ticker: string | null; currency: string }>> {
  // NOTE: intentionally no .is("deleted_at", null) — same rationale as
  // loadCryptoPositionMeta: soft-deleted (sold) positions must remain in the
  // meta map so their activity-log history is not silently dropped.
  const rows = await fetchAllPaginated<{
    id: string;
    stock_assets: unknown;
  }>((from, to) =>
    supabase
      .from("stock_positions")
      .select("id, stock_assets!inner(yahoo_ticker, currency, user_id)")
      .eq("stock_assets.user_id", userId)
      .order("id", { ascending: true })
      .range(from, to),
  ).catch((e: unknown) => {
    throw new Error(
      `Failed to load stock position meta: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  });
  const map = new Map<string, { yahoo_ticker: string | null; currency: string }>();
  for (const row of rows) {
    const a = pickJoinedRecord<{ yahoo_ticker: string | null; currency: string }>(
      row.stock_assets,
    );
    if (a)
      map.set(row.id, {
        yahoo_ticker: a.yahoo_ticker,
        currency: a.currency,
      });
  }
  return map;
}

/**
 * cash_account.id → { currency } for the user's cash accounts.
 * Paginated past the server max_rows cap (1000 by default).
 */
async function loadCashAccountMeta(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Map<string, { currency: string }>> {
  // NOTE: intentionally no .is("deleted_at", null) — same rationale as
  // loadCryptoPositionMeta / loadStockPositionMeta: soft-deleted (closed) cash
  // accounts must remain in the meta map so their activity-log history can be
  // replayed via cumulativeAtDate.
  const rows = await fetchAllPaginated<{ id: string; currency: string }>((from, to) =>
    supabase
      .from("cash_accounts")
      .select("id, currency")
      .eq("user_id", userId)
      .order("id", { ascending: true })
      .range(from, to),
  ).catch((e: unknown) => {
    throw new Error(
      `Failed to load cash account meta: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  });
  const map = new Map<string, { currency: string }>();
  for (const row of rows) {
    map.set(row.id, { currency: row.currency });
  }
  return map;
}

/**
 * Synthetic benchmark cash flows for is_adjustment backdated lots — the lots
 * deriveCashFlows excludes. One event per is_adjustment delta, at its
 * effective_date, valued qty_delta × historical_price(date) × usdRate.
 *
 * Valuing at the same historical price Phase 1 puts on the portfolio line makes
 * the S&P-units seed (chart-enrichment.ts) reconcile to ~0 delta. Buys (+qty)
 * are positive (money deployed), sells (−qty) negative (money withdrawn) — the
 * same sign convention as deriveCashFlows.
 *
 * Pure. Non-adjustment deltas are skipped (already present in deriveCashFlows).
 * A delta with no price at-or-before its date is skipped (never fabricated).
 */
export function buildBenchmarkCashFlows(
  lots: HistoricalLot[],
  prices: HistoricalPriceRow[],
): CashFlowEvent[] {
  if (lots.length === 0) return [];
  const priceIndex = buildPriceIndex(prices);
  const fxIndex = priceIndex;
  const events: CashFlowEvent[] = [];

  for (const lot of lots) {
    // Cash lots: balance adjustments aren't market cash flows for the S&P
    // benchmark. Skip explicitly — relying on the absence of a "cash:<id>"
    // entry in priceIndex would be an invisible contract.
    if (lot.asset_kind === "cash") continue;
    const series = priceIndex.get(`${lot.asset_kind}:${lot.asset_key}`);
    if (!series) continue;
    for (const d of lot.deltas) {
      if (d.is_adjustment !== true) continue;
      if (!Number.isFinite(d.qty_delta) || d.qty_delta === 0) continue;

      const priceNative = findPriceAtOrBefore(series, d.effective_date);
      if (priceNative === null || !Number.isFinite(priceNative) || priceNative <= 0) continue;

      const usdRate = usdPerUnit(fxIndex, lot.native_currency, d.effective_date);
      if (usdRate === null || !Number.isFinite(usdRate) || usdRate <= 0) continue;

      const amountUsd = d.qty_delta * priceNative * usdRate;
      if (!Number.isFinite(amountUsd)) continue;

      const usdPerEur = usdPerUnit(fxIndex, "EUR", d.effective_date);
      const amountEur =
        usdPerEur !== null && Number.isFinite(usdPerEur) && usdPerEur > 0
          ? amountUsd / usdPerEur
          : undefined;

      events.push({
        date: d.effective_date,
        amount_usd: amountUsd,
        amount_eur: amountEur,
        asset_class: lot.asset_class,
        // Tag as synthetic so computeDeposits (dashboard-changes.ts) can filter
        // these benchmark-only flows out of deposit-tooltip aggregation. Real
        // is_adjustment rows are excluded from deriveCashFlows by design; their
        // synthetic equivalents (used only to seed the S&P benchmark) must not
        // leak into deposit UI as "Unknown" entries.
        synthetic: true,
      });
    }
  }
  return events;
}
