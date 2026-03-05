/**
 * Pure delta computation helpers — no DB, no async, no "use server".
 * Extracted from activity-log.ts so tests can import the real logic.
 */

export type CashEntityType =
  | "bank_account"
  | "exchange_deposit"
  | "broker_deposit";

/** Which snapshot field holds the monetary value for a given cash entity type. */
export function cashAmountField(
  entityType: CashEntityType
): "balance" | "amount" {
  return entityType === "bank_account" ? "balance" : "amount";
}

/**
 * Compute the raw numeric delta for a cash entity (bank account, deposit).
 * Returns the signed change in the entity's native currency.
 */
export function cashDelta(
  action: string,
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
  action: string,
  beforeQty: number,
  afterQty: number
): number {
  if (action === "created") return afterQty;
  if (action === "removed") return -beforeQty;
  return afterQty - beforeQty; // updated
}
