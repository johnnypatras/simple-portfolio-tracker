/**
 * Pure delta computation helpers — no DB, no async, no "use server".
 * Extracted from activity-log.ts so tests can import the real logic.
 */

import type { ActionType } from "@/lib/types";

export type CashEntityType =
  | "bank_account"
  | "exchange_deposit"
  | "broker_deposit"
  | "cash_account";

export const CASH_ENTITY_TYPES: readonly CashEntityType[] = [
  "bank_account", "exchange_deposit", "broker_deposit", "cash_account",
] as const;

/** Which snapshot field holds the monetary value for a given cash entity type. */
export function cashAmountField(
  entityType: CashEntityType
): "balance" | "amount" {
  if (entityType === "exchange_deposit" || entityType === "broker_deposit") return "amount";
  return "balance"; // bank_account and cash_account both use "balance"
}

/**
 * Compute the raw numeric delta for a cash entity (bank account, deposit).
 * Returns the signed change in the entity's native currency.
 */
export function cashDelta(
  action: ActionType,
  beforeAmt: number,
  afterAmt: number
): number {
  if (action === "created") return afterAmt;
  if (action === "removed") return -beforeAmt;
  return afterAmt - beforeAmt; // updated
}

/**
 * Compute the raw quantity delta for a position entity (crypto or stock).
 * Returns the signed change in quantity.
 */
export function positionQtyDelta(
  action: ActionType,
  beforeQty: number,
  afterQty: number
): number {
  if (action === "created") return afterQty;
  if (action === "removed") return -beforeQty;
  return afterQty - beforeQty; // updated
}
