/**
 * Portfolio aggregation — pure computation, no I/O.
 *
 * Takes all portfolio data sources and computes a unified summary
 * with everything converted to the user's base currency.
 */

import { convertToBase, fxChangeForCurrency as fxChangeFor } from "@/lib/prices/fx";
import { isStablecoin } from "@/lib/cashflow";
import type { FXRates } from "@/lib/prices/fx";
import type {
  CryptoAssetWithPositions,
  CoinGeckoPriceData,
  StockAssetWithPositions,
  YahooStockPriceData,
  CashAccount,
  BaseCurrency,
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
  primaryCurrency: BaseCurrency;

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
  cryptoValueEur: number;
  stocksValueUsd: number;
  stocksValueEur: number;
  cashValueUsd: number;
  cashValueEur: number;

  // EUR value of positions denominated in the user's home currency (zero FX sensitivity)
  stocksHomeCurrencyEur: number;
  cashHomeCurrencyEur: number;
}

interface AggregateParams {
  cryptoAssets: CryptoAssetWithPositions[];
  cryptoPrices: CoinGeckoPriceData;
  stockAssets: StockAssetWithPositions[];
  stockPrices: YahooStockPriceData;
  cashAccounts: CashAccount[];
  primaryCurrency: BaseCurrency;
  fxRates: FXRates;
  /** Dual FX rate sets for accurate snapshot storage.
   *  fxRatesUsd: rates relative to USD (for computing *_value_usd columns).
   *  fxRatesEur: rates relative to EUR (for computing *_value_eur columns).
   *  If omitted, falls back to cross-conversion via primaryCurrency (legacy). */
  fxRatesUsd?: FXRates;
  fxRatesEur?: FXRates;
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
    cashAccounts,
    primaryCurrency,
    fxRates,
    fxRatesUsd,
    fxRatesEur,
    eurUsdChange24h = 0,
  } = params;

  const currencyKey = primaryCurrency.toLowerCase() as "usd" | "eur";
  const changeKey = `${currencyKey}_24h_change` as "usd_24h_change" | "eur_24h_change";

  // FX impact helper — see fxChangeForCurrency() in fx.ts for full docs
  const fxChangeForCurrency = (c: string) => fxChangeFor(c, primaryCurrency, eurUsdChange24h);

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

    if (isStablecoin(asset.subcategory)) {
      stablecoinValue += value;
      // Full return from CoinGecko (includes both price deviation + FX)
      const stableChange = price[changeKey] ?? 0;
      stablecoinWeightedChange += value * stableChange;
      // FX-only: derive from CoinGecko's own data (eur_change - usd_change)
      // to stay consistent with the total return above. Using Yahoo's EUR/USD
      // here would mix two sources with different 24h windows, causing the
      // residual "Prices" row to show a phantom depeg.
      const usdChange = price.usd_24h_change ?? 0;
      stablecoinFxWeightedChange += value * (stableChange - usdChange);
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
  let stocksFxWeightedChange = 0;

  for (const asset of stockAssets) {
    const key = asset.yahoo_ticker || asset.ticker;
    const priceData = stockPrices[key];
    if (!priceData) continue;

    const totalQty = asset.positions.reduce((sum, p) => sum + p.quantity, 0);
    const valueNative = totalQty * priceData.price;
    const valueBase = convertToBase(valueNative, asset.currency, primaryCurrency, fxRates);
    const fxChange = fxChangeForCurrency(asset.currency);
    // Total change in primary currency ≈ asset price change + FX change
    const change = (priceData.change24h ?? 0) + fxChange;

    stocksValue += valueBase;
    stocksWeightedChange += valueBase * change;
    stocksFxWeightedChange += valueBase * fxChange;
  }

  // ── Cash (unified cash accounts) ──
  let cashValue = 0;
  let fiatCashWeightedChange = 0; // FX-only change for foreign-currency cash

  for (const cash of cashAccounts) {
    const valueBase = convertToBase(cash.balance, cash.currency, primaryCurrency, fxRates);
    cashValue += valueBase;
    fiatCashWeightedChange += valueBase * fxChangeForCurrency(cash.currency);
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
  // The DB stores both USD and EUR. We compute both independently.
  // CoinGecko gives us both directly; for stocks/cash we convert from
  // native currency to USD and EUR using separate FX rate sets.
  // This matches the Edge Function's approach (direct conversion, no 2-legged hops).
  let cryptoValueUsd = 0;
  let cryptoValueEur = 0;
  let stablecoinValueUsd = 0;
  let stablecoinValueEur = 0;

  for (const asset of cryptoAssets) {
    const price = cryptoPrices[asset.coingecko_id];
    if (!price) continue;
    const totalQty = asset.positions.reduce((sum, p) => sum + p.quantity, 0);
    if (isStablecoin(asset.subcategory)) {
      stablecoinValueUsd += totalQty * (price.usd ?? 0);
      stablecoinValueEur += totalQty * (price.eur ?? 0);
    } else {
      cryptoValueUsd += totalQty * (price.usd ?? 0);
      cryptoValueEur += totalQty * (price.eur ?? 0);
    }
  }

  // Stocks and cash: convert directly from native currency to USD and EUR.
  // Uses dual FX rate sets when available (accurate), falls back to cross-conversion (legacy).
  let stocksValueUsd = 0;
  let stocksValueEur = 0;
  let fiatCashValueUsd = 0;
  let fiatCashValueEur = 0;
  let stocksHomeCurrencyEur = 0;
  let cashHomeCurrencyEur = 0;

  if (fxRatesUsd && fxRatesEur) {
    // Direct conversion — each native currency converts independently to USD and EUR
    // This matches the Edge Function's approach and avoids 2-legged FX triangulation.
    for (const asset of stockAssets) {
      const key = asset.yahoo_ticker || asset.ticker;
      const priceData = stockPrices[key];
      if (!priceData) continue;
      const totalQty = asset.positions.reduce((sum, p) => sum + p.quantity, 0);
      const valueNative = totalQty * priceData.price;
      stocksValueUsd += convertToBase(valueNative, asset.currency, "USD", fxRatesUsd);
      stocksValueEur += convertToBase(valueNative, asset.currency, "EUR", fxRatesEur);
      if (asset.currency === primaryCurrency) {
        stocksHomeCurrencyEur += convertToBase(valueNative, asset.currency, "EUR", fxRatesEur);
      }
    }
    for (const cash of cashAccounts) {
      fiatCashValueUsd += convertToBase(cash.balance, cash.currency, "USD", fxRatesUsd);
      fiatCashValueEur += convertToBase(cash.balance, cash.currency, "EUR", fxRatesEur);
      if (cash.currency === primaryCurrency) {
        cashHomeCurrencyEur += convertToBase(cash.balance, cash.currency, "EUR", fxRatesEur);
      }
    }
  } else {
    // Legacy cross-conversion fallback (single FX rate set)
    const eurPerUsd = fxRates["EUR"] ?? (() => { console.warn("[aggregate] Missing EUR rate, falling back to 1:1"); return 1; })();
    if (primaryCurrency === "USD") {
      stocksValueUsd = stocksValue;
      stocksValueEur = stocksValue * eurPerUsd;
      fiatCashValueUsd = cashValue - stablecoinValue;
      fiatCashValueEur = (cashValue - stablecoinValue) * eurPerUsd;
    } else {
      const usdPerEur = fxRates["USD"] ?? (() => { console.warn("[aggregate] Missing USD rate, falling back to 1:1"); return 1; })();
      stocksValueEur = stocksValue;
      stocksValueUsd = stocksValue * usdPerEur;
      fiatCashValueEur = cashValue - stablecoinValue;
      fiatCashValueUsd = (cashValue - stablecoinValue) * usdPerEur;
    }
  }

  const cashValueUsd = fiatCashValueUsd + stablecoinValueUsd;
  const cashValueEur = fiatCashValueEur + stablecoinValueEur;

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
    cryptoValueEur,
    stocksValueUsd,
    stocksValueEur,
    cashValueUsd,
    cashValueEur,
    stocksHomeCurrencyEur,
    cashHomeCurrencyEur,
  };
}
