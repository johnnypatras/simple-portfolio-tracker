"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
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
import { getPrices } from "@/lib/prices/coingecko";
import { getStockPrices } from "@/lib/prices/yahoo";
import type {
  TransferInput,
  TransferResult,
  TransferSide,
} from "@/lib/types";

// ─── Types for internal state tracking ───────────────────────

/** Original state captured before source leg, used for rollback */
type SourceOriginalState =
  | { type: "crypto_position"; quantity: number }
  | { type: "stock_position"; quantity: number }
  | { type: "exchange_deposit"; id: string; amount: number }
  | { type: "broker_deposit"; id: string; amount: number }
  | { type: "bank_account"; id: string; balance: number; name: string; bank_name: string; currency: string };

/** Prices fetched for delta calculation */
interface TransferPrices {
  cryptoPriceUsd?: number;
  cryptoPriceEur?: number;
  stockPriceNative?: number;
  stockCurrency?: string;
}

// ─── Main Transfer Action ────────────────────────────────────

export async function executeTransfer(input: TransferInput): Promise<TransferResult> {
  // Authenticate
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const transferGroupId = crypto.randomUUID();
  const admin = createAdminClient();

  try {
    // ── Step 1: Create new assets if needed ─────────────────
    if (input.newCryptoAsset) {
      const newAssetId = await createCryptoAsset(input.newCryptoAsset);
      // Patch destination with the newly created asset ID
      if (input.destination.type === "crypto_position") {
        (input.destination as { assetId: string }).assetId = newAssetId;
      }
    }
    if (input.newStockAsset) {
      const newAssetId = await createStockAsset(input.newStockAsset);
      // Patch destination with the newly created asset ID
      if (input.destination.type === "stock_position") {
        (input.destination as { assetId: string }).assetId = newAssetId;
      }
    }

    // ── Step 2: Fetch current state of source entity ────────
    const originalState = await fetchSourceState(admin, user.id, input.source);

    // ── Step 3: Fetch current prices for delta calculation ──
    const prices = await fetchPrices(admin, user.id, input.source, input.destination);

    // ── Step 4: Execute source leg (reduce) ─────────────────
    await executeSourceLeg(admin, user.id, input.source, originalState, transferGroupId, prices);

    // ── Step 5: Execute destination leg (increase) with retry + rollback
    try {
      await executeDestLeg(admin, user.id, input.destination, transferGroupId, prices);
    } catch (destErr) {
      // Retry once
      try {
        await executeDestLeg(admin, user.id, input.destination, transferGroupId, prices);
      } catch {
        // Rollback source: restore to original state
        try {
          await rollbackSource(admin, user.id, input.source, originalState, transferGroupId, prices);
        } catch (rollbackErr) {
          return {
            success: false,
            error: `Transfer failed and rollback failed. Source was modified. Original: ${JSON.stringify(originalState)}. Rollback error: ${rollbackErr instanceof Error ? rollbackErr.message : "unknown"}. Check positions.`,
            transferGroupId,
            partialFailure: true,
          };
        }
        return {
          success: false,
          error: destErr instanceof Error ? destErr.message : "Destination leg failed",
          transferGroupId,
        };
      }
    }

    // ── Step 6: Revalidate and return ───────────────────────
    revalidatePath("/dashboard/accounts");
    revalidatePath("/dashboard");

    return { success: true, transferGroupId };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Transfer failed",
      transferGroupId,
    };
  }
}

// ─── Fetch Source State ──────────────────────────────────────

async function fetchSourceState(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  source: TransferSide
): Promise<SourceOriginalState> {
  switch (source.type) {
    case "crypto_position": {
      const { data } = await admin
        .from("crypto_positions")
        .select("quantity, crypto_asset_id, wallet_id")
        .eq("crypto_asset_id", source.assetId)
        .eq("wallet_id", source.walletId)
        .is("deleted_at", null)
        .single();
      if (!data) throw new Error("Source crypto position not found");
      return { type: "crypto_position", quantity: Number(data.quantity) };
    }
    case "stock_position": {
      const { data } = await admin
        .from("stock_positions")
        .select("quantity, stock_asset_id, broker_id")
        .eq("stock_asset_id", source.assetId)
        .eq("broker_id", source.brokerId)
        .is("deleted_at", null)
        .single();
      if (!data) throw new Error("Source stock position not found");
      return { type: "stock_position", quantity: Number(data.quantity) };
    }
    case "exchange_deposit": {
      const { data } = await admin
        .from("exchange_deposits")
        .select("id, amount")
        .eq("wallet_id", source.walletId)
        .eq("currency", source.currency)
        .is("deleted_at", null)
        .single();
      if (!data) throw new Error("Source exchange deposit not found");
      return { type: "exchange_deposit", id: data.id, amount: Number(data.amount) };
    }
    case "broker_deposit": {
      const { data } = await admin
        .from("broker_deposits")
        .select("id, amount")
        .eq("broker_id", source.brokerId)
        .eq("currency", source.currency)
        .is("deleted_at", null)
        .single();
      if (!data) throw new Error("Source broker deposit not found");
      return { type: "broker_deposit", id: data.id, amount: Number(data.amount) };
    }
    case "bank_account": {
      const { data } = await admin
        .from("bank_accounts")
        .select("id, balance, name, bank_name, currency")
        .eq("id", source.accountId)
        .eq("user_id", userId)
        .is("deleted_at", null)
        .single();
      if (!data) throw new Error("Source bank account not found");
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
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  source: TransferSide,
  destination: TransferSide
): Promise<TransferPrices> {
  const prices: TransferPrices = {};

  // Collect all crypto asset IDs we need prices for
  const cryptoAssetIds: string[] = [];
  if (source.type === "crypto_position") cryptoAssetIds.push(source.assetId);
  if (destination.type === "crypto_position") cryptoAssetIds.push(destination.assetId);

  if (cryptoAssetIds.length > 0) {
    // Look up coingecko_ids from crypto_assets table
    const { data: assets } = await admin
      .from("crypto_assets")
      .select("id, coingecko_id")
      .in("id", cryptoAssetIds)
      .is("deleted_at", null);

    if (assets && assets.length > 0) {
      const coinIds = assets.map((a) => a.coingecko_id).filter(Boolean);
      if (coinIds.length > 0) {
        const priceData = await getPrices(coinIds);
        // Use the source crypto price if available, else destination
        const sourceAsset = assets.find(
          (a) => source.type === "crypto_position" && a.id === source.assetId
        );
        if (sourceAsset && priceData[sourceAsset.coingecko_id]) {
          prices.cryptoPriceUsd = priceData[sourceAsset.coingecko_id].usd;
          prices.cryptoPriceEur = priceData[sourceAsset.coingecko_id].eur;
        } else {
          // Fall back to destination crypto price
          const destAsset = assets.find(
            (a) => destination.type === "crypto_position" && a.id === destination.assetId
          );
          if (destAsset && priceData[destAsset.coingecko_id]) {
            prices.cryptoPriceUsd = priceData[destAsset.coingecko_id].usd;
            prices.cryptoPriceEur = priceData[destAsset.coingecko_id].eur;
          }
        }
      }
    }
  }

  // Collect all stock asset IDs we need prices for
  const stockAssetIds: string[] = [];
  if (source.type === "stock_position") stockAssetIds.push(source.assetId);
  if (destination.type === "stock_position") stockAssetIds.push(destination.assetId);

  if (stockAssetIds.length > 0) {
    const { data: assets } = await admin
      .from("stock_assets")
      .select("id, yahoo_ticker, currency")
      .in("id", stockAssetIds)
      .is("deleted_at", null);

    if (assets && assets.length > 0) {
      const tickers = assets
        .map((a) => a.yahoo_ticker)
        .filter((t): t is string => !!t);
      if (tickers.length > 0) {
        const priceData = await getStockPrices(tickers);
        // Use source stock's price if available, else destination's
        const sourceAsset = assets.find(
          (a) => source.type === "stock_position" && a.id === source.assetId
        );
        if (sourceAsset?.yahoo_ticker && priceData[sourceAsset.yahoo_ticker]) {
          prices.stockPriceNative = priceData[sourceAsset.yahoo_ticker].price;
          prices.stockCurrency = priceData[sourceAsset.yahoo_ticker].currency;
        } else {
          const destAsset = assets.find(
            (a) => destination.type === "stock_position" && a.id === destination.assetId
          );
          if (destAsset?.yahoo_ticker && priceData[destAsset.yahoo_ticker]) {
            prices.stockPriceNative = priceData[destAsset.yahoo_ticker].price;
            prices.stockCurrency = priceData[destAsset.yahoo_ticker].currency;
          }
        }
      }
    }
  }

  return prices;
}

// ─── Execute Source Leg ──────────────────────────────────────

async function executeSourceLeg(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  source: TransferSide,
  originalState: SourceOriginalState,
  transferGroupId: string,
  prices: TransferPrices
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
          currentPriceUsd: prices.cryptoPriceUsd,
          currentPriceEur: prices.cryptoPriceEur,
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
          currentPriceNative: prices.stockPriceNative,
          assetCurrency: prices.stockCurrency,
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
        { isAdjustment: true, transferGroupId }
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
        { isAdjustment: true, transferGroupId }
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
        { isAdjustment: true, transferGroupId }
      );
      break;
    }
  }
}

// ─── Execute Destination Leg ─────────────────────────────────

async function executeDestLeg(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  destination: TransferSide,
  transferGroupId: string,
  prices: TransferPrices
): Promise<void> {
  switch (destination.type) {
    case "crypto_position": {
      // upsertPosition handles create-or-update automatically
      // First fetch current qty (may be 0 if new position)
      const { data: existing } = await admin
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
          currentPriceUsd: prices.cryptoPriceUsd,
          currentPriceEur: prices.cryptoPriceEur,
        }
      );
      break;
    }
    case "stock_position": {
      // upsertStockPosition handles create-or-update automatically
      const { data: existing } = await admin
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
          currentPriceNative: prices.stockPriceNative,
          assetCurrency: prices.stockCurrency,
        }
      );
      break;
    }
    case "exchange_deposit": {
      // Check if destination exchange deposit exists
      const { data: existing } = await admin
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
          { isAdjustment: true, transferGroupId }
        );
      } else {
        await createExchangeDeposit(
          {
            wallet_id: destination.walletId,
            currency: destination.currency,
            amount: destination.amount,
          },
          { isAdjustment: true, transferGroupId }
        );
      }
      break;
    }
    case "broker_deposit": {
      // Check if destination broker deposit exists
      const { data: existing } = await admin
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
          { isAdjustment: true, transferGroupId }
        );
      } else {
        await createBrokerDeposit(
          {
            broker_id: destination.brokerId,
            currency: destination.currency,
            amount: destination.amount,
          },
          { isAdjustment: true, transferGroupId }
        );
      }
      break;
    }
    case "bank_account": {
      // Bank accounts always exist (we just update the balance)
      const { data: existing } = await admin
        .from("bank_accounts")
        .select("id, balance, name, bank_name, currency")
        .eq("id", destination.accountId)
        .eq("user_id", userId)
        .is("deleted_at", null)
        .single();
      if (!existing) throw new Error("Destination bank account not found");
      await updateBankAccount(
        destination.accountId,
        {
          name: existing.name,
          bank_name: existing.bank_name,
          currency: existing.currency,
          balance: Number(existing.balance) + destination.amount,
        },
        { isAdjustment: true, transferGroupId }
      );
      break;
    }
  }
}

// ─── Rollback Source ─────────────────────────────────────────

async function rollbackSource(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  source: TransferSide,
  originalState: SourceOriginalState,
  transferGroupId: string,
  prices: TransferPrices
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
          currentPriceUsd: prices.cryptoPriceUsd,
          currentPriceEur: prices.cryptoPriceEur,
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
          currentPriceNative: prices.stockPriceNative,
          assetCurrency: prices.stockCurrency,
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
        { isAdjustment: true, transferGroupId }
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
        { isAdjustment: true, transferGroupId }
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
        { isAdjustment: true, transferGroupId }
      );
      break;
    }
  }
}
