/**
 * Pure cashflow computation helpers — no DB, no async, no "use server".
 * Companion to src/lib/deltas.ts (same pattern: extracted for testability).
 */

import { positionQtyDelta, cashDelta } from "@/lib/deltas";
import type { ActionType, AssetClass, EntityType } from "@/lib/types";

/** Shared predicate for stablecoin detection — single source of truth. */
export function isStablecoin(subcategory: string | null | undefined): boolean {
  return subcategory?.toLowerCase() === "stablecoin";
}

/**
 * Compute cashflow USD/EUR values from prices already available at write time.
 *
 * Two modes:
 * 1. Position entities (crypto/stock): pass priceUsd + priceEur
 * 2. Cash entities (bank/deposit): pass entityCurrency + fxRate (EUR/USD)
 */
export function computeCashflowFromPrices(params: {
  action: ActionType;
  beforeQty: number;
  afterQty: number;
  /** For position entities: USD price per unit */
  priceUsd?: number;
  /** For position entities: EUR price per unit */
  priceEur?: number;
  /** For cash entities: the entity's native currency */
  entityCurrency?: string;
  /** EUR/USD rate (e.g., 1.08 = 1 EUR buys 1.08 USD) */
  fxRate?: number;
}): { usd: number; eur: number } | null {
  const { action, beforeQty, afterQty } = params;

  // Position mode: qty × price
  if (params.priceUsd != null || params.priceEur != null) {
    const delta = positionQtyDelta(action, beforeQty, afterQty);
    return {
      usd: delta * (params.priceUsd ?? 0),
      eur: delta * (params.priceEur ?? 0),
    };
  }

  // Cash mode: amount delta × FX conversion
  const delta = cashDelta(action, beforeQty, afterQty);
  const fxRate = params.fxRate ?? 1;
  const currency = params.entityCurrency ?? "USD";

  if (currency === "EUR") {
    return { usd: delta * fxRate, eur: delta };
  }
  if (currency === "USD") {
    return { usd: delta, eur: fxRate > 0 ? delta / fxRate : delta };
  }
  // Other currencies (GBP, CHF, etc.): return null to signal "needs FX conversion"
  // Callers should fall back to toUsdAndEur() or mark cashflow as pending
  console.warn(`[cashflow] Unsupported currency "${currency}" in computeCashflowFromPrices — returning null for backfill`);
  return null;
}

/**
 * Map entity_type to asset class for cashflow classification.
 * Returns null for entity types that don't produce cashflows.
 */
export function classifyAssetClass(
  entityType: EntityType,
  isStablecoin?: boolean
): AssetClass | null {
  if (entityType === "crypto_position") {
    return isStablecoin ? "cash" : "crypto";
  }
  if (entityType === "stock_position") return "stocks";
  if (
    entityType === "cash_account" ||
    entityType === "bank_account" ||
    entityType === "exchange_deposit" ||
    entityType === "broker_deposit"
  ) {
    return "cash";
  }
  return null;
}
