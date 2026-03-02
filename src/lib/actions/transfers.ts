"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { upsertPosition, createCryptoAsset } from "@/lib/actions/crypto";
import {
  upsertStockPosition,
  createStockAsset,
} from "@/lib/actions/stocks";
import {
  createExchangeDeposit,
  updateExchangeDeposit,
} from "@/lib/actions/exchange-deposits";
import {
  createBrokerDeposit,
  updateBrokerDeposit,
} from "@/lib/actions/broker-deposits";
import { updateBankAccount } from "@/lib/actions/bank-accounts";
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

// ─── Types for internal state tracking ───────────────────────

/** Original state captured before source leg, used for rollback */
type SourceOriginalState =
  | { type: "crypto_position"; quantity: number }
  | { type: "stock_position"; quantity: number }
  | { type: "exchange_deposit"; id: string; amount: number }
  | { type: "broker_deposit"; id: string; amount: number }
  | { type: "bank_account"; id: string; balance: number; name: string; bank_name: string; currency: string };

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

  // Use a local destination variable to avoid mutating input
  let destination: TransferSide = input.destination;

  try {
    // ── Step 0: Create inline entities for buy mode ──────
    // Use a mutable copy of input so we can patch source IDs
    let currentSource = input.source;

    if (input.newBroker) {
      const brokerId = await createBroker({ name: input.newBroker.name });
      if (destination.type === "stock_position") {
        destination = { ...destination, brokerId };
      }
      if (currentSource?.type === "broker_deposit") {
        currentSource = { ...currentSource, brokerId };
      }
    }

    if (input.newWallet) {
      const walletId = await createWallet({
        name: input.newWallet.name,
        wallet_type: "custodial",
      });
      if (destination.type === "crypto_position") {
        destination = { ...destination, walletId };
      }
      if (currentSource?.type === "exchange_deposit") {
        currentSource = { ...currentSource, walletId };
      }
    }

    if (input.newCashDeposit && currentSource) {
      if (currentSource.type === "broker_deposit") {
        await createBrokerDeposit(
          {
            broker_id: currentSource.brokerId,
            currency: input.newCashDeposit.currency,
            amount: input.newCashDeposit.amount,
          },
          {
            isAdjustment: input.newCashDeposit.isAdjustment,
            effectiveDate: input.effectiveDate,
          }
        );
      } else if (currentSource.type === "exchange_deposit") {
        await createExchangeDeposit(
          {
            wallet_id: currentSource.walletId,
            currency: input.newCashDeposit.currency,
            amount: input.newCashDeposit.amount,
          },
          {
            isAdjustment: input.newCashDeposit.isAdjustment,
            effectiveDate: input.effectiveDate,
          }
        );
      }
    }

    const transferGroupId = currentSource ? crypto.randomUUID() : "";

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

    // ── Steps 2–5: Source leg (skip for single-legged buy) ──
    let originalState: SourceOriginalState | null = null;
    let prices: TransferPrices = { source: {}, destination: {} };

    if (currentSource) {
      originalState = await fetchSourceState(supabase, currentSource);
      validateSufficientBalance(currentSource, originalState);
      prices = await fetchPrices(supabase, currentSource, destination);
      await executeSourceLeg(currentSource, originalState, transferGroupId, prices.source, input.effectiveDate);
    }

    // ── Step 6: Execute destination leg (increase) with retry + rollback
    try {
      await executeDestLeg(supabase, destination, transferGroupId || undefined, prices.destination, input.effectiveDate);
    } catch (destErr) {
      if (currentSource && originalState) {
        // Retry once
        try {
          await executeDestLeg(supabase, destination, transferGroupId, prices.destination, input.effectiveDate);
        } catch (retryErr) {
          // Rollback source: restore to original state
          try {
            await rollbackSource(currentSource, originalState, transferGroupId, prices.source, input.effectiveDate);
          } catch (rollbackErr) {
            return {
              success: false,
              error: `Transfer failed and rollback failed. Source was modified. Original: ${JSON.stringify(originalState)}. Rollback error: ${rollbackErr instanceof Error ? rollbackErr.message : "unknown"}. Check positions.`,
              transferGroupId,
              partialFailure: true,
            };
          }
          const finalErr = retryErr instanceof Error ? retryErr.message : destErr instanceof Error ? destErr.message : "Destination leg failed";
          return {
            success: false,
            error: finalErr,
            transferGroupId,
          };
        }
      } else {
        // Single-legged buy: no rollback needed
        return {
          success: false,
          error: destErr instanceof Error ? destErr.message : "Failed to create position",
        };
      }
    }

    // ── Step 7: Revalidate and return ───────────────────────
    revalidatePath("/dashboard/accounts");
    revalidatePath("/dashboard");

    return { success: true, transferGroupId };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Transfer failed",
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
    case "exchange_deposit":
      if (state.type === "exchange_deposit" && source.amount > state.amount) {
        throw new Error(`Insufficient exchange deposit: have ${state.amount}, need ${source.amount}`);
      }
      break;
    case "broker_deposit":
      if (state.type === "broker_deposit" && source.amount > state.amount) {
        throw new Error(`Insufficient broker deposit: have ${state.amount}, need ${source.amount}`);
      }
      break;
    case "bank_account":
      if (state.type === "bank_account" && source.amount > state.balance) {
        throw new Error(`Insufficient bank balance: have ${state.balance}, need ${source.amount}`);
      }
      break;
  }
}

// ─── Fetch Source State ──────────────────────────────────────

async function fetchSourceState(
  supabase: SupabaseClient,
  source: TransferSide
): Promise<SourceOriginalState> {
  switch (source.type) {
    case "crypto_position": {
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
    case "exchange_deposit": {
      const { data, error } = await supabase
        .from("exchange_deposits")
        .select("id, amount")
        .eq("wallet_id", source.walletId)
        .eq("currency", source.currency)
        .is("deleted_at", null)
        .single();
      if (error || !data) throw new Error(`Source exchange deposit not found: ${error?.message ?? "no data"}`);
      return { type: "exchange_deposit", id: data.id, amount: Number(data.amount) };
    }
    case "broker_deposit": {
      const { data, error } = await supabase
        .from("broker_deposits")
        .select("id, amount")
        .eq("broker_id", source.brokerId)
        .eq("currency", source.currency)
        .is("deleted_at", null)
        .single();
      if (error || !data) throw new Error(`Source broker deposit not found: ${error?.message ?? "no data"}`);
      return { type: "broker_deposit", id: data.id, amount: Number(data.amount) };
    }
    case "bank_account": {
      const { data, error } = await supabase
        .from("bank_accounts")
        .select("id, balance, name, bank_name, currency")
        .eq("id", source.accountId)
        .is("deleted_at", null)
        .single();
      if (error || !data) throw new Error(`Source bank account not found: ${error?.message ?? "no data"}`);
      return {
        type: "bank_account",
        id: data.id,
        balance: Number(data.balance),
        name: data.name,
        bank_name: data.bank_name,
        currency: data.currency,
      };
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
    case "exchange_deposit": {
      if (originalState.type !== "exchange_deposit") throw new Error("State type mismatch");
      const newAmount = originalState.amount - source.amount;
      await updateExchangeDeposit(
        originalState.id,
        {
          wallet_id: source.walletId,
          currency: source.currency,
          amount: newAmount,
        },
        { isAdjustment: true, transferGroupId, effectiveDate }
      );
      break;
    }
    case "broker_deposit": {
      if (originalState.type !== "broker_deposit") throw new Error("State type mismatch");
      const newAmount = originalState.amount - source.amount;
      await updateBrokerDeposit(
        originalState.id,
        {
          broker_id: source.brokerId,
          currency: source.currency,
          amount: newAmount,
        },
        { isAdjustment: true, transferGroupId, effectiveDate }
      );
      break;
    }
    case "bank_account": {
      if (originalState.type !== "bank_account") throw new Error("State type mismatch");
      const newBalance = originalState.balance - source.amount;
      await updateBankAccount(
        originalState.id,
        {
          name: originalState.name,
          bank_name: originalState.bank_name,
          currency: originalState.currency,
          balance: newBalance,
        },
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
    case "exchange_deposit": {
      const { data: existing } = await supabase
        .from("exchange_deposits")
        .select("id, amount")
        .eq("wallet_id", destination.walletId)
        .eq("currency", destination.currency)
        .is("deleted_at", null)
        .single();

      if (existing) {
        await updateExchangeDeposit(
          existing.id,
          {
            wallet_id: destination.walletId,
            currency: destination.currency,
            amount: Number(existing.amount) + destination.amount,
          },
          { isAdjustment: true, transferGroupId, effectiveDate }
        );
      } else {
        await createExchangeDeposit(
          {
            wallet_id: destination.walletId,
            currency: destination.currency,
            amount: destination.amount,
          },
          { isAdjustment: true, transferGroupId, effectiveDate }
        );
      }
      break;
    }
    case "broker_deposit": {
      const { data: existing } = await supabase
        .from("broker_deposits")
        .select("id, amount")
        .eq("broker_id", destination.brokerId)
        .eq("currency", destination.currency)
        .is("deleted_at", null)
        .single();

      if (existing) {
        await updateBrokerDeposit(
          existing.id,
          {
            broker_id: destination.brokerId,
            currency: destination.currency,
            amount: Number(existing.amount) + destination.amount,
          },
          { isAdjustment: true, transferGroupId, effectiveDate }
        );
      } else {
        await createBrokerDeposit(
          {
            broker_id: destination.brokerId,
            currency: destination.currency,
            amount: destination.amount,
          },
          { isAdjustment: true, transferGroupId, effectiveDate }
        );
      }
      break;
    }
    case "bank_account": {
      const { data: existing, error } = await supabase
        .from("bank_accounts")
        .select("id, balance, name, bank_name, currency")
        .eq("id", destination.accountId)
        .is("deleted_at", null)
        .single();
      if (error || !existing) throw new Error("Destination bank account not found");
      await updateBankAccount(
        destination.accountId,
        {
          name: existing.name,
          bank_name: existing.bank_name,
          currency: existing.currency,
          balance: Number(existing.balance) + destination.amount,
        },
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
    case "exchange_deposit": {
      if (originalState.type !== "exchange_deposit") throw new Error("State type mismatch");
      await updateExchangeDeposit(
        originalState.id,
        {
          wallet_id: source.walletId,
          currency: source.currency,
          amount: originalState.amount,
        },
        { isAdjustment: true, transferGroupId, effectiveDate }
      );
      break;
    }
    case "broker_deposit": {
      if (originalState.type !== "broker_deposit") throw new Error("State type mismatch");
      await updateBrokerDeposit(
        originalState.id,
        {
          broker_id: source.brokerId,
          currency: source.currency,
          amount: originalState.amount,
        },
        { isAdjustment: true, transferGroupId, effectiveDate }
      );
      break;
    }
    case "bank_account": {
      if (originalState.type !== "bank_account") throw new Error("State type mismatch");
      await updateBankAccount(
        originalState.id,
        {
          name: originalState.name,
          bank_name: originalState.bank_name,
          currency: originalState.currency,
          balance: originalState.balance,
        },
        { isAdjustment: true, transferGroupId, effectiveDate }
      );
      break;
    }
  }
}
