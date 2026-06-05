/**
 * Shared FX delta/cashflow computation helpers for activity logging.
 * Pure module — no "use server", no Supabase imports.
 * Used by crypto.ts, stocks.ts, and cash-accounts.ts server actions.
 *
 * ─── THE SIGN CONTRACT ───────────────────────────────────────────────────────
 * Stored `cashflow_amount_*` and `delta_*` are SIGNED: positive = money/value
 * ENTERING the portfolio (buy / deposit / yield), negative = LEAVING
 * (sell / withdrawal). The benchmark replay (`deriveCashFlows`), the deposits
 * tooltips, and `dashboard-changes` all read these columns verbatim, so the
 * stored sign IS the economic direction.
 *
 * A user-supplied `amountOverride` is a MAGNITUDE — the absolute money the user
 * typed (incl. fees). Its direction comes from the OPERATION, never from the
 * override itself and never from `Math.sign(valUsd)`: the transaction manager
 * passes NO prices for a cost-only write, so `valUsd` can be `0`/`-0` and
 * `Math.sign(valUsd || 1)` would silently flip a disposal positive (the forbidden
 * trap). Callers therefore pass an explicit `direction` (1 = acquisition,
 * −1 = disposal) derived from the qty/balance delta they already computed for
 * `val*`. When `direction` is omitted it defaults to +1 (the historical default —
 * every pre-contract caller only ever overrode acquisitions).
 *
 * Single signing locus: the override leg is normalized with `Math.abs` HERE so a
 * future signed caller can't double-negate, then `stored = direction × |override|`
 * in BOTH branches (cashflow AND delta). When no override is present the qty×price
 * `val*` already carries its own sign and is used byte-identically (direction is
 * ignored on that path).
 */

import { classifyAssetClass } from "@/lib/cashflow";
import type { FlowStatus, AssetClass, EntityType, UsdEurAmount } from "@/lib/types";

// ─── Shared types ─────────────────────────────────────────

export interface FxResult {
  deltaUsd: number | null;
  deltaEur: number | null;
  deltaStatus: FlowStatus;
  cashflowUsd: number | null;
  cashflowEur: number | null;
  cashflowAssetClass: AssetClass | null;
  cashflowStatus: FlowStatus;
  /** True when the cashflow amounts came from a user-supplied override, not qty × price. */
  cashflowUserSet: boolean;
}

export function emptyFx(): FxResult {
  return {
    deltaUsd: null,
    deltaEur: null,
    deltaStatus: null,
    cashflowUsd: null,
    cashflowEur: null,
    cashflowAssetClass: null,
    cashflowStatus: null,
    cashflowUserSet: false,
  };
}

// ─── Crypto: pre-computed USD/EUR values ─────────────────

/**
 * Compute FX fields for crypto positions where USD and EUR values are
 * already available (qty × priceUsd / qty × priceEur).
 *
 * If isAdjustment → fills delta fields.
 * Otherwise → fills cashflow fields (classifies asset class).
 */
export function computeActivityFx(opts: {
  valUsd: number;
  valEur: number;
  isAdjustment?: boolean;
  entityType: EntityType;
  isStable?: boolean;
  amountOverride?: UsdEurAmount;
  /**
   * Operation direction for a user-supplied `amountOverride`: 1 = acquisition
   * (buy/deposit/yield), −1 = disposal (sell/withdrawal). Defaults to +1. Only
   * consulted when `amountOverride` is present — the no-override `val*` path
   * already carries its own sign. See THE SIGN CONTRACT above.
   */
  direction?: 1 | -1;
}): FxResult {
  const result = emptyFx();
  // Normalize the override to a magnitude here (single signing locus) so a
  // future signed caller can't double-negate, then apply the operation direction.
  const dir = opts.direction ?? 1;
  const signedOverride =
    opts.amountOverride != null
      ? { usd: dir * Math.abs(opts.amountOverride.usd), eur: dir * Math.abs(opts.amountOverride.eur) }
      : null;
  if (opts.isAdjustment) {
    result.deltaUsd = signedOverride?.usd ?? opts.valUsd;
    result.deltaEur = signedOverride?.eur ?? opts.valEur;
    result.deltaStatus = "complete";
  } else {
    result.cashflowUsd = signedOverride?.usd ?? opts.valUsd;
    result.cashflowEur = signedOverride?.eur ?? opts.valEur;
    result.cashflowAssetClass = classifyAssetClass(opts.entityType, opts.isStable);
    result.cashflowStatus = "complete";
    if (signedOverride != null) result.cashflowUserSet = true;
  }
  return result;
}

// ─── Stocks: needs FX API conversion ─────────────────────

/**
 * Compute FX fields for stock positions where the native-currency value
 * must be converted to USD and EUR via the FX API.
 *
 * If isAdjustment → fills delta fields.
 * Otherwise → fills cashflow fields (classifies asset class).
 * On FX failure → marks the relevant status as "pending".
 */
export async function computeActivityFxWithConversion(opts: {
  valueNative: number;
  currency: string;
  effectiveDate?: string;
  isAdjustment?: boolean;
  entityType: EntityType;
  isStable?: boolean;
  amountOverride?: UsdEurAmount;
  /**
   * Operation direction for a user-supplied `amountOverride`: 1 = acquisition,
   * −1 = disposal. Defaults to +1. Only consulted when `amountOverride` is
   * present. See THE SIGN CONTRACT at the top of this module.
   */
  direction?: 1 | -1;
}): Promise<FxResult> {
  const result = emptyFx();

  // When an override is present, skip qty × price conversion entirely. The
  // override is a MAGNITUDE — normalize with Math.abs (single signing locus) and
  // apply the operation direction so a disposal stores a negative amount.
  if (opts.amountOverride != null) {
    const dir = opts.direction ?? 1;
    const signedUsd = dir * Math.abs(opts.amountOverride.usd);
    const signedEur = dir * Math.abs(opts.amountOverride.eur);
    if (opts.isAdjustment) {
      result.deltaUsd = signedUsd;
      result.deltaEur = signedEur;
      result.deltaStatus = "complete";
    } else {
      result.cashflowUsd = signedUsd;
      result.cashflowEur = signedEur;
      result.cashflowAssetClass = classifyAssetClass(opts.entityType, opts.isStable);
      result.cashflowStatus = "complete";
      result.cashflowUserSet = true;
    }
    return result;
  }

  try {
    const { toUsdAndEur } = await import("@/lib/actions/activity-log");
    const converted = await toUsdAndEur(
      opts.valueNative,
      opts.currency,
      opts.effectiveDate?.split("T")[0],
    );
    if (opts.isAdjustment) {
      result.deltaUsd = converted.usd;
      result.deltaEur = converted.eur;
      result.deltaStatus = "complete";
    } else {
      result.cashflowUsd = converted.usd;
      result.cashflowEur = converted.eur;
      result.cashflowAssetClass = classifyAssetClass(opts.entityType, opts.isStable);
      result.cashflowStatus = "complete";
    }
  } catch (err) {
    console.error(
      `[activity-fx] FX conversion failed, marked pending:`,
      err instanceof Error ? err.message : err,
    );
    if (opts.isAdjustment) result.deltaStatus = "pending";
    else result.cashflowStatus = "pending";
  }
  return result;
}
