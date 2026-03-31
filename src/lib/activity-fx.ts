/**
 * Shared FX delta/cashflow computation helpers for activity logging.
 * Pure module — no "use server", no Supabase imports.
 * Used by crypto.ts, stocks.ts, and cash-accounts.ts server actions.
 */

import { classifyAssetClass } from "@/lib/cashflow";
import type { FlowStatus, AssetClass, EntityType } from "@/lib/types";

// ─── Shared types ─────────────────────────────────────────

export interface FxResult {
  deltaUsd: number | null;
  deltaEur: number | null;
  deltaStatus: FlowStatus;
  cashflowUsd: number | null;
  cashflowEur: number | null;
  cashflowAssetClass: AssetClass | null;
  cashflowStatus: FlowStatus;
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
}): FxResult {
  const result = emptyFx();
  if (opts.isAdjustment) {
    result.deltaUsd = opts.valUsd;
    result.deltaEur = opts.valEur;
    result.deltaStatus = "complete";
  } else {
    result.cashflowUsd = opts.valUsd;
    result.cashflowEur = opts.valEur;
    result.cashflowAssetClass = classifyAssetClass(opts.entityType, opts.isStable);
    result.cashflowStatus = "complete";
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
}): Promise<FxResult> {
  const result = emptyFx();
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
