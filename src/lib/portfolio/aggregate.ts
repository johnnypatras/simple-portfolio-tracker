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
  BrokerDeposit,
} from "@/lib/types";

export interface PortfolioSummary {
  totalValue: number;
  cryptoValue: number;       // excludes stablecoins
  stocksValue: number;
  cashValue: number;          // includes stablecoins
  stablecoinValue: number;    // stablecoins only (subset of cashValue)
  change24hPercent: number;
  /** FX-only component of the 24h change (subset of change24hPercent).
   *  Shows how much of the total change is due to EUR/USD movement. */
  fxChange24hPercent: number;
  allocation: {
    crypto: number;
    stocks: number;
    cash: number;
  };
  primaryCurrency: string;

  // Absolute 24h value changes — components sum exactly to totalValueChange24h.
  // Computed as weightedChange / 100 (linear approximation, perfectly additive).
  totalValueChange24h: number;
  cryptoValueChange24h: number;
  stocksValueChange24h: number;
  stablecoinValueChange24h: number;
  cashFxValueChange24h: number;   // FX-only impact on fiat cash (bank + exchange + broker deposits)
  fxValueChange24h: number;       // total FX-only impact (stocks FX + stablecoin FX + fiat cash FX)

  // Per-class FX-only 24h values (for EUR/USD sub-lines on each sub-card)
  cryptoFxValueChange24h: number;       // FX component embedded in CoinGecko's EUR prices
  cryptoFxChange24hPercent: number;
  stocksFxValueChange24h: number;       // FX on foreign-currency stocks
  stocksFxChange24hPercent: number;
  // Cash total: stablecoin full change + fiat cash FX (for the cash card's 24h display)
  cashTotalValueChange24h: number;
  cashTotalFxValueChange24h: number;    // stablecoin FX + fiat cash FX
  cashTotalFxChange24hPercent: number;

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
  brokerDeposits: BrokerDeposit[];
  primaryCurrency: string;
  fxRates: FXRates;
  /** 24h change in EUR/USD (% — e.g. +0.5 means EUR gained 0.5% vs USD).
   *  Used to include FX impact on foreign-currency stocks, cash, and stablecoins. */
  eurUsdChange24h?: number;
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
    brokerDeposits,
    primaryCurrency,
    fxRates,
    eurUsdChange24h = 0,
  } = params;

  const currencyKey = primaryCurrency.toLowerCase() as "usd" | "eur";
  const changeKey = `${currencyKey}_24h_change` as "usd_24h_change" | "eur_24h_change";

  // FX impact: when primary currency is EUR and assets are in USD, a move in
  // EUR/USD changes their EUR value.  EUR/USD going up means EUR strengthened
  // → USD assets lost value in EUR terms → the FX impact is negative.
  // Conversely for a USD user with EUR assets.
  // For non-EUR/USD pairs we don't have 24h change data, so FX impact = 0.
  function fxChangeForCurrency(assetCurrency: string): number {
    if (assetCurrency === primaryCurrency) return 0;
    if (primaryCurrency === "EUR" && assetCurrency === "USD") return -eurUsdChange24h;
    if (primaryCurrency === "USD" && assetCurrency === "EUR") return eurUsdChange24h;
    return 0;
  }

  // ── Crypto (stablecoins separated → reclassified as cash) ──
  // CoinGecko gives us prices in both USD and EUR directly
  let cryptoValue = 0;
  let cryptoWeightedChange = 0; // sum of (value × change%)
  let cryptoFxWeightedChange = 0; // FX-only portion (eur_change - usd_change)
  let stablecoinValue = 0;
  let stablecoinWeightedChange = 0;    // full return (CoinGecko's changeKey)
  let stablecoinFxWeightedChange = 0;  // FX-only portion (for the FX sub-line)

  for (const asset of cryptoAssets) {
    const price = cryptoPrices[asset.coingecko_id];
    if (!price) continue;

    const priceInBase = price[currencyKey] ?? 0;
    const totalQty = asset.positions.reduce((sum, p) => sum + p.quantity, 0);
    const value = totalQty * priceInBase;

    if (asset.subcategory?.toLowerCase() === "stablecoin") {
      stablecoinValue += value;
      // Full return from CoinGecko (includes both price deviation + FX)
      const stableChange = price[changeKey] ?? 0;
      stablecoinWeightedChange += value * stableChange;
      // FX-only: stablecoins are USD-pegged → their FX exposure = EUR/USD change
      stablecoinFxWeightedChange += value * fxChangeForCurrency("USD");
    } else {
      const change = price[changeKey] ?? 0;
      cryptoValue += value;
      cryptoWeightedChange += value * change;
      // FX component: difference between base-currency return and USD return.
      // For USD users this is 0; for EUR users it captures EUR/USD impact.
      const usdChange = price.usd_24h_change ?? 0;
      cryptoFxWeightedChange += value * (change - usdChange);
    }
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
    // Total change in primary currency ≈ asset price change + FX change
    const change = (priceData.change24h ?? 0) + fxChangeForCurrency(asset.currency);

    stocksValue += valueBase;
    stocksWeightedChange += valueBase * change;
  }

  // ── Cash (bank accounts + exchange deposits + broker deposits) ──
  let cashValue = 0;
  let fiatCashWeightedChange = 0; // FX-only change for foreign-currency cash

  for (const bank of bankAccounts) {
    const valueBase = convertToBase(bank.balance, bank.currency, primaryCurrency, fxRates);
    cashValue += valueBase;
    fiatCashWeightedChange += valueBase * fxChangeForCurrency(bank.currency);
  }

  for (const deposit of exchangeDeposits) {
    const valueBase = convertToBase(deposit.amount, deposit.currency, primaryCurrency, fxRates);
    cashValue += valueBase;
    fiatCashWeightedChange += valueBase * fxChangeForCurrency(deposit.currency);
  }

  for (const deposit of brokerDeposits) {
    const valueBase = convertToBase(deposit.amount, deposit.currency, primaryCurrency, fxRates);
    cashValue += valueBase;
    fiatCashWeightedChange += valueBase * fxChangeForCurrency(deposit.currency);
  }

  // Add stablecoins to cash
  cashValue += stablecoinValue;

  // ── Totals ──────────────────────────────────────────────
  const totalValue = cryptoValue + stocksValue + cashValue;

  // Value-weighted 24h change across the entire portfolio.
  // Includes: crypto price changes, stock price changes + FX, stablecoin FX,
  // and fiat cash FX.  Denominator is totalValue (cash acts as drag/boost).
  const totalWeightedChange =
    cryptoWeightedChange + stocksWeightedChange + stablecoinWeightedChange + fiatCashWeightedChange;
  const change24hPercent =
    totalValue > 0 ? totalWeightedChange / totalValue : 0;

  // FX-only component: how much of the 24h change is attributable to EUR/USD.
  // Each asset class contributes its FX-only portion:
  // - Stocks: fxChangeForCurrency(stock.currency) per stock
  // - Stablecoins: fxChangeForCurrency("USD") — precise, excludes tiny price deviation
  // - Fiat cash: fxChangeForCurrency(account.currency) — pure FX
  const stocksFxWeightedChange = stockAssets.reduce((sum, asset) => {
    const key = asset.yahoo_ticker || asset.ticker;
    const priceData = stockPrices[key];
    if (!priceData) return sum;
    const totalQty = asset.positions.reduce((s, p) => s + p.quantity, 0);
    const valueBase = convertToBase(totalQty * priceData.price, asset.currency, primaryCurrency, fxRates);
    return sum + valueBase * fxChangeForCurrency(asset.currency);
  }, 0);
  const fxWeightedChange = cryptoFxWeightedChange + stocksFxWeightedChange + stablecoinFxWeightedChange + fiatCashWeightedChange;
  const fxChange24hPercent =
    totalValue > 0 ? fxWeightedChange / totalValue : 0;

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
  let stablecoinValueUsd = 0;
  let stablecoinValueEur = 0;

  for (const asset of cryptoAssets) {
    const price = cryptoPrices[asset.coingecko_id];
    if (!price) continue;
    const totalQty = asset.positions.reduce((sum, p) => sum + p.quantity, 0);
    if (asset.subcategory?.toLowerCase() === "stablecoin") {
      stablecoinValueUsd += totalQty * (price.usd ?? 0);
      stablecoinValueEur += totalQty * (price.eur ?? 0);
    } else {
      cryptoValueUsd += totalQty * (price.usd ?? 0);
      cryptoValueEur += totalQty * (price.eur ?? 0);
    }
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
    // Cash (excluding stablecoins which have their own CoinGecko rates)
    cashValueUsd = (cashValue - stablecoinValue) + stablecoinValueUsd;
    cashValueEur = (cashValue - stablecoinValue) * eurPerUsd + stablecoinValueEur;
  } else {
    // primaryCurrency is EUR; fxRates["USD"] = USD per 1 EUR
    const usdPerEur = fxRates["USD"] ?? 1;
    stocksValueEur = stocksValue;
    stocksValueUsd = stocksValue * usdPerEur;
    cashValueEur = (cashValue - stablecoinValue) + stablecoinValueEur;
    cashValueUsd = (cashValue - stablecoinValue) * usdPerEur + stablecoinValueUsd;
  }

  return {
    totalValue,
    cryptoValue,
    stocksValue,
    cashValue,
    stablecoinValue,
    change24hPercent,
    fxChange24hPercent,
    allocation,
    primaryCurrency,
    // Absolute 24h deltas — weightedChange / 100, perfectly additive
    totalValueChange24h: totalWeightedChange / 100,
    cryptoValueChange24h: cryptoWeightedChange / 100,
    stocksValueChange24h: stocksWeightedChange / 100,
    stablecoinValueChange24h: stablecoinWeightedChange / 100,
    cashFxValueChange24h: fiatCashWeightedChange / 100,
    fxValueChange24h: fxWeightedChange / 100,
    // Per-class FX-only 24h values
    cryptoFxValueChange24h: cryptoFxWeightedChange / 100,
    cryptoFxChange24hPercent: cryptoValue > 0 ? cryptoFxWeightedChange / cryptoValue : 0,
    stocksFxValueChange24h: stocksFxWeightedChange / 100,
    stocksFxChange24hPercent: stocksValue > 0 ? stocksFxWeightedChange / stocksValue : 0,
    cashTotalValueChange24h: (stablecoinWeightedChange + fiatCashWeightedChange) / 100,
    cashTotalFxValueChange24h: (stablecoinFxWeightedChange + fiatCashWeightedChange) / 100,
    cashTotalFxChange24hPercent: cashValue > 0 ? (stablecoinFxWeightedChange + fiatCashWeightedChange) / cashValue : 0,
    // Dual-currency values for snapshot storage
    totalValueUsd: cryptoValueUsd + stocksValueUsd + cashValueUsd,
    totalValueEur: cryptoValueEur + stocksValueEur + cashValueEur,
    cryptoValueUsd,
    stocksValueUsd,
    cashValueUsd,
  };
}
