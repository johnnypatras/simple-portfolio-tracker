/**
 * Average-cost engine — pure, price-free, unit-tested (spec §6).
 *
 * Computes per-asset cost basis, realized/unrealized P&L and average cost from an
 * asset's full transaction stream (the `getAssetTransactions` rows, merged across
 * every wallet that holds the asset). No DB, no async, no `"use server"`, no Sentry
 * import — the read-time caller injects an optional `onAnomaly` sink (H4).
 *
 * ── Quantity ──────────────────────────────────────────────────────────────────
 * EVERY quantity comes from `quantityDelta` (entity-aware: cash uses balance/amount
 * fields, split children use `split_direction × split_quantity`). NEVER read
 * `snapshot.quantity` directly — a naive read returns 0 for cash and mis-signs split
 * children. Direction ALWAYS comes from `quantityDelta`, NEVER from a delta/value
 * sign.
 *
 * ── Per-transaction value source (C3 — the single most missable bug) ───────────
 * A real flow (buy/sell/deposit/withdrawal) carries its amount in
 * `cashflow_amount_{cur}`; a transfer/adjustment leg carries it in `delta_{cur}`
 * (`cashflow_amount_*` is NULL on `is_adjustment` rows). Resolve per currency:
 *   rawValue = is_adjustment ? |delta_{cur}| : |cashflow_amount_{cur}|   (null → 0)
 * Reading `|cashflow_amount|` on a transfer leg would yield 0 → every crypto→cash
 * transfer would book a spurious realized loss = full cost basis.
 *
 * ── Pre-step: net transfer legs by `transfer_group_id` within the asset's stream ─
 *   - |net qty| < EPS (wallet↔wallet move, both legs present) → SKIP the group
 *     (cost-neutral; no cost event).
 *   - Exactly ONE leg in this stream (cross-asset transfer, e.g. crypto→cash) → that
 *     leg passes through as a normal disposal/acquisition valued at |delta_{cur}|.
 *   - Multiple legs, small non-zero net (same-asset FEE remainder) → ONE synthetic
 *     entry of the net magnitude at value 0 (B5: a fee books a realized LOSS = avg×out,
 *     never a spurious gain). A positive same-asset net (physically odd) → an
 *     acquisition at value 0 (conservative — adds no cost). Placed at the FIRST leg's
 *     stream position.
 *   - Non-transfer rows pass through with their resolved `rawValue`.
 *
 * ── Off-book corrections (H3 carve-out) ────────────────────────────────────────
 * A bare `is_adjustment` row (no transfer_group, not yield) is a balance restatement:
 * it moves `units` with NO matching Σcost/Σproceeds entry. balance-UP adds units at
 * zero cost; balance-DOWN removes cost basis (avg×out) but books NO realized. The
 * method-independent identity `totalPnL === currentMarketValue + Σproceeds − Σcost`
 * holds over buy/sell/yield ONLY and deliberately does NOT hold across a correction.
 *
 * ── Multi-currency ─────────────────────────────────────────────────────────────
 * Runs independently per display currency (`opts.currency`, default "eur"). Each pass
 * uses that currency's stored amounts and is internally consistent; the two results
 * legitimately differ by FX timing and are never cross-reconciled. EUR (base currency)
 * is authoritative for the headline P&L.
 */

/** Float tolerance — snap units/cost to 0 after a disposal that lands within EPS, so
 * cent-rounded NUMERIC(18,2) inputs don't accumulate drift and a re-buy restarts
 * cleanly from 0/0. */
const EPS = 1e-9;

import { quantityDelta, asSnapshot, type TransactionRow } from "@/lib/transaction-kind";

/**
 * Structural subset of `AssetTransactionRow` (asset-transactions.ts) the engine
 * consumes — so `getAssetTransactions` rows feed it directly.
 */
export interface CostBasisTxn {
  entity_type: string;
  action?: string;
  is_yield?: boolean;
  is_adjustment?: boolean;
  transfer_group_id?: string | null;
  split_from_id?: string | null;
  cashflow_amount_usd?: number | null;
  cashflow_amount_eur?: number | null;
  delta_usd?: number | null;
  delta_eur?: number | null;
  before_snapshot?: unknown;
  after_snapshot?: unknown;
  details?: unknown;
}

export interface CostBasisResult {
  /** Remaining cost ÷ remaining units (0 if no units). */
  avgCost: number;
  /** Remaining cost of currently-held units. */
  costBasis: number;
  /** Σ over disposals of (proceeds − avgAtSale × unitsSold). */
  realized: number;
  /** currentMarketValue − costBasis. */
  unrealized: number;
  /** realized + unrealized. */
  totalPnL: number;
}

/** Options: currency selects which stored column each value reads (default "eur" —
 * EUR is authoritative); `onAnomaly` is an injected sink for the oversell signal
 * (the engine stays pure when it is omitted). */
export interface CostBasisOptions {
  currency?: "usd" | "eur";
  onAnomaly?: (msg: string) => void;
}

/** A stream entry after the transfer-netting pre-step: the original row's
 * classification flags + its resolved per-currency `value` and `qtyDelta`.
 *
 * Exported so the running-cost series (buildCostBasisSeries in
 * historical-prices-augmentation.ts) can fold the SAME stream the headline P&L
 * folds — the series and the headline must never diverge in how they net
 * transfers or resolve the C3 value source. */
export interface StreamEntry {
  qtyDelta: number;
  value: number;
  isYield: boolean;
  isCorrection: boolean;
}

/**
 * The running average-cost accumulator state: held `units`, their remaining
 * `cost`, and cumulative `realized` P&L. `cost` IS the running cost basis — the
 * exact quantity the series emits at each transaction date.
 */
export interface CostFoldState {
  units: number;
  cost: number;
  realized: number;
}

/** Read a numeric column, treating null/undefined/NaN as 0. */
function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Resolve a row's per-currency value (C3): adjustment/transfer legs carry value in
 * `delta_{cur}`, real flows in `cashflow_amount_{cur}`. Absolute magnitude — direction
 * is owned by `quantityDelta`.
 */
function resolveValue(txn: CostBasisTxn, currency: "usd" | "eur"): number {
  if (txn.is_adjustment) {
    return Math.abs(num(currency === "usd" ? txn.delta_usd : txn.delta_eur));
  }
  return Math.abs(
    num(currency === "usd" ? txn.cashflow_amount_usd : txn.cashflow_amount_eur),
  );
}

/** Adapt a `CostBasisTxn` to the `quantityDelta` input shape. */
function toTxnRow(txn: CostBasisTxn): TransactionRow {
  return {
    entity_type: txn.entity_type,
    action: txn.action,
    is_yield: txn.is_yield,
    is_adjustment: txn.is_adjustment,
    transfer_group_id: txn.transfer_group_id,
    split_from_id: txn.split_from_id,
    before_snapshot: asSnapshot(txn.before_snapshot),
    after_snapshot: asSnapshot(txn.after_snapshot),
    details: asSnapshot(txn.details),
  };
}

/**
 * Net transfer legs by `transfer_group_id` within the stream, returning the ordered
 * list of stream entries to fold (§6 pre-step). Non-transfer rows pass through; each
 * transfer group collapses to zero or one synthetic entry placed at its first leg's
 * position.
 */
export function buildStream(txnsAsc: CostBasisTxn[], currency: "usd" | "eur"): StreamEntry[] {
  // First pass: index transfer-group members by id, preserving first-seen position.
  const groupMembers = new Map<string, number[]>(); // group id → indices in txnsAsc
  txnsAsc.forEach((txn, i) => {
    const g = txn.transfer_group_id;
    if (g != null) {
      const arr = groupMembers.get(g);
      if (arr) arr.push(i);
      else groupMembers.set(g, [i]);
    }
  });

  const entries: StreamEntry[] = [];
  const emittedGroups = new Set<string>();

  txnsAsc.forEach((txn, i) => {
    const g = txn.transfer_group_id;

    if (g != null) {
      // Transfer-group row: handled once, at the group's first member position.
      const indices = groupMembers.get(g)!;
      if (emittedGroups.has(g)) return; // already netted at the first leg
      if (indices[0] !== i) return; // emit only at the first leg's position
      emittedGroups.add(g);

      const net = indices.reduce((sum, idx) => sum + quantityDelta(toTxnRow(txnsAsc[idx])), 0);

      if (Math.abs(net) < EPS) {
        // Wallet↔wallet move (both legs present) → cost-neutral, no entry.
        return;
      }

      if (indices.length === 1) {
        // Cross-asset transfer: a single leg lives in this stream → normal
        // disposal/acquisition valued at the moved value |delta_{cur}|.
        entries.push({
          qtyDelta: net,
          value: resolveValue(txn, currency),
          isYield: false,
          isCorrection: false, // transfer legs realize gain (not off-book corrections)
        });
        return;
      }

      // Multiple legs with a small non-zero net → same-asset fee remainder (B5).
      // Emit ONE synthetic entry of the net magnitude at value 0: a negative net books
      // a realized loss = avg×out; a positive net adds units at zero cost.
      entries.push({
        qtyDelta: net,
        value: 0,
        isYield: false,
        isCorrection: false,
      });
      return;
    }

    // Non-transfer row.
    const qtyDelta = quantityDelta(toTxnRow(txn));
    const isYield = txn.is_yield === true;
    // Only reached when g == null, so transfer_group_id is already absent.
    const isCorrection = txn.is_adjustment === true && !isYield;
    entries.push({
      qtyDelta,
      value: resolveValue(txn, currency),
      isYield,
      isCorrection,
    });
  });

  return entries;
}

/**
 * Average-cost P&L for one asset over its full transaction stream.
 *
 * @param txnsAsc            transactions sorted by COALESCE(effective_date, created_at)
 *                          ascending — the caller's responsibility.
 * @param currentMarketValue current market value of the held units (priced upstream).
 *                          Caller must guarantee a FINITE number — a non-finite value
 *                          propagates to `unrealized`/`totalPnL` by design (a visible
 *                          NaN beats a silently-wrong 0).
 * @param opts.currency      which stored column to read (default "eur").
 * @param opts.onAnomaly     optional sink fired once per genuine oversell (H4).
 */
export function computeCostBasis(
  txnsAsc: CostBasisTxn[],
  currentMarketValue: number,
  opts?: CostBasisOptions,
): CostBasisResult {
  const currency = opts?.currency ?? "eur";
  const stream = buildStream(txnsAsc, currency);

  const state: CostFoldState = { units: 0, cost: 0, realized: 0 };
  for (const entry of stream) {
    foldCostStep(state, entry, opts?.onAnomaly);
  }

  const costBasis = state.cost;
  const avgCost = state.units > 0 ? state.cost / state.units : 0;
  const unrealized = currentMarketValue - costBasis;
  const totalPnL = state.realized + unrealized;

  return { avgCost, costBasis, realized: state.realized, unrealized, totalPnL };
}

/**
 * Apply ONE stream entry to the running average-cost accumulator, mutating
 * `state` in place. This is the verified per-transaction fold extracted verbatim
 * from computeCostBasis's loop — the SINGLE source of cost arithmetic. The
 * running-cost series (buildCostBasisSeries) walks each asset's stream once,
 * calling this per entry and reading `state.cost` at each transaction date, so
 * the series can NEVER drift from the headline P&L.
 *
 * Semantics (unchanged from the inline loop):
 *   - yield        → units += qtyDelta, cost unchanged (lowers average cost)
 *   - acquisition  → units += qtyDelta; cost += value unless a balance-up
 *                    correction (zero cost)
 *   - disposal     → realized += value − avg×out (skipped for a balance-down
 *                    correction); cost -= avg×out; units -= out; oversell clamped
 *                    (H4, fires onAnomaly); snap units/cost to 0 within EPS so a
 *                    re-buy restarts cleanly.
 */
export function foldCostStep(
  state: CostFoldState,
  entry: StreamEntry,
  onAnomaly?: (msg: string) => void,
): void {
  const qtyDelta = entry.qtyDelta;
  if (qtyDelta === 0) return;
  const value = entry.value;

  if (entry.isYield) {
    // Earned units — cost += 0, lowers average cost.
    state.units += qtyDelta;
  } else if (qtyDelta > 0) {
    // Acquisition.
    if (entry.isCorrection) {
      state.units += qtyDelta; // balance-up restatement → zero cost
    } else {
      state.units += qtyDelta; // BUY / TRANSFER-IN
      state.cost += value;
    }
  } else {
    // Disposal (qtyDelta < 0).
    const avg = state.units > 0 ? state.cost / state.units : 0;
    const out = Math.min(-qtyDelta, state.units); // oversell clamp (H4)
    if (-qtyDelta > state.units + EPS) {
      // Only reachable from corrupt/backdated data (a buy backdated after a sell).
      onAnomaly?.(
        `cost-basis oversell: tried to dispose ${(-qtyDelta).toFixed(8)} but only ${state.units.toFixed(8)} units held`,
      );
    }
    if (entry.isCorrection) {
      state.cost -= avg * out; // balance-down restatement → no realized
      state.units -= out;
    } else {
      state.realized += value - avg * out; // SELL / TRANSFER-OUT
      state.cost -= avg * out;
      state.units -= out;
    }
    // Snap to a clean zero so cent-rounded drift can't survive and a re-buy
    // restarts from 0/0.
    if (Math.abs(state.units) < EPS) {
      state.units = 0;
      state.cost = 0;
    }
  }
}

/**
 * Per-currency P&L for one asset (spec §7.7).
 *
 * EUR is AUTHORITATIVE — it is the headline P&L exposed to the user and used for
 * portfolio aggregation. The USD pass is secondary: it will legitimately diverge from
 * EUR by FX timing (every transaction stores both amounts at the rate that was live
 * when it was entered, not at today's rate). The two passes are NEVER cross-reconciled;
 * each is internally consistent within its own currency arithmetic.
 */
export interface AssetPnL {
  /** EUR pass — the AUTHORITATIVE headline P&L (base currency). */
  eur: CostBasisResult;
  /** USD pass — secondary; legitimately diverges by FX timing; NEVER reconciled to EUR. */
  usd: CostBasisResult;
}

/**
 * Run the average-cost engine independently for EUR and USD (§7.7).
 *
 * Each pass reads only that currency's stored columns and is self-consistent.
 * The results legitimately diverge because every transaction captures the FX rate
 * at entry time, not today's rate. EUR is authoritative for the headline P&L.
 *
 * @param txnsAsc     transactions sorted ascending by COALESCE(effective_date, created_at).
 * @param currentValue current market value expressed in both currencies.
 * @param opts.onAnomaly optional anomaly sink forwarded to BOTH passes (so an oversell
 *                        fires it once per currency, not just for the EUR pass).
 */
export function computeAssetPnL(
  txnsAsc: CostBasisTxn[],
  currentValue: { valueEur: number; valueUsd: number },
  opts?: { onAnomaly?: (msg: string) => void },
): AssetPnL {
  const onAnomaly = opts?.onAnomaly;
  return {
    eur: computeCostBasis(txnsAsc, currentValue.valueEur, {
      currency: "eur",
      onAnomaly,
    }),
    usd: computeCostBasis(txnsAsc, currentValue.valueUsd, {
      currency: "usd",
      onAnomaly,
    }),
  };
}
