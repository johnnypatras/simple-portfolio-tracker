/**
 * Portfolio aggregation — pure computation, no I/O.
 *
 * Takes all portfolio data sources and computes a unified summary
 * with everything converted to the user's base currency.
 */

import { convertToBase } from "@/lib/prices/fx";
import type { FXRates } from "@/lib/prices/fx";
import type {
  CryptoAssetWithPositions,
  CoinGeckoPriceData,
  StockAssetWithPositions,
  YahooStockPriceData,
  BankAccount,
  ExchangeDeposit,
} from "@/lib/types";

export interface PortfolioSummary {
  totalValue: number;
  cryptoValue: number;
  stocksValue: number;
  cashValue: number;
  change24hPercent: number;
  allocation: {
    crypto: number;
    stocks: number;
    cash: number;
  };
  primaryCurrency: string;

  // Dual-currency values for snapshot storage (DB stores both USD and EUR)
  totalValueUsd: number;
  totalValueEur: number;
  cryptoValueUsd: number;
  stocksValueUsd: number;
  cashValueUsd: number;
}

interface AggregateParams {
  cryptoAssets: CryptoAssetWithPositions[];
  cryptoPrices: CoinGeckoPriceData;
  stockAssets: StockAssetWithPositions[];
  stockPrices: YahooStockPriceData;
  bankAccounts: BankAccount[];
  exchangeDeposits: ExchangeDeposit[];
  primaryCurrency: string;
  fxRates: FXRates;
}

/**
 * Aggregate all portfolio data into a single summary.
 *
 * Crypto values use CoinGecko's native multi-currency support (usd/eur).
 * Stock values are converted via FX rates from their trading currency.
 * Cash (bank accounts + exchange deposits) is converted via FX rates.
 * 24h change is a value-weighted average of crypto + stock movements.
 */
export function aggregatePortfolio(params: AggregateParams): PortfolioSummary {
  const {
    cryptoAssets,
    cryptoPrices,
    stockAssets,
    stockPrices,
    bankAccounts,
    exchangeDeposits,
    primaryCurrency,
    fxRates,
  } = params;

  const currencyKey = primaryCurrency.toLowerCase() as "usd" | "eur";
  const changeKey = `${currencyKey}_24h_change` as "usd_24h_change" | "eur_24h_change";

  // ── Crypto ──────────────────────────────────────────────
  // CoinGecko gives us prices in both USD and EUR directly
  let cryptoValue = 0;
  let cryptoWeightedChange = 0; // sum of (value × change%)

  for (const asset of cryptoAssets) {
    const price = cryptoPrices[asset.coingecko_id];
    if (!price) continue;

    const priceInBase = price[currencyKey] ?? 0;
    const change = price[changeKey] ?? 0;
    const totalQty = asset.positions.reduce((sum, p) => sum + p.quantity, 0);
    const value = totalQty * priceInBase;

    cryptoValue += value;
    cryptoWeightedChange += value * change;
  }

  // ── Stocks & ETFs ───────────────────────────────────────
  // Yahoo gives prices in native trading currency → convert via FX
  let stocksValue = 0;
  let stocksWeightedChange = 0;

  for (const asset of stockAssets) {
    const key = asset.yahoo_ticker || asset.ticker;
    const priceData = stockPrices[key];
    if (!priceData) continue;

    const totalQty = asset.positions.reduce((sum, p) => sum + p.quantity, 0);
    const valueNative = totalQty * priceData.price;
    const valueBase = convertToBase(valueNative, asset.currency, primaryCurrency, fxRates);
    const change = priceData.change24h ?? 0;

    stocksValue += valueBase;
    stocksWeightedChange += valueBase * change;
  }

  // ── Cash (bank accounts + exchange deposits) ────────────
  let cashValue = 0;

  for (const bank of bankAccounts) {
    cashValue += convertToBase(bank.balance, bank.currency, primaryCurrency, fxRates);
  }

  for (const deposit of exchangeDeposits) {
    cashValue += convertToBase(deposit.amount, deposit.currency, primaryCurrency, fxRates);
  }

  // ── Totals ──────────────────────────────────────────────
  const totalValue = cryptoValue + stocksValue + cashValue;

  // Value-weighted 24h change (cash has 0% change → excluded from weighting)
  const investedValue = cryptoValue + stocksValue;
  const change24hPercent =
    investedValue > 0
      ? (cryptoWeightedChange + stocksWeightedChange) / investedValue
      : 0;

  // Allocation percentages
  const allocation =
    totalValue > 0
      ? {
          crypto: (cryptoValue / totalValue) * 100,
          stocks: (stocksValue / totalValue) * 100,
          cash: (cashValue / totalValue) * 100,
        }
      : { crypto: 0, stocks: 0, cash: 0 };

  // ── Dual-currency values for snapshot storage ─────────
  // The DB stores both USD and EUR. We compute both from the base values.
  // CoinGecko gives us both directly; for stocks/cash we use FX.
  let cryptoValueUsd = 0;
  let cryptoValueEur = 0;

  for (const asset of cryptoAssets) {
    const price = cryptoPrices[asset.coingecko_id];
    if (!price) continue;
    const totalQty = asset.positions.reduce((sum, p) => sum + p.quantity, 0);
    cryptoValueUsd += totalQty * (price.usd ?? 0);
    cryptoValueEur += totalQty * (price.eur ?? 0);
  }

  // For stocks and cash, convert base-currency values to the other currency
  const eurPerUsd = fxRates["EUR"] ?? 1; // rates are relative to primaryCurrency

  let stocksValueUsd: number;
  let stocksValueEur: number;
  let cashValueUsd: number;
  let cashValueEur: number;

  if (primaryCurrency === "USD") {
    stocksValueUsd = stocksValue;
    stocksValueEur = stocksValue * eurPerUsd;
    cashValueUsd = cashValue;
    cashValueEur = cashValue * eurPerUsd;
  } else {
    // primaryCurrency is EUR; fxRates["USD"] = USD per 1 EUR
    const usdPerEur = fxRates["USD"] ?? 1;
    stocksValueEur = stocksValue;
    stocksValueUsd = stocksValue * usdPerEur;
    cashValueEur = cashValue;
    cashValueUsd = cashValue * usdPerEur;
  }

  return {
    totalValue,
    cryptoValue,
    stocksValue,
    cashValue,
    change24hPercent,
    allocation,
    primaryCurrency,
    totalValueUsd: cryptoValueUsd + stocksValueUsd + cashValueUsd,
    totalValueEur: cryptoValueEur + stocksValueEur + cashValueEur,
    cryptoValueUsd,
    stocksValueUsd,
    cashValueUsd,
  };
}
