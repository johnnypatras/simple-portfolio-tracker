/**
 * Dashboard insights — pure computation, no I/O.
 *
 * Derives additional metrics for the dashboard cards from the same
 * raw data used by aggregatePortfolio(). Separated to keep the
 * aggregate function focused on totals and the insights on display.
 */

import { convertToBase } from "@/lib/prices/fx";
import type { FXRates } from "@/lib/prices/fx";
import type { PortfolioSummary } from "./aggregate";
import type {
  CryptoAssetWithPositions,
  CoinGeckoPriceData,
  StockAssetWithPositions,
  YahooStockPriceData,
  BankAccount,
  ExchangeDeposit,
  BrokerDeposit,
} from "@/lib/types";

// ─── Helpers ─────────────────────────────────────────────

/** Infer the fiat currency a stablecoin is pegged to from its ticker/name.
 *  Defaults to USD (vast majority of stablecoins). */
function inferPegCurrency(ticker: string, name: string): string {
  const t = ticker.toUpperCase();
  const n = name.toUpperCase();
  if (t.includes("EUR") || n.includes("EUR")) return "EUR";
  if (t.includes("GBP") || n.includes("GBP")) return "GBP";
  if (t.includes("CHF") || n.includes("CHF")) return "CHF";
  return "USD";
}

// ─── Types ──────────────────────────────────────────────

export interface BreakdownEntry {
  label: string;
  value: number;
  percent: number;
  color: string;
  subtypes?: { label: string; percent: number; value: number }[];
  tagBreakdown?: { label: string; percent: number; value: number }[];
}

export interface CashCurrencyEntry {
  currency: string;
  value: number;            // total (FIAT + stablecoins) in base currency
  percent: number;          // of total cash value
  fiatValue: number;        // bank accounts + exchange/broker deposits
  stablecoinValue: number;  // stablecoins pegged to this currency
}

export interface DashboardInsights {
  // Market indices (all prices in USD)
  btcPriceUsd: number;
  btcChange24h: number;
  ethPriceUsd: number;
  ethChange24h: number;
  sp500Price: number;
  sp500Change24h: number;
  goldPriceUsd: number;
  goldChange24h: number;
  nasdaqPrice: number;
  nasdaqChange24h: number;
  dowPrice: number;
  dowChange24h: number;
  eurUsdRate: number; // EUR/USD cross rate (how many USD per 1 EUR)
  eurUsdChange24h: number; // 24h change % for EUR/USD

  // Crypto insights
  cryptoAssetCount: number;
  cryptoChange24h: number;
  btcDominancePercent: number;
  btcValueInBase: number;
  minedStakedPercent: number;
  minedStakedCount: number;
  cryptoBreakdown: BreakdownEntry[];

  // Equities insights
  stockPositionCount: number;
  stockChange24h: number;
  equitiesBreakdown: BreakdownEntry[];
  topHolding: { name: string; ticker: string; percent: number } | null;

  // Cash insights
  cashAccountCount: number;
  weightedAvgApy: number;
  apyIncomeDaily: number;
  apyIncomeMonthly: number;
  apyIncomeYearly: number;
  cashCurrencyBreakdown: CashCurrencyEntry[];
}

interface InsightsParams {
  cryptoAssets: CryptoAssetWithPositions[];
  cryptoPrices: CoinGeckoPriceData;
  stockAssets: StockAssetWithPositions[];
  stockPrices: YahooStockPriceData;
  bankAccounts: BankAccount[];
  exchangeDeposits: ExchangeDeposit[];
  brokerDeposits: BrokerDeposit[];
  primaryCurrency: string;
  fxRates: FXRates;
  summary: PortfolioSummary;
  sp500Price: number;
  sp500Change24h: number;
  goldPrice: number;
  goldChange24h: number;
  nasdaqPrice: number;
  nasdaqChange24h: number;
  dowPrice: number;
  dowChange24h: number;
  eurUsdChange24h: number;
}

// ─── Computation ────────────────────────────────────────

export function computeDashboardInsights(params: InsightsParams): DashboardInsights {
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
    summary,
    sp500Price,
    sp500Change24h,
    goldPrice,
    goldChange24h,
    nasdaqPrice,
    nasdaqChange24h,
    dowPrice,
    dowChange24h,
    eurUsdChange24h,
  } = params;

  const currencyKey = primaryCurrency.toLowerCase() as "usd" | "eur";
  const changeKey = `${currencyKey}_24h_change` as "usd_24h_change" | "eur_24h_change";

  // ── BTC & ETH market prices (USD only) ───────────────
  const btcData = cryptoPrices["bitcoin"];
  const btcPriceUsd = btcData?.usd ?? 0;
  const btcChange24h = btcData?.usd_24h_change ?? 0;

  const ethData = cryptoPrices["ethereum"];
  const ethPriceUsd = ethData?.usd ?? 0;
  const ethChange24h = ethData?.usd_24h_change ?? 0;

  // ── Crypto insights ───────────────────────────────────
  const nonStablecoinAssets = cryptoAssets.filter(
    (a) => a.subcategory?.toLowerCase() !== "stablecoin"
  );
  const cryptoAssetCount = nonStablecoinAssets.length;

  // Crypto 24h change (value-weighted, excluding stablecoins)
  let cryptoTotalValue = 0;
  let cryptoWeightedChange = 0;
  let btcValueInBase = 0;
  let minedStakedValue = 0;
  let minedStakedCount = 0;
  const perTickerValue = new Map<string, number>();

  for (const asset of nonStablecoinAssets) {
    const price = cryptoPrices[asset.coingecko_id];
    if (!price) continue;

    const priceInBase = price[currencyKey] ?? 0;
    const change = price[changeKey] ?? 0;

    for (const pos of asset.positions) {
      const posValue = pos.quantity * priceInBase;
      cryptoTotalValue += posValue;
      cryptoWeightedChange += posValue * change;

      // BTC dominance
      if (asset.coingecko_id === "bitcoin") {
        btcValueInBase += posValue;
      }

      // Mined & staked
      const method = pos.acquisition_method?.toLowerCase();
      if (method === "mined" || method === "staked") {
        minedStakedValue += posValue;
        minedStakedCount++;
      }

      // Per-ticker accumulator (for crypto breakdown)
      perTickerValue.set(asset.ticker, (perTickerValue.get(asset.ticker) ?? 0) + posValue);
    }
  }

  const cryptoChange24h = cryptoTotalValue > 0
    ? cryptoWeightedChange / cryptoTotalValue
    : 0;

  const btcDominancePercent = cryptoTotalValue > 0
    ? (btcValueInBase / cryptoTotalValue) * 100
    : 0;

  const minedStakedPercent = cryptoTotalValue > 0
    ? (minedStakedValue / cryptoTotalValue) * 100
    : 0;

  // ── Crypto breakdown (BTC vs Alts) ────────────────────
  const altsValue = cryptoTotalValue - btcValueInBase;
  const cryptoBreakdown: BreakdownEntry[] = [];

  if (cryptoTotalValue > 0) {
    // Bitcoin entry — solid bar
    cryptoBreakdown.push({
      label: "Bitcoin",
      value: btcValueInBase,
      percent: (btcValueInBase / cryptoTotalValue) * 100,
      color: "bg-orange-500",
    });

    // Alts entry — segmented bar with individual coins
    if (altsValue > 0) {
      const altSubtypes = [...perTickerValue.entries()]
        .filter(([ticker]) => ticker !== "BTC")
        .map(([ticker, value]) => ({
          label: ticker,
          value,
          percent: (value / cryptoTotalValue) * 100,
        }))
        .sort((a, b) => b.value - a.value);

      cryptoBreakdown.push({
        label: "Alts",
        value: altsValue,
        percent: (altsValue / cryptoTotalValue) * 100,
        color: "bg-indigo-500",
        subtypes: altSubtypes,
      });
    }
  }

  // ── Equities insights ─────────────────────────────────
  let stockTotalValue = 0;
  let stockWeightedChange = 0;
  let stockPositionCount = 0;
  let topHoldingValue = 0;
  let topHolding: { name: string; ticker: string; percent: number } | null = null;

  // Type-level accumulators + per-type subtype & tag maps
  const typeAccum: Record<string, number> = {};
  const subtypeMap: Record<string, Map<string, number>> = {};
  const tagMap: Record<string, Map<string, number>> = {};

  for (const asset of stockAssets) {
    const key = asset.yahoo_ticker || asset.ticker;
    const priceData = stockPrices[key];
    if (!priceData) continue;

    const totalQty = asset.positions.reduce((sum, p) => sum + p.quantity, 0);
    const valueNative = totalQty * priceData.price;
    const valueBase = convertToBase(valueNative, asset.currency, primaryCurrency, fxRates);
    const change = priceData.change24h ?? 0;

    stockTotalValue += valueBase;
    stockWeightedChange += valueBase * change;
    stockPositionCount += asset.positions.length;

    // Accumulate by type
    const cat = asset.category;
    typeAccum[cat] = (typeAccum[cat] ?? 0) + valueBase;

    // Accumulate subtype within type
    const subtype = asset.subcategory?.trim();
    if (subtype) {
      if (!subtypeMap[cat]) subtypeMap[cat] = new Map();
      subtypeMap[cat].set(subtype, (subtypeMap[cat].get(subtype) ?? 0) + valueBase);
    }

    // Accumulate primary tag (first tag) within type
    const primaryTag = asset.tags?.[0]?.trim();
    if (primaryTag) {
      if (!tagMap[cat]) tagMap[cat] = new Map();
      tagMap[cat].set(primaryTag, (tagMap[cat].get(primaryTag) ?? 0) + valueBase);
    }

    // Top holding tracking
    if (valueBase > topHoldingValue) {
      topHoldingValue = valueBase;
      topHolding = {
        name: asset.name,
        ticker: asset.ticker,
        percent: 0, // computed below
      };
    }
  }

  const stockChange24h = stockTotalValue > 0
    ? stockWeightedChange / stockTotalValue
    : 0;

  if (topHolding && stockTotalValue > 0) {
    topHolding.percent = (topHoldingValue / stockTotalValue) * 100;
  }

  // Build type-level breakdown with subtype & tag children
  const TYPE_META: { cat: string; label: string; color: string }[] = [
    { cat: "etf", label: "ETFs", color: "bg-blue-500" },
    { cat: "individual_stock", label: "Stocks", color: "bg-violet-500" },
    { cat: "bond_fixed_income", label: "Bonds", color: "bg-amber-500" },
    { cat: "other", label: "Other", color: "bg-zinc-500" },
  ];

  const equitiesBreakdown: BreakdownEntry[] = [];

  for (const { cat, label, color } of TYPE_META) {
    const value = typeAccum[cat] ?? 0;
    if (value <= 0) continue;

    const entry: BreakdownEntry = {
      label,
      value,
      percent: (value / stockTotalValue) * 100,
      color,
    };

    // Subtypes (only if >1 distinct subtype)
    const stMap = subtypeMap[cat];
    if (stMap && stMap.size > 1) {
      entry.subtypes = [...stMap.entries()]
        .map(([stLabel, stValue]) => ({
          label: stLabel,
          value: stValue,
          percent: (stValue / value) * 100,
        }))
        .sort((a, b) => b.value - a.value);
    }

    // Tag breakdown — skip tags that duplicate the type label (e.g. "Stocks" under Stocks)
    const tMap = tagMap[cat];
    if (tMap && tMap.size > 0) {
      const tags = [...tMap.entries()]
        .filter(([tLabel]) => tLabel.toLowerCase() !== label.toLowerCase())
        .map(([tLabel, tValue]) => ({
          label: tLabel,
          value: tValue,
          percent: (tValue / value) * 100,
        }))
        .sort((a, b) => b.value - a.value);
      if (tags.length > 0) entry.tagBreakdown = tags;
    }

    equitiesBreakdown.push(entry);
  }

  equitiesBreakdown.sort((a, b) => b.value - a.value);

  // ── Cash insights ─────────────────────────────────────
  // Weighted average APY across all cash holdings (banks, exchange deposits,
  // broker deposits, stablecoins with APY from crypto positions)
  let apyWeightedSum = 0;
  let apyTotalValue = 0;
  let cashAccountCount = 0;

  for (const bank of bankAccounts) {
    const valueBase = convertToBase(bank.balance, bank.currency, primaryCurrency, fxRates);
    if (bank.apy > 0) {
      apyWeightedSum += valueBase * bank.apy;
      apyTotalValue += valueBase;
    }
    cashAccountCount++;
  }

  for (const deposit of exchangeDeposits) {
    const valueBase = convertToBase(deposit.amount, deposit.currency, primaryCurrency, fxRates);
    if (deposit.apy > 0) {
      apyWeightedSum += valueBase * deposit.apy;
      apyTotalValue += valueBase;
    }
    cashAccountCount++;
  }

  for (const deposit of brokerDeposits) {
    const valueBase = convertToBase(deposit.amount, deposit.currency, primaryCurrency, fxRates);
    if (deposit.apy > 0) {
      apyWeightedSum += valueBase * deposit.apy;
      apyTotalValue += valueBase;
    }
    cashAccountCount++;
  }

  // Stablecoin positions with APY
  for (const asset of cryptoAssets) {
    if (asset.subcategory?.toLowerCase() !== "stablecoin") continue;
    const price = cryptoPrices[asset.coingecko_id];
    if (!price) continue;
    const priceInBase = price[currencyKey] ?? 0;
    for (const pos of asset.positions) {
      const posValue = pos.quantity * priceInBase;
      if (pos.apy > 0) {
        apyWeightedSum += posValue * pos.apy;
        apyTotalValue += posValue;
      }
      cashAccountCount++;
    }
  }

  const weightedAvgApy = apyTotalValue > 0 ? apyWeightedSum / apyTotalValue : 0;

  // APY income projections — use only APY-bearing balance, not total cash.
  // weightedAvgApy is the weighted average across APY-bearing accounts only,
  // so income = apyTotalValue × weightedAvgApy (NOT totalCash × weightedAvgApy).
  const apyIncomeYearly = apyTotalValue * (weightedAvgApy / 100);
  const apyIncomeMonthly = apyIncomeYearly / 12;
  const apyIncomeDaily = apyIncomeYearly / 365;

  // ── Cash currency breakdown ─────────────────────────
  // Group by native currency, split into FIAT vs Stablecoins per currency.
  // Stablecoin peg currency is inferred from the ticker/name.
  const fiatMap = new Map<string, number>();
  const stableMap = new Map<string, number>();

  for (const bank of bankAccounts) {
    const valueBase = convertToBase(bank.balance, bank.currency, primaryCurrency, fxRates);
    const key = bank.currency.toUpperCase();
    fiatMap.set(key, (fiatMap.get(key) ?? 0) + valueBase);
  }
  for (const deposit of exchangeDeposits) {
    const valueBase = convertToBase(deposit.amount, deposit.currency, primaryCurrency, fxRates);
    const key = deposit.currency.toUpperCase();
    fiatMap.set(key, (fiatMap.get(key) ?? 0) + valueBase);
  }
  for (const deposit of brokerDeposits) {
    const valueBase = convertToBase(deposit.amount, deposit.currency, primaryCurrency, fxRates);
    const key = deposit.currency.toUpperCase();
    fiatMap.set(key, (fiatMap.get(key) ?? 0) + valueBase);
  }
  // Stablecoins → grouped by inferred peg currency
  for (const asset of cryptoAssets) {
    if (asset.subcategory?.toLowerCase() !== "stablecoin") continue;
    const price = cryptoPrices[asset.coingecko_id];
    if (!price) continue;
    const priceInBase = price[currencyKey] ?? 0;
    const peg = inferPegCurrency(asset.ticker, asset.name);
    for (const pos of asset.positions) {
      const posValue = pos.quantity * priceInBase;
      stableMap.set(peg, (stableMap.get(peg) ?? 0) + posValue);
    }
  }

  // Merge FIAT + stablecoin maps into unified currency entries
  const allCurrencyKeys = new Set([...fiatMap.keys(), ...stableMap.keys()]);
  const totalCashValue = summary.cashValue;
  const cashCurrencyBreakdown: CashCurrencyEntry[] = [...allCurrencyKeys]
    .map((ccy) => {
      const fiatValue = fiatMap.get(ccy) ?? 0;
      const stablecoinValue = stableMap.get(ccy) ?? 0;
      const value = fiatValue + stablecoinValue;
      return {
        currency: ccy,
        value,
        percent: totalCashValue > 0 ? (value / totalCashValue) * 100 : 0,
        fiatValue,
        stablecoinValue,
      };
    })
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);

  // ── Gold price (USD only) ────────────────────────────
  const goldPriceUsd = goldPrice; // from Yahoo, already USD

  // ── EUR/USD cross rate ─────────────────────────────
  // fxRates are relative to primaryCurrency (base).
  // If base=EUR: fxRates["USD"] = USD per 1 EUR → eurUsdRate = fxRates["USD"]
  // If base=USD: fxRates["EUR"] = EUR per 1 USD → eurUsdRate = 1 / fxRates["EUR"]
  // If base=CHF: fxRates["USD"] and fxRates["EUR"] → eurUsdRate = fxRates["USD"] / fxRates["EUR"]
  const pc = primaryCurrency.toUpperCase();
  let eurUsdRate = 0;
  if (pc === "EUR") {
    eurUsdRate = fxRates["USD"] ?? 0;
  } else if (pc === "USD") {
    const eurRate = fxRates["EUR"];
    eurUsdRate = eurRate ? 1 / eurRate : 0;
  } else {
    const usdRate = fxRates["USD"];
    const eurRate = fxRates["EUR"];
    eurUsdRate = usdRate && eurRate ? usdRate / eurRate : 0;
  }

  return {
    btcPriceUsd,
    btcChange24h,
    ethPriceUsd,
    ethChange24h,
    sp500Price,
    sp500Change24h,
    goldPriceUsd,
    goldChange24h,
    nasdaqPrice,
    nasdaqChange24h,
    dowPrice,
    dowChange24h,
    eurUsdRate,
    eurUsdChange24h,

    cryptoAssetCount,
    cryptoChange24h,
    btcDominancePercent,
    btcValueInBase,
    minedStakedPercent,
    minedStakedCount,
    cryptoBreakdown,

    stockPositionCount,
    stockChange24h,
    equitiesBreakdown,
    topHolding,

    cashAccountCount,
    weightedAvgApy,
    apyIncomeDaily,
    apyIncomeMonthly,
    apyIncomeYearly,
    cashCurrencyBreakdown,
  };
}
