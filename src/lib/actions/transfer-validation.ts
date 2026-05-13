/**
 * Pure validation helpers for `executeTransfer` input.
 *
 * Split into two stages because `executeTransfer` patches "PENDING" UUID
 * placeholders mid-flow (when newBroker/newWallet/new{Stock,Crypto}Asset/
 * newCashDeposit create entities). Shape validation runs EARLY (before any
 * entity creation) on quantities/amounts. Full validation including UUIDs runs
 * LATE (after PENDING placeholders are patched to real UUIDs).
 *
 * Extracted from transfers.ts so unit tests can import directly — Turbopack
 * strips non-async exports from "use server" modules.
 */

import {
  validateUUID,
  validateQuantity,
  validateAmount,
} from "@/lib/validation";
import type { TransferSide } from "@/lib/types";

/**
 * Shape validation: quantity/amount only. Safe to run on inputs that still
 * carry "PENDING" UUID placeholders for entities the server will create.
 * Always called EARLY — before any entity creation runs.
 */
export function validateSideShape(side: TransferSide, label: string): void {
  switch (side.type) {
    case "crypto_position":
    case "stock_position":
      validateQuantity(side.quantity, `${label} quantity`);
      if (side.quantity <= 0) throw new Error(`${label} quantity must be positive`);
      break;
    case "cash_account":
      validateAmount(side.amount, `${label} amount`);
      if (side.amount <= 0) throw new Error(`${label} amount must be positive`);
      break;
  }
}

/**
 * Full validation: shape + UUIDs. Called LATE — after Step 0/1 entity creation
 * has replaced "PENDING" placeholders with real UUIDs.
 */
export function validateTransferSide(side: TransferSide, label: string): void {
  validateSideShape(side, label);
  switch (side.type) {
    case "crypto_position":
      validateUUID(side.assetId, `${label} asset ID`);
      validateUUID(side.walletId, `${label} wallet ID`);
      break;
    case "stock_position":
      validateUUID(side.assetId, `${label} asset ID`);
      validateUUID(side.brokerId, `${label} broker ID`);
      break;
    case "cash_account":
      validateUUID(side.accountId, `${label} account ID`);
      break;
  }
}
