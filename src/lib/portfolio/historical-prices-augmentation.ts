import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import type { Database } from "@/types/database";
import { createAdminClient } from "@/lib/supabase/admin";
import { positionQtyDelta } from "@/lib/deltas";
import { pickJoinedRecord } from "@/lib/supabase/join-utils";
import {
  fetchYahooDailyHistory,
  fetchFxUsdPivotHistory,
} from "@/lib/prices/historical";
import type { PortfolioSnapshot } from "@/lib/types";

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
export type QtyDelta = { effective_date: string; qty_delta: number };

/**
 * A backdated crypto/stock lot needing historical reconstruction.
 *   - asset_key: storage/lookup key (coingecko_id | yahoo_ticker)
 *   - fetch_symbol: Yahoo symbol used by the fetch layer
 *       (`${ticker}-USD` for crypto, yahoo_ticker for stock)
 *   - native_currency: "USD" for crypto (Yahoo {SYM}-USD is USD-denominated);
 *       the native trading currency for stock
 *   - capture_date: the date the daily cron first included this lot in
 *       snapshots (= date of the position's earliest activity_log entry).
 *       Augment ONLY snapshot dates < capture_date — on/after it the cron
 *       already prices the lot, so augmenting would double-count.
 *   - deltas: quantity changes by effective_date (need not be pre-sorted).
 */
export type HistoricalLot = {
  position_id: string;
  asset_kind: "crypto" | "stock";
  asset_key: string;
  fetch_symbol: string;
  native_currency: string;
  asset_class: "crypto" | "stocks";
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
 * building block of the "$0 before purchase" invariant. Does not assume the
 * input is sorted — only the SET of qualifying deltas matters, not iteration
 * order (float accumulation is deterministic in practice for bounded quantity
 * values). Used for position quantity (Phase 1) and, in future,
 * cash/stablecoin balance.
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

  const prices = priceIndex.get(priceKey(lot.asset_kind, lot.asset_key));
  if (!prices) return null;
  const priceNative = findPriceAtOrBefore(prices, date);
  if (priceNative === null || !Number.isFinite(priceNative) || priceNative <= 0) {
    return null;
  }

  const valueNative = qty * priceNative;
  if (!Number.isFinite(valueNative)) return null;

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
  assetClass: "crypto" | "stocks",
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
  return {
    ...snap,
    stocks_value_usd: (snap.stocks_value_usd ?? 0) + usd,
    stocks_value_eur: (snap.stocks_value_eur ?? 0) + eur,
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

/** One activity-log row joined with its asset metadata, for lot building. */
export type ActivityForLot = {
  entity_id: string;
  entity_type: string; // "crypto_position" | "stock_position"
  action: string;
  effective_date: string | null;
  created_at: string;
  before_quantity: number | null;
  after_quantity: number | null;
  /** Override for split-child rows where before/after snapshots are null. */
  qty_delta_override?: number;
  asset_kind: "crypto" | "stock";
  asset_key: string;       // coingecko_id | yahoo_ticker
  fetch_symbol: string;    // `${ticker}-USD` | yahoo_ticker
  native_currency: string;
  asset_class: "crypto" | "stocks";
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
        r.action as "created" | "updated" | "removed" | "undone",
        r.before_quantity ?? 0,
        r.after_quantity ?? 0,
      );
      if (qtyDelta === 0) continue;
      deltas.push({
        effective_date: r.effective_date ?? day,
        qty_delta: qtyDelta,
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
    if (lot.native_currency !== "USD") currencies.add(lot.native_currency);
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
  const { data: existing } = await admin
    .from("historical_prices")
    .select("asset_kind, asset_key")
    .in("asset_key", relevantKeys)
    .limit(100_000);
  const cachedKeys = new Set(
    (existing ?? []).map((r) => `${r.asset_kind}:${r.asset_key}`),
  );

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
  const { data: rows, error: readErr } = await admin
    .from("historical_prices")
    .select("asset_kind, asset_key, price_date, price, currency")
    .in("asset_key", allKeys);
  if (readErr) {
    console.error("[historical] cache read failed:", readErr.message);
    return [];
  }
  return (rows ?? []).map<HistoricalPriceRow>((r) => ({
    asset_kind: r.asset_kind as HistoricalPriceRow["asset_kind"],
    asset_key: r.asset_key,
    price_date: r.price_date,
    price: Number(r.price),
    currency: r.currency,
  }));
}

/**
 * Gather a user's backdated crypto/stock lots from the activity log + asset
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
  const [cryptoRes, stockRes] = await Promise.all([
    supabase
      .from("activity_log")
      .select(
        "entity_id, action, effective_date, created_at, before_snapshot, after_snapshot, details, split_from_id",
      )
      .eq("user_id", userId)
      .eq("entity_type", "crypto_position")
      .is("undone_at", null)
      .order("created_at", { ascending: true }),
    supabase
      .from("activity_log")
      .select(
        "entity_id, action, effective_date, created_at, before_snapshot, after_snapshot, details, split_from_id",
      )
      .eq("user_id", userId)
      .eq("entity_type", "stock_position")
      .is("undone_at", null)
      .order("created_at", { ascending: true }),
  ]);
  if (cryptoRes.error) {
    throw new Error(`Failed to load crypto activity: ${cryptoRes.error.message}`);
  }
  if (stockRes.error) {
    throw new Error(`Failed to load stock activity: ${stockRes.error.message}`);
  }

  const cryptoMeta = await loadCryptoPositionMeta(supabase, userId);
  const stockMeta = await loadStockPositionMeta(supabase, userId);

  const activity: ActivityForLot[] = [];

  for (const r of cryptoRes.data ?? []) {
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
    activity.push({
      entity_id: r.entity_id as string,
      entity_type: "crypto_position",
      action: r.action as string,
      effective_date: (r.effective_date as string | null) ?? null,
      created_at: r.created_at as string,
      before_quantity: (before?.quantity ?? null) as number | null,
      after_quantity: (after?.quantity ?? null) as number | null,
      qty_delta_override: qtyOverride,
      asset_kind: "crypto",
      asset_key: meta.coingecko_id,
      fetch_symbol: `${meta.ticker.toUpperCase()}-USD`,
      native_currency: "USD",
      asset_class: "crypto",
    });
  }

  for (const r of stockRes.data ?? []) {
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
      asset_kind: "stock",
      asset_key: meta.yahoo_ticker,
      fetch_symbol: meta.yahoo_ticker,
      native_currency: meta.currency ?? "USD",
      asset_class: "stocks",
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

  const pricedKeys = new Set(prices.map((p) => `${p.asset_kind}:${p.asset_key}`));
  const pricedLots = lots.filter((l) =>
    pricedKeys.has(`${l.asset_kind}:${l.asset_key}`),
  );
  return { lots: pricedLots, prices };
}

/** position_id → { coingecko_id, ticker } for the user's crypto positions. */
async function loadCryptoPositionMeta(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Map<string, { coingecko_id: string; ticker: string }>> {
  const { data, error } = await supabase
    .from("crypto_positions")
    .select("id, crypto_assets!inner(coingecko_id, ticker, user_id)")
    .eq("crypto_assets.user_id", userId);
  // NOTE: intentionally no .is("deleted_at", null) — a full sell soft-deletes
  // the position row but its activity_log entries remain. We need metadata for
  // ALL positions that ever appeared in the log (including sold ones) so their
  // buy+sell deltas can be replayed. Asset metadata (coingecko_id/ticker) is
  // immutable, so including deleted positions is safe.
  if (error) {
    throw new Error(`Failed to load crypto position meta: ${error.message}`);
  }
  const map = new Map<string, { coingecko_id: string; ticker: string }>();
  for (const row of data ?? []) {
    const a = pickJoinedRecord<{ coingecko_id: string; ticker: string }>(
      row.crypto_assets,
    );
    if (a) map.set(row.id, { coingecko_id: a.coingecko_id, ticker: a.ticker });
  }
  return map;
}

/** position_id → { yahoo_ticker, currency } for the user's stock positions. */
async function loadStockPositionMeta(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Map<string, { yahoo_ticker: string | null; currency: string }>> {
  const { data, error } = await supabase
    .from("stock_positions")
    .select("id, stock_assets!inner(yahoo_ticker, currency, user_id)")
    .eq("stock_assets.user_id", userId);
  // NOTE: intentionally no .is("deleted_at", null) — same rationale as
  // loadCryptoPositionMeta: soft-deleted (sold) positions must remain in the
  // meta map so their activity-log history is not silently dropped.
  if (error) {
    throw new Error(`Failed to load stock position meta: ${error.message}`);
  }
  const map = new Map<string, { yahoo_ticker: string | null; currency: string }>();
  for (const row of data ?? []) {
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
