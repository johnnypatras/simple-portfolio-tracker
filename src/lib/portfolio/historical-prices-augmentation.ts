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
import {
  buildStream,
  foldCostStep,
  type CostBasisTxn,
  type CostFoldState,
} from "@/lib/portfolio/cost-basis";
import { quantityDelta, type TransactionRow } from "@/lib/transaction-kind";
import { splitSignWithLegacyFallback } from "@/lib/split-helpers";
import {
  getAllAssetTransactions,
  type AssetKey,
  type AssetTransactionRow,
} from "@/lib/portfolio/asset-transactions";
import type {
  ActionType,
  AssetClass,
  EntityType,
  PortfolioSnapshot,
  CashFlowEvent,
} from "@/lib/types";

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
  asset_class: AssetClass;
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

/**
 * Add a USD+EUR contribution to the right asset-class columns + totals,
 * MUTATING `snap` in place (no spread). Arithmetic is identical to the prior
 * immutable spread version — `(snap.x ?? 0) + delta` per touched column.
 *
 * Caller contract: `snap` MUST be a freshly-allocated, caller-owned object
 * (synthesizeRow's fresh row, or a lazy `{ ...inputSnap }` clone in the augment
 * loop). Never pass a snapshot that originates from a shared/input array
 * without cloning first — this function does not copy.
 *
 * The asset-class dispatch is exhaustive: adding a new AssetClass member without
 * a matching branch fails to compile (the `never` assignment in the else).
 */
function addContributionInPlace(
  snap: PortfolioSnapshot,
  assetClass: AssetClass,
  usd: number,
  eur: number,
): void {
  if (assetClass === "crypto") {
    snap.crypto_value_usd = (snap.crypto_value_usd ?? 0) + usd;
    snap.crypto_value_eur = (snap.crypto_value_eur ?? 0) + eur;
  } else if (assetClass === "stocks") {
    snap.stocks_value_usd = (snap.stocks_value_usd ?? 0) + usd;
    snap.stocks_value_eur = (snap.stocks_value_eur ?? 0) + eur;
  } else if (assetClass === "cash") {
    snap.cash_value_usd = (snap.cash_value_usd ?? 0) + usd;
    snap.cash_value_eur = (snap.cash_value_eur ?? 0) + eur;
  } else {
    const _exhaustive: never = assetClass;
    throw new Error(`Unhandled asset class: ${String(_exhaustive)}`);
  }
  snap.total_value_usd = (snap.total_value_usd ?? 0) + usd;
  snap.total_value_eur = (snap.total_value_eur ?? 0) + eur;
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
  const row: PortfolioSnapshot = {
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
  // `row` is freshly allocated and owned here — mutate in place (no spread).
  for (const lot of lots) {
    const c = lotContributionAtDate(lot, date, priceIndex, fxIndex);
    if (c === null) continue;
    addContributionInPlace(row, lot.asset_class, c.usd, c.eur);
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
  // `snap` comes from the INPUT array and must NOT be mutated. Clone lazily on
  // the first applied contribution (`{ ...snap }`); snapshots with no
  // contribution return their original reference unchanged (preserves the
  // function's immutability contract toward the caller's input).
  const augmented = snapshots.map((snap) => {
    let row: PortfolioSnapshot | null = null;
    for (const lot of lots) {
      if (snap.snapshot_date >= lot.capture_date) continue; // cron already has it
      const c = lotContributionAtDate(lot, snap.snapshot_date, priceIndex, fxIndex);
      if (c === null) continue;
      if (c.usd === 0 && c.eur === 0) continue; // before effective_date / sold out
      if (row === null) row = { ...snap }; // clone once, only when a contribution applies
      addContributionInPlace(row, lot.asset_class, c.usd, c.eur);
    }
    return row ?? snap;
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
  if (earliestEffective < synthFloor) {
    // A lot's effective_date predates the synthesis floor (~25 years) — a
    // data-integrity smell (e.g. a mistyped year). Signal before clamping so
    // the truncated synthesis range is observable rather than silent. This is
    // the only Sentry side-effect in this otherwise-pure function; it sits at
    // the same wall-clock boundary already documented as an impurity above.
    Sentry.captureMessage("Historical synthesis clamped by MAX_SYNTHESIS_DAYS", {
      level: "warning",
      extra: { earliestEffective, synthFloor, lotsCount: lots.length },
    });
    earliestEffective = synthFloor;
  }

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

/**
 * Max simultaneous upstream price fetches in ensureHistoricalPricesCached.
 * Caps Yahoo + Frankfurter concurrency to respect their rate limits while
 * collapsing what was (N assets + M currencies) sequential 8s-timeout fetches
 * into parallel batches on the dashboard render path.
 */
const FETCH_CONCURRENCY = 5;

/**
 * Run `tasks` with bounded concurrency (`limit` in flight at a time). Uses
 * Promise.allSettled per batch so one fetch failure never aborts the batch —
 * the fetchers already return [] on failure (soft degradation), and the
 * per-task callbacks own their own result handling, so resolution values are
 * intentionally discarded here.
 */
async function runBounded(
  tasks: Array<() => Promise<void>>,
  limit: number,
): Promise<void> {
  for (let i = 0; i < tasks.length; i += limit) {
    await Promise.allSettled(tasks.slice(i, i + limit).map((t) => t()));
  }
}

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
  1000, { label: "historical_prices" }).catch((e: unknown) => {
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
 * `${asset_kind}:${asset_key}` → EARLIEST cached price_date among `candidateKeys`,
 * paging past the max_rows cap. The price-fetch coverage gate: a coarse "is this
 * key cached at all?" check under-detects when an asset was cached for a NARROWER
 * (later-starting) window than a new consumer needs — the deeper `[neededStart…]`
 * range would be skipped, leaving null prices at the deep dates (a silent gap).
 * Tracking the MIN(price_date) per key lets the caller re-fetch only when the
 * needed start precedes what's already cached (audit-r6 MEDIUM). Callers that
 * only need "is this cached?" can read `.has(key)`. Selecting just the three key
 * columns keeps pages dense, but the server still caps row COUNT (one row per
 * date), so paging is required. Rows arrive ordered ascending by
 * (asset_kind, asset_key, price_date), so the FIRST row seen for each key is its
 * earliest date.
 */
export async function readHistoricalCoverageStarts(
  client: SupabaseClient<Database>,
  candidateKeys: string[],
): Promise<Map<string, string>> {
  const starts = new Map<string, string>();
  if (candidateKeys.length === 0) return starts;
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
      `historical_prices coverage-start read failed: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  });
  for (const r of rows) {
    const key = `${r.asset_kind}:${r.asset_key}`;
    // Ascending order guarantees the first row per key is its earliest date.
    if (!starts.has(key)) starts.set(key, r.price_date);
  }
  return starts;
}

/** One activity-log row joined with its asset metadata, for lot building. */
export type ActivityForLot = {
  entity_id: string;
  entity_type: EntityType; // crypto_position | stock_position | cash_account
  action: ActionType;
  effective_date: string | null;
  created_at: string;
  before_quantity: number | null;
  after_quantity: number | null;
  /** Override for split-child rows + cash entries (cash uses balance via cashDelta). */
  qty_delta_override?: number;
  is_adjustment: boolean;
  /** Cost-basis seed (3.4a-pre): user explicitly typed the cashflow amount.
   *  Consumed ONLY to widen extra PRICE coverage (NOT by buildHistoricalLots →
   *  the value line is unaffected). Defaults false for rows that predate cost-basis. */
  cashflow_user_set?: boolean;
  asset_kind: "crypto" | "stock" | "cash";
  asset_key: string;       // coingecko_id | yahoo_ticker | cash_account.id
  fetch_symbol: string;    // `${ticker}-USD` | yahoo_ticker | "" (unused for cash)
  native_currency: string;
  asset_class: AssetClass;
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
        r.action,
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
 * One asset whose PRICE coverage must be ensured WITHOUT it being a value-line
 * lot — the cost-basis seed pre-step (Task 3.4a-pre). User-costed lots
 * (`cashflow_user_set=true`) are usually NON-backdated normal buys, so they are
 * dropped by buildHistoricalLots (not backdated → not a value line lot). The
 * seed still needs each costed asset's market price back to the chart's earliest
 * start to compute `marketAtChartStart`. We thread these as a SEPARATE input so
 * the returned `prices` index widens WITHOUT adding the asset to `lots` — the
 * value line is lot-driven and ignores unreferenced price-index entries, so a
 * costed asset's prices are inert to the truth line (audit-r6 HIGH).
 *
 * Cash is intentionally excluded: cash uses face value (no Yahoo asset price);
 * its native currency's FX series is covered via `coverageCurrencies` instead.
 */
export type PriceCoverageAsset = {
  asset_kind: "crypto" | "stock";
  asset_key: string;
  /** Yahoo symbol (`${TICKER}-USD` for crypto, yahoo_ticker for stock). */
  fetch_symbol: string;
  /** The cache row's stored currency: "USD" for crypto, native for stock. */
  native_currency: string;
};

/**
 * Extra price coverage for the cost-basis seed: assets (+ their native
 * currencies) to cache back to `coverageStart`, independent of the value-line
 * lots. `coverageStart` is the chart's earliest possible start (the All-period
 * start — see fetchHistoricalPriceInputsFor); the fetch is server-side and
 * userId-keyed (no per-period client chartStart), so we cover from the user's
 * earliest relevant date once and the per-period seed lookup slices later.
 */
export type ExtraPriceCoverage = {
  assets: PriceCoverageAsset[];
  /** Foreign (non-USD) native currencies among `assets`, needing an FX series. */
  coverageCurrencies: string[];
  coverageStart: string;
};

/**
 * Ensure the cache holds prices for every lot's asset over [earliestEffective,
 * captureEnd], plus USD-pivot FX for every native currency + EUR. Fetches only
 * series MISSING the needed start (idempotent — re-fetch is harmless thanks to
 * the UNIQUE constraint), upserts via the service-role admin client (the only
 * role allowed to write), and returns ALL relevant cached rows. Network
 * failures degrade gracefully (the lot simply won't be in the returned set →
 * caller treats it as ineligible for augmentation; it contributes $0).
 *
 * `extraPriceCoverage` (Task 3.4a-pre) widens the RETURNED `prices` to cover
 * user-costed assets back to `coverageStart` WITHOUT making them value-line lots
 * (they are not in `lots`). The value line stays lot-driven and unaffected.
 *
 * Range threading (audit-r7 F1): each series fetches an EXPLICIT [start, end]
 * range — value-line assets from `rangeStart`, extra-coverage assets from
 * `coverageStart`, an asset in both from `min(...)`. The coverage gate is
 * per-date (audit-r6 MEDIUM): a series is (re)fetched when it is uncached OR its
 * earliest cached date is LATER than the needed start, so a narrower prior cache
 * no longer hides the deeper range.
 *
 * Cache invariant: exactly one currency per (asset_kind, asset_key) — crypto is
 * USD (Yahoo {SYM}-USD), stock is its native currency, fx is USD-per-unit.
 */
export async function ensureHistoricalPricesCached(
  lots: HistoricalLot[],
  extraPriceCoverage?: ExtraPriceCoverage,
): Promise<HistoricalPriceRow[]> {
  const hasExtra = (extraPriceCoverage?.assets.length ?? 0) > 0;
  // Nothing to do when there are neither value-line lots nor extra coverage.
  if (lots.length === 0 && !hasExtra) return [];
  const admin = createAdminClient();

  // rangeEnd is the common upper bound for every fetch in this call:
  //   • Pure value-line (no extra coverage): max capture_date among lots.
  //   • Extra coverage present: max(lot capture_dates, today) — coverage assets
  //     are usually non-backdated holdings whose relevant tail is the present day,
  //     so the fetch window must reach today even when all lots are in the past.
  //   • Extra-coverage-only (lots empty): today.
  const today = new Date().toISOString().slice(0, 10);
  let rangeEnd = lots.length > 0 ? lots[0].capture_date : today;

  // value-line earliest start (the synthesized/augmented range). Undefined when
  // there are no value-line lots (extra-coverage-only call).
  let rangeStart: string | null = lots.length > 0 ? lots[0].deltas[0].effective_date : null;

  // assetKey -> { kind, symbol, currency, neededStart }. neededStart is the
  // earliest date this series must cover; an asset present as BOTH a value-line
  // lot and extra coverage takes the min.
  const assetSeries = new Map<
    string,
    { kind: "crypto" | "stock"; symbol: string; currency: string; neededStart: string }
  >();
  // currency -> earliest date its FX series must cover. EUR is always required.
  const currencyStarts = new Map<string, string>();

  const minDate = (a: string, b: string): string => (a <= b ? a : b);
  const requireCurrency = (currency: string, start: string): void => {
    if (currency === "USD") return; // pivot — never fetched/stored
    const existing = currencyStarts.get(currency);
    currencyStarts.set(currency, existing ? minDate(existing, start) : start);
  };

  for (const lot of lots) {
    for (const d of lot.deltas) {
      if (rangeStart === null || d.effective_date < rangeStart) rangeStart = d.effective_date;
    }
    if (lot.capture_date > rangeEnd) rangeEnd = lot.capture_date;
  }
  // When extra coverage exists, raise rangeEnd to today so coverage assets
  // (which are non-backdated holdings) get prices through the present day.
  if (hasExtra && rangeEnd < today) rangeEnd = today;
  // The value-line span needs EUR (mirror) + every lot's native currency back to
  // rangeStart. (rangeStart is non-null whenever lots is non-empty.)
  if (rangeStart !== null) {
    requireCurrency("EUR", rangeStart);
    for (const lot of lots) {
      requireCurrency(lot.native_currency, rangeStart);
      // Cash lots: face value — no Yahoo asset fetch — only the FX above.
      if (lot.asset_kind === "cash") continue;
      const key = `${lot.asset_kind}:${lot.asset_key}`;
      const existing = assetSeries.get(key);
      const neededStart = existing ? minDate(existing.neededStart, rangeStart) : rangeStart;
      assetSeries.set(key, {
        kind: lot.asset_kind,
        symbol: lot.fetch_symbol,
        currency: lot.native_currency,
        neededStart,
      });
    }
  }

  // ── Extra (user-costed) coverage: widen back to coverageStart ───────────────
  if (hasExtra) {
    const { assets, coverageCurrencies, coverageStart } = extraPriceCoverage!;
    requireCurrency("EUR", coverageStart); // the seed's EUR mirror needs it too
    for (const cur of coverageCurrencies) requireCurrency(cur, coverageStart);
    for (const a of assets) {
      const key = `${a.asset_kind}:${a.asset_key}`;
      const existing = assetSeries.get(key);
      const neededStart = existing ? minDate(existing.neededStart, coverageStart) : coverageStart;
      assetSeries.set(key, {
        kind: a.asset_kind,
        symbol: a.fetch_symbol,
        currency: a.native_currency,
        neededStart,
      });
    }
  }

  const relevantKeys = [
    ...new Set([
      ...[...assetSeries.keys()].map((k) => k.slice(k.indexOf(":") + 1)),
      ...currencyStarts.keys(),
    ]),
  ];
  // Per-date gate: earliest cached price_date per key. A key absent here is
  // uncached; a key whose earliest date is LATER than the needed start must be
  // re-fetched for the deeper range (defeats the coarse per-asset_key gate).
  const coverageStarts = await readHistoricalCoverageStarts(admin, relevantKeys);
  const needsFetch = (key: string, neededStart: string): boolean => {
    const cachedStart = coverageStarts.get(key);
    return cachedStart === undefined || cachedStart > neededStart;
  };

  const toUpsert: Array<Database["public"]["Tables"]["historical_prices"]["Insert"]> = [];

  // Collect every needed fetch as a task, then run them with bounded
  // concurrency. Pushing to the shared `toUpsert` array from concurrent task
  // callbacks is safe — JS is single-threaded, so the synchronous push runs
  // atomically between awaits.
  const fetchTasks: Array<() => Promise<void>> = [];

  for (const [key, meta] of assetSeries) {
    if (!needsFetch(key, meta.neededStart)) continue;
    const assetKey = key.slice(key.indexOf(":") + 1);
    const start = meta.neededStart;
    fetchTasks.push(async () => {
      const points = await fetchYahooDailyHistory(meta.symbol, start, rangeEnd);
      for (const p of points) {
        toUpsert.push({
          asset_kind: meta.kind,
          asset_key: assetKey,
          price_date: p.date,
          price: p.price,
          currency: meta.currency,
        });
      }
    });
  }

  for (const [cur, start] of currencyStarts) {
    if (!needsFetch(`fx:${cur}`, start)) continue;
    fetchTasks.push(async () => {
      const points = await fetchFxUsdPivotHistory(cur, start, rangeEnd);
      for (const p of points) {
        toUpsert.push({
          asset_kind: "fx",
          asset_key: cur,
          price_date: p.date,
          price: p.price,
          currency: "USD",
        });
      }
    });
  }

  await runBounded(fetchTasks, FETCH_CONCURRENCY);

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
  const allKeys = [...new Set([...assetKeys, ...currencyStarts.keys()])];
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
        "entity_id, action, effective_date, created_at, before_snapshot, after_snapshot, details, split_from_id, is_adjustment, cashflow_user_set",
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
        "entity_id, action, effective_date, created_at, before_snapshot, after_snapshot, details, split_from_id, is_adjustment, cashflow_user_set",
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
        "entity_id, action, effective_date, created_at, before_snapshot, after_snapshot, is_adjustment, cashflow_user_set",
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
    cashflow_user_set: boolean;
  };
  type CashActivityRow = {
    entity_id: string | null;
    action: ActionType;
    effective_date: string | null;
    created_at: string;
    before_snapshot: unknown;
    after_snapshot: unknown;
    is_adjustment: boolean;
    cashflow_user_set: boolean;
  };
  const [cryptoRows, stockRows, cashRows] = await Promise.all([
    fetchAllPaginated<CryptoOrStockActivityRow>(cryptoActivityRange, 1000, { label: "activity:crypto" }).catch((e: unknown) => {
      throw new Error(
        `Failed to load crypto activity: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }),
    fetchAllPaginated<CryptoOrStockActivityRow>(stockActivityRange, 1000, { label: "activity:stock" }).catch((e: unknown) => {
      throw new Error(
        `Failed to load stock activity: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }),
    fetchAllPaginated<CashActivityRow>(cashActivityRange, 1000, { label: "activity:cash" }).catch((e: unknown) => {
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
    if (!r.entity_id) continue;
    const meta = cryptoMeta.get(r.entity_id);
    if (!meta) continue;
    const before = r.before_snapshot as { quantity?: number } | null;
    const after = r.after_snapshot as { quantity?: number } | null;
    const splitFromId = r.split_from_id;
    const details = r.details as { split_quantity?: number; split_direction?: number } | null;
    const qtyOverride =
      splitFromId && details?.split_quantity != null
        ? splitSignWithLegacyFallback(details.split_direction, r.action) * Number(details.split_quantity)
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
      entity_id: r.entity_id,
      entity_type: "crypto_position",
      action: r.action,
      effective_date: r.effective_date,
      created_at: r.created_at,
      before_quantity: before?.quantity ?? null,
      after_quantity: after?.quantity ?? null,
      qty_delta_override: qtyOverride,
      is_adjustment: r.is_adjustment,
      cashflow_user_set: r.cashflow_user_set,
      asset_kind: "crypto",
      asset_key: meta.coingecko_id,
      fetch_symbol: `${meta.ticker.toUpperCase()}-USD`,
      native_currency: "USD",
      asset_class: isStable ? "cash" : "crypto",
    });
  }

  for (const r of stockRows) {
    if (!r.entity_id) continue;
    const meta = stockMeta.get(r.entity_id);
    if (!meta || !meta.yahoo_ticker) continue; // kind='manual' has no ticker → skip
    const before = r.before_snapshot as { quantity?: number } | null;
    const after = r.after_snapshot as { quantity?: number } | null;
    const splitFromId = r.split_from_id;
    const details = r.details as { split_quantity?: number; split_direction?: number } | null;
    const qtyOverride =
      splitFromId && details?.split_quantity != null
        ? splitSignWithLegacyFallback(details.split_direction, r.action) * Number(details.split_quantity)
        : undefined;
    activity.push({
      entity_id: r.entity_id,
      entity_type: "stock_position",
      action: r.action,
      effective_date: r.effective_date,
      created_at: r.created_at,
      before_quantity: before?.quantity ?? null,
      after_quantity: after?.quantity ?? null,
      qty_delta_override: qtyOverride,
      is_adjustment: r.is_adjustment,
      cashflow_user_set: r.cashflow_user_set,
      asset_kind: "stock",
      asset_key: meta.yahoo_ticker,
      fetch_symbol: meta.yahoo_ticker,
      native_currency: meta.currency ?? "USD",
      asset_class: "stocks",
    });
  }

  for (const r of cashRows) {
    if (!r.entity_id) continue;
    const meta = cashMeta.get(r.entity_id);
    if (!meta) continue;
    const before = r.before_snapshot as { balance?: number } | null;
    const after = r.after_snapshot as { balance?: number } | null;
    // Cash uses cashDelta (balance-based), pushed as qty_delta_override so
    // buildHistoricalLots picks it up via the same mechanism as split children.
    const qtyDelta = cashDelta(
      r.action,
      before?.balance ?? 0,
      after?.balance ?? 0,
    );
    activity.push({
      entity_id: r.entity_id,
      entity_type: "cash_account",
      action: r.action,
      effective_date: r.effective_date,
      created_at: r.created_at,
      before_quantity: null,            // unused — cash routes through qty_delta_override
      after_quantity: null,
      qty_delta_override: qtyDelta,
      is_adjustment: r.is_adjustment,
      cashflow_user_set: r.cashflow_user_set,
      asset_kind: "cash",
      asset_key: r.entity_id,           // synthetic; never stored in historical_prices
      fetch_symbol: "",                 // unused — cash never goes to Yahoo
      native_currency: meta.currency,
      asset_class: "cash",
    });
  }

  const lots = buildHistoricalLots(activity);

  // ── Cost-basis seed pre-step (Task 3.4a-pre): widen PRICE coverage ──────────
  // The seed computes `marketAtChartStart` for USER-COSTED lots
  // (cashflow_user_set=true), which are usually NON-backdated normal buys →
  // buildHistoricalLots DROPS them (not backdated) → #94 caches no price for
  // them. We widen the RETURNED `prices` to cover their assets back to the
  // chart's earliest start, WITHOUT adding them to `lots` (the value line stays
  // backdated-only and byte-identical). Cash is excluded — face value, no Yahoo
  // price; its FX is already covered when it is a value-line lot, and the seed
  // values cash at face value too, so no asset-price coverage is needed.
  const coveredAssetKeys = new Set<string>();
  const coverageAssets: PriceCoverageAsset[] = [];
  const coverageCurrencies = new Set<string>();
  for (const a of activity) {
    if (a.cashflow_user_set !== true) continue;
    if (a.asset_kind === "cash") continue; // face value — no asset price needed
    const key = `${a.asset_kind}:${a.asset_key}`;
    if (coveredAssetKeys.has(key)) continue;
    coveredAssetKeys.add(key);
    coverageAssets.push({
      asset_kind: a.asset_kind,
      asset_key: a.asset_key,
      fetch_symbol: a.fetch_symbol,
      native_currency: a.native_currency,
    });
    if (a.native_currency !== "USD") coverageCurrencies.add(a.native_currency);
  }

  // "All-period start": the fetch is server-side and React-cache()-keyed on
  // userId only — there is NO client chartStart here (the per-period seed lookup
  // slices client-side later). So cover from the user's EARLIEST relevant date:
  // the min COALESCE(effective_date, created_at-date) across ALL their activity
  // rows — the earliest x-position any series can occupy on the All-period
  // chart. This is <= the value-line rangeStart (a min over a superset of the
  // backdated effective_dates), so the existing value-line coverage is never
  // narrowed. Floored by MAX_SYNTHESIS_DAYS for the same pathological-input
  // reason synthesis is floored (a mistyped year must not fan out a 25y+ fetch).
  let coverageStart: string | null = null;
  if (coverageAssets.length > 0) {
    for (const a of activity) {
      const day = a.effective_date ?? a.created_at.slice(0, 10);
      if (coverageStart === null || day < coverageStart) coverageStart = day;
    }
    const floor = isoDaysAgo(MAX_SYNTHESIS_DAYS);
    if (coverageStart !== null && coverageStart < floor) coverageStart = floor;
  }

  const extraCoverage: ExtraPriceCoverage | undefined =
    coverageAssets.length > 0 && coverageStart !== null
      ? { assets: coverageAssets, coverageCurrencies: [...coverageCurrencies], coverageStart }
      : undefined;

  Sentry.addBreadcrumb({
    category: "historical-prices",
    message: "Historical price inputs fetched",
    data: { backdatedLots: lots.length, costedCoverageAssets: coverageAssets.length },
    level: lots.length > 0 || coverageAssets.length > 0 ? "info" : "debug",
  });

  // No value-line lots AND no user-costed assets → nothing to fetch/return.
  if (lots.length === 0 && extraCoverage === undefined) return { lots: [], prices: [] };

  const prices = await ensureHistoricalPricesCached(lots, extraCoverage);

  // Cash lots have no Yahoo asset-price coverage (face value); they always pass.
  // Crypto/stock lots stay gated by the cache-coverage check. NOTE: this filters
  // ONLY the value-line `lots` (backdated) — the widened user-costed coverage
  // lives in `prices`, never in `lots`, so the value line is unchanged.
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

// ─────────────────────────────────────────────────────────────────────────────
// Cost-basis series (Task 3.4a) — per-class running COST + market-minus-cost GAP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One point on the portfolio-wide per-class cost-basis series.
 *
 * COST columns = running cost basis per class at `date` (the avg-cost engine's
 * `cost` accumulator). GAP columns = market-minus-cost for USER-COSTED lots only
 * (`cashflow_user_set=true AND NOT is_yield`). USD gaps power the chart-enrichment
 * seed; EUR gaps are reserved for the Phase-5 overlay (audit-r5 F1 — emitted now
 * so the seam never needs a shape migration).
 */
export interface CostBasisSeriesPoint {
  date: string; // YYYY-MM-DD
  cryptoCostUsd: number;
  stocksCostUsd: number;
  cashCostUsd: number;
  cryptoCostEur: number;
  stocksCostEur: number;
  cashCostEur: number;
  cryptoGapUsd: number;
  stocksGapUsd: number;
  cashGapUsd: number;
  cryptoGapEur: number;
  stocksGapEur: number;
  cashGapEur: number;
}

/**
 * One transaction in an asset's stream, paired with the per-row `cashflow_user_set`
 * flag the engine's `CostBasisTxn` does not carry (it drives the GAP gate, not the
 * cost arithmetic). The txn itself feeds `buildStream`/`foldCostStep` unchanged.
 */
export interface CostBasisSeriesTxn {
  txn: CostBasisTxn;
  /** True when the user explicitly typed the cashflow amount (GAP gate). */
  cashflow_user_set: boolean;
}

/**
 * One portfolio asset's full input to the cost-basis series.
 *
 *   - txns:           the asset's COMPLETE transaction stream, sorted ascending by
 *                     COALESCE(effective_date, created_at) (the caller's job —
 *                     identical ordering to getAssetTransactions). Each entry is
 *                     dated by `date` (the COALESCE'd day) so the running cost can
 *                     be emitted onto the daily spine.
 *   - asset_kind / asset_key / native_currency: identify the price series for
 *                     market valuation (stablecoins keep asset_kind "crypto" +
 *                     coingecko_id key — the price cache stores them by coingecko_id).
 *                     Cash uses face value (no price lookup).
 *   - asset_class:    destination columns. ALREADY stablecoin-reclassified to "cash"
 *                     by the caller (mirrors the value line ~aggregate.ts:135).
 *
 * `date` per txn is carried separately from the `CostBasisTxn` (which is date-free)
 * so the engine input shape is untouched.
 */
export interface CostBasisSeriesAsset {
  asset_kind: "crypto" | "stock" | "cash";
  asset_key: string;
  native_currency: string;
  asset_class: AssetClass;
  txns: Array<CostBasisSeriesTxn & { date: string }>;
}

/** Full input to {@link buildCostBasisSeries}. */
export interface CostBasisSeriesInput {
  assets: CostBasisSeriesAsset[];
  /** Cached historical prices + USD-pivot FX (same rows the value line uses). */
  prices: HistoricalPriceRow[];
  /** The daily date spine (ascending YYYY-MM-DD) — match the augmentation spine. */
  dates: string[];
  /** Optional sink fired once per (lot, date) the GAP could not price (visibility). */
  onAnomaly?: (msg: string) => void;
}

/** Result: the series + the count of (user-costed lot × date) pairs the GAP could
 * not price (a market value was unavailable, so that pair contributed 0). Never
 * silently wrong — a non-zero count means the seed under-covers somewhere. */
export interface CostBasisSeriesResult {
  series: CostBasisSeriesPoint[];
  uncoveredGapLots: number;
}

/** Add `usd`/`eur` to the COST columns of `p` for `assetClass`. */
function addCost(p: CostBasisSeriesPoint, assetClass: AssetClass, usd: number, eur: number): void {
  if (assetClass === "crypto") {
    p.cryptoCostUsd += usd;
    p.cryptoCostEur += eur;
  } else if (assetClass === "stocks") {
    p.stocksCostUsd += usd;
    p.stocksCostEur += eur;
  } else if (assetClass === "cash") {
    p.cashCostUsd += usd;
    p.cashCostEur += eur;
  } else {
    const _exhaustive: never = assetClass;
    throw new Error(`Unhandled asset class: ${String(_exhaustive)}`);
  }
}

/** Add `usd`/`eur` to the GAP columns of `p` for `assetClass`. */
function addGap(p: CostBasisSeriesPoint, assetClass: AssetClass, usd: number, eur: number): void {
  if (assetClass === "crypto") {
    p.cryptoGapUsd += usd;
    p.cryptoGapEur += eur;
  } else if (assetClass === "stocks") {
    p.stocksGapUsd += usd;
    p.stocksGapEur += eur;
  } else if (assetClass === "cash") {
    p.cashGapUsd += usd;
    p.cashGapEur += eur;
  } else {
    const _exhaustive: never = assetClass;
    throw new Error(`Unhandled asset class: ${String(_exhaustive)}`);
  }
}

/** A fresh all-zero series point for `date`. */
function emptyPoint(date: string): CostBasisSeriesPoint {
  return {
    date,
    cryptoCostUsd: 0, stocksCostUsd: 0, cashCostUsd: 0,
    cryptoCostEur: 0, stocksCostEur: 0, cashCostEur: 0,
    cryptoGapUsd: 0, stocksGapUsd: 0, cashGapUsd: 0,
    cryptoGapEur: 0, stocksGapEur: 0, cashGapEur: 0,
  };
}

/**
 * Running cost basis (the engine's `cost` accumulator) for `txns` over EVERY day
 * in `dates`, per currency. Reuses the VERIFIED engine verbatim — `buildStream`
 * (transfer netting + C3 value resolution) then `foldCostStep` — over the prefix
 * of txns with `date <= D`. The prefix-per-distinct-date fold is the explicitly
 * sanctioned reuse (faithful: identical netting/arithmetic to the headline P&L);
 * O(distinctDates × txns) is trivial for portfolio-scale streams (<5k rows).
 *
 * Returns a Map<spineDate, cost> for each currency. A day before the first txn
 * folds an empty prefix → cost 0 (the "$0 before purchase" invariant).
 */
function runningCostByDate(
  txnsWithDate: Array<{ txn: CostBasisTxn; date: string }>,
  dates: string[],
  currency: "usd" | "eur",
  onAnomaly?: (msg: string) => void,
): Map<string, number> {
  const out = new Map<string, number>();
  if (txnsWithDate.length === 0) {
    for (const d of dates) out.set(d, 0);
    return out;
  }
  // buildStream nets transfer groups ACROSS the whole stream, so a transfer leg's
  // cost effect can't be folded incrementally leg-by-leg without re-netting.
  // Instead: walk the date-sorted spine, advancing a cursor over the date-sorted
  // txns; whenever the prefix [..<=D] grows, re-net + re-fold that prefix via the
  // VERIFIED engine (buildStream + foldCostStep, verbatim — never re-deriving the
  // cost arithmetic) and cache its cost for every spine day until the prefix grows
  // again. The fold runs at most once per distinct txn date, so the whole pass is
  // O(dates + txns × prefix) — trivial for portfolio-scale streams.
  const sortedTxns = [...txnsWithDate].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const sortedDates = [...dates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let cursor = 0;
  let foldedThrough = -1;
  let cachedCost = 0;
  for (const d of sortedDates) {
    while (cursor < sortedTxns.length && sortedTxns[cursor].date <= d) cursor++;
    if (cursor !== foldedThrough) {
      const prefix = sortedTxns.slice(0, cursor).map((t) => t.txn);
      const stream = buildStream(prefix, currency);
      const state: CostFoldState = { units: 0, cost: 0, realized: 0 };
      for (const entry of stream) foldCostStep(state, entry, onAnomaly);
      cachedCost = state.cost;
      foldedThrough = cursor;
    }
    out.set(d, cachedCost);
  }
  return out;
}

/**
 * Build a synthetic {@link HistoricalLot} from a subset of an asset's txns, so
 * {@link lotContributionAtDate} can market-value exactly that quantity over time.
 * Quantity per txn = `quantityDelta` (entity-aware), dated by the carried `date`.
 * Used for BOTH the adjustment-cost contribution and the GAP's user-costed sub-lot.
 */
function syntheticLot(
  asset: CostBasisSeriesAsset,
  subset: Array<CostBasisSeriesTxn & { date: string }>,
): HistoricalLot {
  const deltas: QtyDelta[] = [];
  for (const t of subset) {
    const qd = quantityDelta(toClassifierRow(t.txn));
    if (qd === 0) continue;
    deltas.push({ effective_date: t.date, qty_delta: qd });
  }
  return {
    position_id: `cb-series:${asset.asset_kind}:${asset.asset_key}`,
    asset_kind: asset.asset_kind,
    asset_key: asset.asset_key,
    fetch_symbol: "", // unused at read time (only price lookups, keyed by asset_key)
    native_currency: asset.native_currency,
    asset_class: asset.asset_class,
    capture_date: "9999-12-31", // unused by lotContributionAtDate
    deltas,
  };
}

/** Adapt a CostBasisTxn to the quantityDelta classifier-row shape (Json → object). */
function toClassifierRow(txn: CostBasisTxn): TransactionRow {
  const asObj = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  return {
    entity_type: txn.entity_type,
    action: txn.action,
    is_yield: txn.is_yield,
    is_adjustment: txn.is_adjustment,
    transfer_group_id: txn.transfer_group_id,
    split_from_id: txn.split_from_id,
    before_snapshot: asObj(txn.before_snapshot),
    after_snapshot: asObj(txn.after_snapshot),
    details: asObj(txn.details),
  };
}

/**
 * Portfolio-wide, per-class running cost-basis + market-minus-cost gap series
 * over the daily `dates` spine (Task 3.4a). PURE — no DB, no Sentry, no wall
 * clock; every input is injected.
 *
 * Per asset, at each date D (cumulative over txns with date <= D):
 *   COST  = running cost basis per the avg-cost engine. REAL flows + YIELD + TRANSFER
 *           LEGS are FOLDED through the engine (buildStream nets transfer groups, then
 *           foldCostStep): buys add cost, sells/transfers-OUT release at avg cost,
 *           transfers-IN add the moved value, yield adds 0. ONLY a BARE correction
 *           (`is_adjustment` AND NO `transfer_group_id`) is MARKET-valued at D
 *           (lotContributionAtDate) — a bare correction is a balance restatement with
 *           no cost economics, so market-at-date avoids fabricating gains on a restated
 *           balance. TRANSFER legs are NOT market-valued: they fold like sells so the
 *           cost line moves uniformly with a sale (product decision 2026-06-04 —
 *           overlay uniformity with sells; a crypto→cash transfer-OUT must release the
 *           crypto cost, not leave it flat). The fold is faithful to the headline P&L:
 *           buildStream nets wallet↔wallet moves to a no-op and resolves the C3 value
 *           source (|delta_{cur}|) for cross-asset legs.
 *   GAP   = Σ over user-costed (cashflow_user_set=true AND NOT is_yield) lots of
 *           (market value at D − running user cost at D). A lot with no cached
 *           price at D contributes 0 AND increments `uncoveredGapLots` (visibility).
 *           The gap gate is independent of the cost partition above — transfer legs are
 *           cashflow_user_set=false, so they never enter the gap (the seed is untouched).
 *
 * Stablecoin reclass is the caller's responsibility (asset_class already "cash").
 */
export function buildCostBasisSeries(input: CostBasisSeriesInput): CostBasisSeriesResult {
  const { assets, prices, dates, onAnomaly } = input;
  const series = dates.map(emptyPoint);
  const byDate = new Map<string, CostBasisSeriesPoint>();
  for (const p of series) byDate.set(p.date, p);

  const priceIndex = buildPriceIndex(prices);
  const fxIndex = priceIndex; // fx rows share the index under "fx:<cur>"
  let uncoveredGapLots = 0;

  for (const asset of assets) {
    if (asset.txns.length === 0) continue;
    const cls = asset.asset_class;

    // ── COST: folded stream (real flows + yield + TRANSFER legs) + bare-correction
    //    market value. Scope bound (product decision 2026-06-04 — uniform with sells):
    //    a BARE correction (is_adjustment AND NO transfer_group_id) has no cost
    //    economics → market-valued at D (avoids fictional gains on a restated balance).
    //    EVERYTHING ELSE — real buys/sells, yield, AND transfer legs — folds through the
    //    VERIFIED engine (buildStream nets transfer groups + resolves the C3 value
    //    source; foldCostStep releases avg cost on a transfer-OUT exactly like a sell).
    const isBareCorrection = (t: CostBasisSeriesTxn & { date: string }): boolean =>
      t.txn.is_adjustment === true && t.txn.transfer_group_id == null;
    const folded = asset.txns.filter((t) => !isBareCorrection(t));
    const bareCorrections = asset.txns.filter(isBareCorrection);

    if (folded.length > 0) {
      const costUsd = runningCostByDate(folded, dates, "usd", onAnomaly);
      const costEur = runningCostByDate(folded, dates, "eur", onAnomaly);
      for (const d of dates) {
        const usd = costUsd.get(d) ?? 0;
        const eur = costEur.get(d) ?? 0;
        if (usd !== 0 || eur !== 0) addCost(byDate.get(d)!, cls, usd, eur);
      }
    }

    if (bareCorrections.length > 0) {
      // Bare corrections are market-valued (no cost economics — restated balance).
      const adjLot = syntheticLot(asset, bareCorrections);
      for (const d of dates) {
        const c = lotContributionAtDate(adjLot, d, priceIndex, fxIndex);
        if (c === null) continue; // no price → contributes 0 (cost is never fabricated)
        if (c.usd === 0 && c.eur === 0) continue;
        addCost(byDate.get(d)!, cls, c.usd, c.eur);
      }
    }

    // ── GAP: user-costed (NOT yield) lots — market value minus running user cost ──
    const costed = asset.txns.filter(
      (t) => t.cashflow_user_set === true && t.txn.is_yield !== true,
    );
    if (costed.length > 0) {
      const costedLot = syntheticLot(asset, costed);
      const userCostUsd = runningCostByDate(costed, dates, "usd", onAnomaly);
      const userCostEur = runningCostByDate(costed, dates, "eur", onAnomaly);
      for (const d of dates) {
        const market = lotContributionAtDate(costedLot, d, priceIndex, fxIndex);
        const uCostUsd = userCostUsd.get(d) ?? 0;
        const uCostEur = userCostEur.get(d) ?? 0;
        if (market === null) {
          // Only an UNCOVERED lot is one that SHOULD have a value: it holds a
          // non-zero quantity at D (qty 0 → no gap, no anomaly). cumulativeAtDate
          // over the costed deltas tells us if the lot is live at D.
          if (cumulativeAtDate(costedLot.deltas, d) > 0) {
            uncoveredGapLots++;
            onAnomaly?.(
              `cost-basis gap uncovered: ${asset.asset_kind}:${asset.asset_key} has no market price at ${d}`,
            );
          }
          continue; // no market price → 0 gap contribution
        }
        const gapUsd = market.usd - uCostUsd;
        const gapEur = market.eur - uCostEur;
        if (gapUsd !== 0 || gapEur !== 0) addGap(byDate.get(d)!, cls, gapUsd, gapEur);
      }
    }
  }

  return { series, uncoveredGapLots };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost-basis series I/O (Task 3.4b) — read + map to buildCostBasisSeries input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * crypto_asset.id → { coingecko_id, subcategory } for every crypto asset owned
 * by `userId`. ASSET-id keyed (not position-id), to match getAllAssetTransactions'
 * `crypto:{assetId}` grouping. `subcategory` drives the stablecoin → cash reclass
 * (same rule the value line uses). Paginated past the max_rows cap.
 */
async function loadCryptoAssetMeta(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Map<string, { coingecko_id: string; subcategory: string | null }>> {
  const rows = await fetchAllPaginated<{
    id: string;
    coingecko_id: string;
    subcategory: string | null;
  }>((from, to) =>
    supabase
      .from("crypto_assets")
      .select("id, coingecko_id, subcategory")
      .eq("user_id", userId)
      .order("id", { ascending: true })
      .range(from, to),
  ).catch((e: unknown) => {
    throw new Error(
      `Failed to load crypto asset meta (cost-basis series): ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  });
  const map = new Map<string, { coingecko_id: string; subcategory: string | null }>();
  for (const r of rows) map.set(r.id, { coingecko_id: r.coingecko_id, subcategory: r.subcategory ?? null });
  return map;
}

/**
 * stock_asset.id → { yahoo_ticker, currency } for every stock asset owned by
 * `userId`. ASSET-id keyed. A manual-NAV asset (`yahoo_ticker` null) yields no
 * price series — its cost still folds, but market valuation (adjustment cost +
 * gap) can't price it, so those contribute 0 (the same honest no-fabrication the
 * value line applies). Paginated past the max_rows cap.
 */
async function loadStockAssetMeta(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Map<string, { yahoo_ticker: string | null; currency: string }>> {
  const rows = await fetchAllPaginated<{
    id: string;
    yahoo_ticker: string | null;
    currency: string;
  }>((from, to) =>
    supabase
      .from("stock_assets")
      .select("id, yahoo_ticker, currency")
      .eq("user_id", userId)
      .order("id", { ascending: true })
      .range(from, to),
  ).catch((e: unknown) => {
    throw new Error(
      `Failed to load stock asset meta (cost-basis series): ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  });
  const map = new Map<string, { yahoo_ticker: string | null; currency: string }>();
  for (const r of rows) map.set(r.id, { yahoo_ticker: r.yahoo_ticker, currency: r.currency });
  return map;
}

/** cash_account.id → currency for every cash account owned by `userId`. */
async function loadCashAccountCurrency(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Map<string, string>> {
  const rows = await fetchAllPaginated<{ id: string; currency: string }>((from, to) =>
    supabase
      .from("cash_accounts")
      .select("id, currency")
      .eq("user_id", userId)
      .order("id", { ascending: true })
      .range(from, to),
  ).catch((e: unknown) => {
    throw new Error(
      `Failed to load cash account currency (cost-basis series): ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  });
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.id, r.currency);
  return map;
}

/** The COALESCE(effective_date, created_at-date) day for a row. */
function rowDate(row: AssetTransactionRow): string {
  return row.effective_date ?? row.created_at.slice(0, 10);
}

/** Map one AssetTransactionRow → the series txn shape (CostBasisTxn + flags + date). */
function toSeriesTxn(row: AssetTransactionRow): CostBasisSeriesTxn & { date: string } {
  return {
    txn: {
      entity_type: row.entity_type,
      action: row.action,
      is_yield: row.is_yield,
      is_adjustment: row.is_adjustment,
      transfer_group_id: row.transfer_group_id,
      split_from_id: row.split_from_id,
      cashflow_amount_usd: row.cashflow_amount_usd,
      cashflow_amount_eur: row.cashflow_amount_eur,
      delta_usd: row.delta_usd,
      delta_eur: row.delta_eur,
      before_snapshot: row.before_snapshot,
      after_snapshot: row.after_snapshot,
      details: row.details,
    },
    date: rowDate(row),
    cashflow_user_set: row.cashflow_user_set === true,
  };
}

/**
 * Build the per-asset {@link CostBasisSeriesAsset} list for `userId` — the bulk
 * grouped activity stream ({@link getAllAssetTransactions}, reused verbatim so the
 * series sees byte-identical streams to the headline P&L) joined with asset-id-keyed
 * metadata (price key + native currency + stablecoin-reclassified class).
 *
 * Dual-client contract identical to getAllAssetTransactions: RLS-scoped server
 * client + auth.uid() (owner) or service-role admin + owner_id (share/comparison).
 *
 * Skips a group whose asset metadata is missing (a hard-deleted asset, or the
 * cross-user scoping bug guard) — it cannot be priced or classified, so it is left
 * out rather than mis-bucketed.
 */
export async function fetchCostBasisSeriesAssets(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<CostBasisSeriesAsset[]> {
  const [byAsset, cryptoMeta, stockMeta, cashCur] = await Promise.all([
    getAllAssetTransactions(supabase, userId),
    loadCryptoAssetMeta(supabase, userId),
    loadStockAssetMeta(supabase, userId),
    loadCashAccountCurrency(supabase, userId),
  ]);

  const assets: CostBasisSeriesAsset[] = [];
  for (const [key, rows] of byAsset) {
    if (rows.length === 0) continue;
    const txns = rows.map(toSeriesTxn);
    const { kind, id } = parseAssetKey(key);

    if (kind === "crypto") {
      const meta = cryptoMeta.get(id);
      if (!meta) continue; // unknown asset → can't price/classify; skip (never mis-bucket)
      const isStable = isStablecoin(meta.subcategory);
      assets.push({
        asset_kind: "crypto",
        asset_key: meta.coingecko_id,
        native_currency: "USD",
        asset_class: isStable ? "cash" : "crypto",
        txns,
      });
    } else if (kind === "stock") {
      const meta = stockMeta.get(id);
      if (!meta) continue;
      assets.push({
        asset_kind: "stock",
        // Manual-NAV (null ticker): keep a synthetic non-matching key so cost still
        // folds; market lookups simply miss (contribute 0 — honest no-fabrication).
        asset_key: meta.yahoo_ticker ?? `__manual__:${id}`,
        native_currency: meta.currency || "USD",
        asset_class: "stocks",
        txns,
      });
    } else {
      // cash: the AssetKey id IS the account id; face value (no price lookup).
      const currency = cashCur.get(id);
      if (!currency) continue;
      assets.push({
        asset_kind: "cash",
        asset_key: id,
        native_currency: currency,
        asset_class: "cash",
        txns,
      });
    }
  }
  return assets;
}

/** Parse an {@link AssetKey} (`crypto:{id}` | `stock:{id}` | `cash:{id}`). */
function parseAssetKey(key: AssetKey): { kind: "crypto" | "stock" | "cash"; id: string } {
  const i = key.indexOf(":");
  return { kind: key.slice(0, i) as "crypto" | "stock" | "cash", id: key.slice(i + 1) };
}

/**
 * The daily date spine for the cost-basis series: every day from the earliest
 * transaction date across all assets to `today` inclusive (ascending YYYY-MM-DD).
 * Matches the augmentation's daily granularity. Floored by MAX_SYNTHESIS_DAYS so a
 * mistyped-year effective_date can't fan out a 25-year+ spine (same guard as
 * synthesis). Returns [] when there are no transactions.
 */
export function buildCostBasisDateSpine(assets: CostBasisSeriesAsset[], today: string): string[] {
  let earliest: string | null = null;
  for (const a of assets) {
    for (const t of a.txns) {
      if (earliest === null || t.date < earliest) earliest = t.date;
    }
  }
  if (earliest === null) return [];
  const floor = isoDaysAgo(MAX_SYNTHESIS_DAYS);
  if (earliest < floor) earliest = floor;
  if (earliest > today) return []; // all activity in the future (shouldn't happen)
  return [...eachDay(earliest, today)];
}
