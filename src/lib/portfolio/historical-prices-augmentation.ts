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
