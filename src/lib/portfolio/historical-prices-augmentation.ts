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
