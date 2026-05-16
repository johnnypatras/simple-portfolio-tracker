"use server";

import * as Sentry from "@sentry/nextjs";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { upsertPosition, createCryptoAsset } from "@/lib/actions/crypto";
import {
  upsertStockPosition,
  createStockAsset,
} from "@/lib/actions/stocks";
import { createCashAccount, updateCashAccount } from "@/lib/actions/cash-accounts";
import { createBroker } from "@/lib/actions/brokers";
import { createWallet } from "@/lib/actions/wallets";
import { getPrices } from "@/lib/prices/coingecko";
import { getStockPrices } from "@/lib/prices/yahoo";
import type {
  TransferInput,
  TransferResult,
  TransferSide,
} from "@/lib/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  validateAmount,
  validateCurrency,
  validatePastOrTodayDate,
} from "@/lib/validation";
import {
  validateSideShape,
  validateTransferSide,
} from "@/lib/actions/transfer-validation";

// ─── Types for cleanup tracking ─────────────────────────────

/** Entity created during transfer setup, tracked for cleanup on failure */
interface CreatedEntity { table: string; id: string }

// ─── Types for internal state tracking ───────────────────────

/** Original state captured before source leg, used for rollback */
type SourceOriginalState =
  | { type: "crypto_position"; quantity: number }
  | { type: "stock_position"; quantity: number }
  | { type: "cash_account"; id: string; balance: number; currency: string };

/** Per-side prices for delta calculation */
interface SidePrices {
  priceUsd?: number;
  priceEur?: number;
  priceNative?: number;
  currency?: string;
}

interface TransferPrices {
  source: SidePrices;
  destination: SidePrices;
}

// ─── Main Transfer Action ────────────────────────────────────

export async function executeTransfer(input: TransferInput): Promise<TransferResult> {
  // Authenticate
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  // ── Early shape validation (quantities/amounts) ────────────
  // UUID validation runs LATE — after Step 0/1 patches "PENDING" placeholders
  // (newBroker→brokerId, newWallet→walletId, new{Stock,Crypto}Asset→assetId,
  // newCashDeposit→source.accountId) into real UUIDs.
  validateSideShape(input.destination, "Destination");
  if (input.source) validateSideShape(input.source, "Source");
  if (input.newCashDeposit) {
    validateAmount(input.newCashDeposit.amount, "Cash deposit amount");
    if (input.newCashDeposit.amount <= 0) throw new Error("Cash deposit amount must be positive");
    validateCurrency(input.newCashDeposit.currency);
  }
  // Transfers are recorded for events that already happened; future-dated
  // effectiveDate would corrupt every COALESCE(effective_date, created_at)
  // pipeline (chart enrichment, S&P benchmark, period changes, history).
  if (input.effectiveDate) validatePastOrTodayDate(input.effectiveDate, "Effective date");

  // Use a local destination variable to avoid mutating input
  let destination: TransferSide = input.destination;

  // Track entities created during setup for cleanup on failure.
  // Assets (crypto_assets, stock_assets) are NOT tracked — dedup may return
  // pre-existing IDs, and hard-deleting those would destroy portfolio data.
  const createdEntities: CreatedEntity[] = [];
  let transferGroupId: string | undefined;

  try {
    // Use a mutable copy of input so we can patch source IDs (e.g., when
    // newCashDeposit creates a cash account that the source should point to).
    let currentSource = input.source;

    // ── Early validation: check source balance BEFORE creating any entities.
    // When newCashDeposit is involved, the source IS the deposit being created
    // (so it can't be validated yet — its amount is controlled by the UI).
    // For all other cases, validate the pre-existing source now to avoid
    // orphaning entities (broker, wallet, asset) if balance is insufficient.
    if (currentSource && !input.newCashDeposit) {
      const earlyState = await fetchSourceState(supabase, currentSource, user.id);
      validateSufficientBalance(currentSource, earlyState);
    }

    // ── Step 0: Create inline entities for buy mode ──────
    if (input.newBroker) {
      const brokerId = await createBroker({ name: input.newBroker.name });
      createdEntities.push({ table: "brokers", id: brokerId });
      if (destination.type === "stock_position") {
        destination = { ...destination, brokerId };
      }
    }

    if (input.newWallet) {
      const walletId = await createWallet({
        name: input.newWallet.name,
        wallet_type: "custodial",
      });
      createdEntities.push({ table: "wallets", id: walletId });
      if (destination.type === "crypto_position") {
        destination = { ...destination, walletId };
      }
    }

    if (input.newCashDeposit) {
      // Seed-cash-then-buy flow: modal sends source with "PENDING" accountId +
      // newCashDeposit. Create the cash account, then patch the source to point
      // at the new account so the existing source-leg logic can deduct the buy
      // amount from it (proper two-legged accounting, S&P-benchmark-correct).
      // Derive wallet/broker linkage from the destination asset
      const walletId = destination.type === "crypto_position" ? destination.walletId : undefined;
      const brokerId = destination.type === "stock_position" ? destination.brokerId : undefined;
      const accountId = await createCashAccount(
        {
          currency: input.newCashDeposit.currency,
          balance: input.newCashDeposit.amount,
          wallet_id: walletId ?? null,
          broker_id: brokerId ?? null,
        },
        {
          isAdjustment: input.newCashDeposit.isAdjustment,
          effectiveDate: input.effectiveDate,
        }
      );
      createdEntities.push({ table: "cash_accounts", id: accountId });
      // Patch source.accountId if modal sent the PENDING placeholder
      if (currentSource?.type === "cash_account" && currentSource.accountId === "PENDING") {
        currentSource = { ...currentSource, accountId };
      }
    }

    // Generate a transfer group ID only for two-legged transfers
    transferGroupId = currentSource ? crypto.randomUUID() : undefined;

    // ── Step 1: Create new assets if needed ─────────────────
    if (input.newCryptoAsset) {
      if (destination.type !== "crypto_position") {
        return { success: false, error: "newCryptoAsset provided but destination is not crypto_position" };
      }
      const newAssetId = await createCryptoAsset(input.newCryptoAsset);
      destination = { ...destination, assetId: newAssetId };
    }
    if (input.newStockAsset) {
      if (destination.type !== "stock_position") {
        return { success: false, error: "newStockAsset provided but destination is not stock_position" };
      }
      const newAssetId = await createStockAsset(input.newStockAsset);
      destination = { ...destination, assetId: newAssetId };
    }

    // ── Step 1.5: LATE UUID validation ──────────────────────
    // All "PENDING" placeholders are now real UUIDs. Validate sides fully before
    // the source/destination legs run. (Shape was validated up top, pre-creation.)
    validateTransferSide(destination, "Destination");
    if (currentSource) validateTransferSide(currentSource, "Source");

    // ── Steps 2–5: Source leg (skip for single-legged buy) ──
    let originalState: SourceOriginalState | null = null;
    let prices: TransferPrices = { source: {}, destination: {} };

    if (currentSource) {
      // currentSource truthy ⇒ transferGroupId was set on line 161. Narrow
      // explicitly instead of using `!` so a future refactor that moves the
      // assignment fails loudly rather than silently passing `undefined`.
      if (!transferGroupId) throw new Error("Transfer logic error: transferGroupId not set for two-legged transfer");
      originalState = await fetchSourceState(supabase, currentSource, user.id);
      prices = await fetchPrices(supabase, currentSource, destination);
      validateSufficientBalance(currentSource, originalState);
      await executeSourceLeg(currentSource, originalState, transferGroupId, prices.source, input.effectiveDate);
    }

    // ── Step 6: Execute destination leg (increase) with rollback on failure
    try {
      await executeDestLeg(supabase, destination, transferGroupId, prices.destination, user.id, input.effectiveDate);
    } catch (destErr) {
      if (currentSource && originalState) {
        // Rollback source: restore to original state
        if (!transferGroupId) throw new Error("Transfer logic error: transferGroupId missing during rollback");
        try {
          await rollbackSource(currentSource, originalState, transferGroupId, prices.source, input.effectiveDate);
        } catch (rollbackErr) {
          // Source modified + rollback failed → partial failure.
          // Skip cleanup — entities may be referenced by the modified source.
          const err = new Error(
            `Transfer failed and rollback failed. Source was modified. Original: ${JSON.stringify(originalState)}. Rollback error: ${rollbackErr instanceof Error ? rollbackErr.message : "unknown"}. Check positions.`
          );
          (err as Error & { partialFailure: boolean }).partialFailure = true;
          throw err;
        }
        // Rollback succeeded → re-throw so outer catch does cleanup
        throw destErr;
      }
      // Single-legged buy: no rollback needed, re-throw for cleanup
      throw destErr;
    }

    // ── Step 7: Revalidate and return ───────────────────────
    revalidatePath("/dashboard/accounts");
    revalidatePath("/dashboard");

    return { success: true, transferGroupId: transferGroupId ?? "" };
  } catch (err) {
    const isPartial = (err as Error & { partialFailure?: boolean })?.partialFailure === true;

    // Clean up orphaned entities unless partial failure (entities may be needed for manual recovery)
    if (!isPartial && createdEntities.length > 0) {
      await cleanupTransferEntities(supabase, createdEntities);
    }

    // Server-side capture at the transfer level — adds the `partial` tag
    // that sub-action `captureAction` wraps can't know about. Sub-actions
    // (crypto.upsertPosition, cash-accounts.updateCashAccount, etc.) also
    // capture the same error with their own action tags; Sentry groups
    // them by stack-trace fingerprint into a single issue, with each event
    // exposing a different layer of context. This is intentional structured
    // observability, not double-capture noise.
    Sentry.captureException(err, {
      tags: {
        action: "transfers.executeTransfer",
        partial: isPartial ? "true" : "false",
      },
    });

    return {
      success: false,
      error: err instanceof Error ? err.message : "Transfer failed",
      transferGroupId,
      partialFailure: isPartial || undefined,
    };
  }
}

// ─── Validate Sufficient Balance ─────────────────────────────

function validateSufficientBalance(source: TransferSide, state: SourceOriginalState): void {
  switch (source.type) {
    case "crypto_position":
      if (state.type === "crypto_position" && source.quantity > state.quantity) {
        throw new Error(`Insufficient crypto balance: have ${state.quantity}, need ${source.quantity}`);
      }
      break;
    case "stock_position":
      if (state.type === "stock_position" && source.quantity > state.quantity) {
        throw new Error(`Insufficient stock balance: have ${state.quantity}, need ${source.quantity}`);
      }
      break;
    case "cash_account":
      if (state.type !== "cash_account") throw new Error("State type mismatch");
      if (source.amount > state.balance) {
        throw new Error(`Insufficient cash balance: have ${state.balance}, need ${source.amount}`);
      }
      break;
  }
}

// ─── Fetch Source State ──────────────────────────────────────

async function fetchSourceState(
  supabase: SupabaseClient,
  source: TransferSide,
  userId: string,
): Promise<SourceOriginalState> {
  switch (source.type) {
    case "crypto_position": {
      // Position tables don't have a user_id column — RLS via parent
      // crypto_asset/wallet is the only feasible scope. user_id passed
      // for symmetry with cash_account branch + future-proofing.
      const { data, error } = await supabase
        .from("crypto_positions")
        .select("quantity")
        .eq("crypto_asset_id", source.assetId)
        .eq("wallet_id", source.walletId)
        .is("deleted_at", null)
        .single();
      if (error || !data) throw new Error(`Source crypto position not found: ${error?.message ?? "no data"}`);
      return { type: "crypto_position", quantity: Number(data.quantity) };
    }
    case "stock_position": {
      const { data, error } = await supabase
        .from("stock_positions")
        .select("quantity")
        .eq("stock_asset_id", source.assetId)
        .eq("broker_id", source.brokerId)
        .is("deleted_at", null)
        .single();
      if (error || !data) throw new Error(`Source stock position not found: ${error?.message ?? "no data"}`);
      return { type: "stock_position", quantity: Number(data.quantity) };
    }
    case "cash_account": {
      const { data, error } = await supabase
        .from("cash_accounts")
        .select("id, balance, currency")
        .eq("id", source.accountId)
        .eq("user_id", userId)
        .is("deleted_at", null)
        .single();
      if (error || !data) throw new Error("Source cash account not found");
      return { type: "cash_account", id: data.id, balance: Number(data.balance), currency: data.currency };
    }
  }
}

// ─── Fetch Prices ────────────────────────────────────────────

async function fetchPrices(
  supabase: SupabaseClient,
  source: TransferSide,
  destination: TransferSide
): Promise<TransferPrices> {
  const prices: TransferPrices = { source: {}, destination: {} };

  // ── Crypto prices ──
  const cryptoSides: { side: "source" | "destination"; assetId: string }[] = [];
  if (source.type === "crypto_position") cryptoSides.push({ side: "source", assetId: source.assetId });
  if (destination.type === "crypto_position") cryptoSides.push({ side: "destination", assetId: destination.assetId });

  if (cryptoSides.length > 0) {
    const assetIds = [...new Set(cryptoSides.map((s) => s.assetId))];
    const { data: assets } = await supabase
      .from("crypto_assets")
      .select("id, coingecko_id")
      .in("id", assetIds)
      .is("deleted_at", null);

    if (assets && assets.length > 0) {
      const coinIds = assets.map((a) => a.coingecko_id).filter(Boolean);
      if (coinIds.length > 0) {
        const priceData = await getPrices(coinIds);
        for (const { side, assetId } of cryptoSides) {
          const asset = assets.find((a) => a.id === assetId);
          if (asset && priceData[asset.coingecko_id]) {
            prices[side].priceUsd = priceData[asset.coingecko_id].usd;
            prices[side].priceEur = priceData[asset.coingecko_id].eur;
          }
        }
      }
    }
  }

  // ── Stock prices ──
  const stockSides: { side: "source" | "destination"; assetId: string }[] = [];
  if (source.type === "stock_position") stockSides.push({ side: "source", assetId: source.assetId });
  if (destination.type === "stock_position") stockSides.push({ side: "destination", assetId: destination.assetId });

  if (stockSides.length > 0) {
    const assetIds = [...new Set(stockSides.map((s) => s.assetId))];
    const { data: assets } = await supabase
      .from("stock_assets")
      .select("id, yahoo_ticker, currency")
      .in("id", assetIds)
      .is("deleted_at", null);

    if (assets && assets.length > 0) {
      const tickers = assets
        .map((a) => a.yahoo_ticker)
        .filter((t): t is string => !!t);
      if (tickers.length > 0) {
        const priceData = await getStockPrices(tickers);
        for (const { side, assetId } of stockSides) {
          const asset = assets.find((a) => a.id === assetId);
          if (asset?.yahoo_ticker && priceData[asset.yahoo_ticker]) {
            prices[side].priceNative = priceData[asset.yahoo_ticker].price;
            prices[side].currency = priceData[asset.yahoo_ticker].currency;
          }
        }
      }
    }
  }

  return prices;
}

// ─── Execute Source Leg ──────────────────────────────────────

async function executeSourceLeg(
  source: TransferSide,
  originalState: SourceOriginalState,
  transferGroupId: string,
  prices: SidePrices,
  effectiveDate?: string
): Promise<void> {
  switch (source.type) {
    case "crypto_position": {
      if (originalState.type !== "crypto_position") throw new Error("State type mismatch");
      const newQty = originalState.quantity - source.quantity;
      await upsertPosition(
        {
          crypto_asset_id: source.assetId,
          wallet_id: source.walletId,
          quantity: newQty,
        },
        {
          isAdjustment: true,
          transferGroupId,
          currentPriceUsd: prices.priceUsd,
          currentPriceEur: prices.priceEur,
          effectiveDate,
        }
      );
      break;
    }
    case "stock_position": {
      if (originalState.type !== "stock_position") throw new Error("State type mismatch");
      const newQty = originalState.quantity - source.quantity;
      await upsertStockPosition(
        {
          stock_asset_id: source.assetId,
          broker_id: source.brokerId,
          quantity: newQty,
        },
        {
          isAdjustment: true,
          transferGroupId,
          currentPriceNative: prices.priceNative,
          assetCurrency: prices.currency,
          effectiveDate,
        }
      );
      break;
    }
    case "cash_account": {
      if (originalState.type !== "cash_account") throw new Error("State type mismatch");
      const newBalance = originalState.balance - source.amount;
      await updateCashAccount(
        originalState.id,
        { currency: originalState.currency, balance: newBalance },
        { isAdjustment: true, transferGroupId, effectiveDate }
      );
      break;
    }
  }
}

// ─── Execute Destination Leg ─────────────────────────────────

async function executeDestLeg(
  supabase: SupabaseClient,
  destination: TransferSide,
  transferGroupId: string | undefined,
  prices: SidePrices,
  userId: string,
  effectiveDate?: string
): Promise<void> {
  switch (destination.type) {
    case "crypto_position": {
      // Fetch current qty (may be 0 if new position)
      const { data: existing } = await supabase
        .from("crypto_positions")
        .select("quantity")
        .eq("crypto_asset_id", destination.assetId)
        .eq("wallet_id", destination.walletId)
        .is("deleted_at", null)
        .single();
      const currentQty = existing ? Number(existing.quantity) : 0;
      await upsertPosition(
        {
          crypto_asset_id: destination.assetId,
          wallet_id: destination.walletId,
          quantity: currentQty + destination.quantity,
        },
        {
          isAdjustment: true,
          transferGroupId,
          currentPriceUsd: prices.priceUsd,
          currentPriceEur: prices.priceEur,
          effectiveDate,
        }
      );
      break;
    }
    case "stock_position": {
      const { data: existing } = await supabase
        .from("stock_positions")
        .select("quantity")
        .eq("stock_asset_id", destination.assetId)
        .eq("broker_id", destination.brokerId)
        .is("deleted_at", null)
        .single();
      const currentQty = existing ? Number(existing.quantity) : 0;
      await upsertStockPosition(
        {
          stock_asset_id: destination.assetId,
          broker_id: destination.brokerId,
          quantity: currentQty + destination.quantity,
        },
        {
          isAdjustment: true,
          transferGroupId,
          currentPriceNative: prices.priceNative,
          assetCurrency: prices.currency,
          effectiveDate,
        }
      );
      break;
    }
    case "cash_account": {
      const { data: existing, error } = await supabase
        .from("cash_accounts")
        .select("id, balance, currency")
        .eq("id", destination.accountId)
        .eq("user_id", userId)
        .is("deleted_at", null)
        .single();
      if (error || !existing) throw new Error("Destination cash account not found");
      await updateCashAccount(
        existing.id,
        { currency: existing.currency, balance: Number(existing.balance) + destination.amount },
        { isAdjustment: true, transferGroupId, effectiveDate }
      );
      break;
    }
  }
}

// ─── Rollback Source ─────────────────────────────────────────

async function rollbackSource(
  source: TransferSide,
  originalState: SourceOriginalState,
  transferGroupId: string,
  prices: SidePrices,
  effectiveDate?: string
): Promise<void> {
  switch (source.type) {
    case "crypto_position": {
      if (originalState.type !== "crypto_position") throw new Error("State type mismatch");
      await upsertPosition(
        {
          crypto_asset_id: source.assetId,
          wallet_id: source.walletId,
          quantity: originalState.quantity,
        },
        {
          isAdjustment: true,
          transferGroupId,
          currentPriceUsd: prices.priceUsd,
          currentPriceEur: prices.priceEur,
          effectiveDate,
        }
      );
      break;
    }
    case "stock_position": {
      if (originalState.type !== "stock_position") throw new Error("State type mismatch");
      await upsertStockPosition(
        {
          stock_asset_id: source.assetId,
          broker_id: source.brokerId,
          quantity: originalState.quantity,
        },
        {
          isAdjustment: true,
          transferGroupId,
          currentPriceNative: prices.priceNative,
          assetCurrency: prices.currency,
          effectiveDate,
        }
      );
      break;
    }
    case "cash_account": {
      if (originalState.type !== "cash_account") throw new Error("State type mismatch");
      await updateCashAccount(
        originalState.id,
        { currency: originalState.currency, balance: originalState.balance },
        { isAdjustment: true, transferGroupId, effectiveDate }
      );
      break;
    }
  }
}

// ─── Cleanup Orphaned Entities ───────────────────────────────

/**
 * Hard-delete entities created during transfer setup after a failure.
 * Reverse iteration order: deposits before wallets/brokers (FK safety).
 * Also removes their activity_log entries to avoid dangling audit trail.
 * Best-effort: individual failures are logged and skipped.
 */
async function cleanupTransferEntities(
  supabase: SupabaseClient,
  entities: CreatedEntity[]
): Promise<void> {
  // Reverse order: deposits first, then wallets/brokers (FK constraints)
  for (let i = entities.length - 1; i >= 0; i--) {
    const { table, id } = entities[i];
    try {
      // Hard-delete the entity (just-created, no children/references)
      await supabase.from(table).delete().eq("id", id);
      // Remove its activity_log entry so no "Created X" log exists for a non-existent entity
      await supabase
        .from("activity_log")
        .delete()
        .eq("entity_id", id)
        .eq("entity_table", table);
    } catch (err) {
      console.warn(
        `[transfers] cleanup failed for ${table}/${id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
