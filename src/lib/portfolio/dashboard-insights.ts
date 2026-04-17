/**
 * Dashboard insights — pure computation, no I/O.
 *
 * Derives additional metrics for the dashboard cards from the same
 * raw data used by aggregatePortfolio(). Separated to keep the
 * aggregate function focused on totals and the insights on display.
 */

import { convertToBase, fxChangeForCurrency as fxChangeFor } from "@/lib/prices/fx";
import { isStablecoin } from "@/lib/cashflow";
import { MIN_BREAKDOWN_DISPLAY_VALUE } from "@/lib/constants";
import type { FXRates } from "@/lib/prices/fx";
import type { PortfolioSummary } from "./aggregate";
import type {
  CryptoAssetWithPositions,
  CoinGeckoPriceData,
  StockAssetWithPositions,
  YahooStockPriceData,
  YahooDividendMap,
  CashAccount,
  BaseCurrency,
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

export interface CurrencyExposureEntry {
  currency: string;           // e.g., "USD", "EUR"
  value: number;              // total in base currency (for bar % calculation)
  percent: number;            // of total portfolio value
  nativeTotal: number;        // total in native/denomination currency (for display)
  cryptoValue: number;        // in native currency
  stocksValue: number;        // in native currency
  cashValue: number;          // in native currency
  cryptoValueBase: number;    // in base/primary currency
  stocksValueBase: number;    // in base/primary currency
  cashValueBase: number;      // in base/primary currency
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
  solPriceUsd: number;
  solChange24h: number;
  stoxx50Price: number;
  stoxx50Change24h: number;
  silverPriceUsd: number;
  silverChange24h: number;
  oilPriceUsd: number;
  oilChange24h: number;
  treasury10yYield: number;    // yield %, not price
  treasury10yChange24h: number;
  vixPrice: number;
  vixChange24h: number;
  eurUsdRate: number; // EUR/USD cross rate (how many USD per 1 EUR)
  eurUsdChange24h: number; // 24h change % for EUR/USD

  // Crypto insights
  cryptoAssetCount: number;
  cryptoPositionCount: number;
  cryptoChange24h: number;
  btcDominancePercent: number;
  btcValueInBase: number;
  minedStakedPercent: number;
  minedStakedCount: number;
  cryptoBreakdown: BreakdownEntry[];

  // Equities insights
  stockAssetCount: number;
  stockPositionCount: number;
  stockChange24h: number;
  equitiesBreakdown: BreakdownEntry[];
  topHolding: { name: string; ticker: string; percent: number } | null;
  stocksWeightedYield: number;         // value-weighted trailing yield %
  stocksDividendIncomeYearly: number;  // projected annual income in base currency

  // Cash insights
  cashAccountCount: number;
  weightedAvgApy: number;
  apyIncomeDaily: number;
  apyIncomeMonthly: number;
  apyIncomeYearly: number;
  cashCurrencyBreakdown: CashCurrencyEntry[];

  // Portfolio-wide currency exposure
  currencyExposure: CurrencyExposureEntry[];
}

interface InsightsParams {
  cryptoAssets: CryptoAssetWithPositions[];
  cryptoPrices: CoinGeckoPriceData;
  stockAssets: StockAssetWithPositions[];
  stockPrices: YahooStockPriceData;
  cashAccounts: CashAccount[];
  primaryCurrency: BaseCurrency;
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
  solPriceUsd: number;
  solChange24h: number;
  stoxx50Price: number;
  stoxx50Change24h: number;
  silverPrice: number;
  silverChange24h: number;
  oilPrice: number;
  oilChange24h: number;
  treasury10yPrice: number;
  treasury10yChange24h: number;
  vixPrice: number;
  vixChange24h: number;
  dividends?: YahooDividendMap;
}

// ─── Computation ────────────────────────────────────────

export function computeDashboardInsights(params: InsightsParams): DashboardInsights {
  const {
    cryptoAssets,
    cryptoPrices,
    stockAssets,
    stockPrices,
    cashAccounts,
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
    solPriceUsd,
    solChange24h,
    stoxx50Price,
    stoxx50Change24h,
    silverPrice,
    silverChange24h,
    oilPrice,
    oilChange24h,
    treasury10yPrice,
    treasury10yChange24h,
    vixPrice,
    vixChange24h,
    dividends,
  } = params;

  const currencyKey = primaryCurrency.toLowerCase() as "usd" | "eur";
  const changeKey = `${currencyKey}_24h_change` as "usd_24h_change" | "eur_24h_change";

  // FX impact helper — see fxChangeForCurrency() in fx.ts for full docs
  const fxChangeForCurrency = (c: string) => fxChangeFor(c, primaryCurrency, eurUsdChange24h);

  // ── BTC & ETH market prices (USD only) ───────────────
  const btcData = cryptoPrices["bitcoin"];
  const btcPriceUsd = btcData?.usd ?? 0;
  const btcChange24h = btcData?.usd_24h_change ?? 0;

  const ethData = cryptoPrices["ethereum"];
  const ethPriceUsd = ethData?.usd ?? 0;
  const ethChange24h = ethData?.usd_24h_change ?? 0;

  // ── Crypto insights ───────────────────────────────────
  const nonStablecoinAssets = cryptoAssets.filter(
    (a) => !isStablecoin(a.subcategory)
  );
  const cryptoAssetCount = nonStablecoinAssets.length;
  const cryptoPositionCount = nonStablecoinAssets.reduce(
    (sum, a) => sum + a.positions.length, 0
  );

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
    const change = (priceData.change24h ?? 0) + fxChangeForCurrency(asset.currency);

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

  const stockAssetCount = stockAssets.length;

  const stockChange24h = stockTotalValue > 0
    ? stockWeightedChange / stockTotalValue
    : 0;

  if (topHolding && stockTotalValue > 0) {
    topHolding.percent = (topHoldingValue / stockTotalValue) * 100;
  }

  // Dividend yield — value-weighted across all stock assets
  let yieldWeightedSum = 0;
  let stocksDividendIncomeYearly = 0;

  if (dividends) {
    for (const asset of stockAssets) {
      const yahooKey = asset.yahoo_ticker || asset.ticker;
      const divData = dividends[yahooKey];
      if (!divData || divData.trailingYield <= 0) continue;

      const priceData = stockPrices[yahooKey];
      if (!priceData) continue;

      const totalQty = asset.positions.reduce((sum, p) => sum + p.quantity, 0);
      const valueNative = totalQty * priceData.price;
      const valueBase = convertToBase(valueNative, asset.currency, primaryCurrency, fxRates);

      yieldWeightedSum += valueBase * divData.trailingYield;
      const nativeIncome = totalQty * divData.annualDividend;
      stocksDividendIncomeYearly += convertToBase(nativeIncome, asset.currency, primaryCurrency, fxRates);
    }
  }

  const stocksWeightedYield = stockTotalValue > 0 ? yieldWeightedSum / stockTotalValue : 0;

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

  for (const cash of cashAccounts) {
    const valueBase = convertToBase(cash.balance, cash.currency, primaryCurrency, fxRates);
    if (cash.apy > 0) {
      apyWeightedSum += valueBase * cash.apy;
      apyTotalValue += valueBase;
    }
    cashAccountCount++;
  }

  // Stablecoin positions with APY
  for (const asset of cryptoAssets) {
    if (!isStablecoin(asset.subcategory)) continue;
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

  for (const cash of cashAccounts) {
    const valueBase = convertToBase(cash.balance, cash.currency, primaryCurrency, fxRates);
    const key = cash.currency.toUpperCase();
    fiatMap.set(key, (fiatMap.get(key) ?? 0) + valueBase);
  }
  // Stablecoins → grouped by inferred peg currency
  for (const asset of cryptoAssets) {
    if (!isStablecoin(asset.subcategory)) continue;
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

  // ── Portfolio-wide currency exposure ────────────────
  // Combines cash (fiat + stablecoins), stocks, and crypto by denomination currency.
  // Crypto: non-stablecoin → USD (CoinGecko prices are USD-denominated).
  //         Stablecoins → inferred peg currency (already in cashCurrencyBreakdown).
  // Stocks: grouped by stock_assets.currency (e.g., EUR, USD, GBP).
  // Two parallel maps: base currency (for % calculation) and native currency (for display)
  type ExposureBucket = { crypto: number; stocks: number; cash: number };
  const baseMap = new Map<string, ExposureBucket>();
  const nativeMap = new Map<string, ExposureBucket>();

  const ensureCcy = (ccy: string) => {
    if (!baseMap.has(ccy)) baseMap.set(ccy, { crypto: 0, stocks: 0, cash: 0 });
    if (!nativeMap.has(ccy)) nativeMap.set(ccy, { crypto: 0, stocks: 0, cash: 0 });
    return { base: baseMap.get(ccy)!, native: nativeMap.get(ccy)! };
  };

  // Cash: fiat deposits + bank accounts (native amounts from raw entities)
  for (const cash of cashAccounts) {
    const ccy = cash.currency.toUpperCase();
    const { base, native } = ensureCcy(ccy);
    base.cash += convertToBase(cash.balance, cash.currency, primaryCurrency, fxRates);
    native.cash += cash.balance;
  }
  // Stablecoins → grouped by inferred peg currency
  for (const asset of cryptoAssets) {
    if (!isStablecoin(asset.subcategory)) continue;
    const price = cryptoPrices[asset.coingecko_id];
    if (!price) continue;
    const peg = inferPegCurrency(asset.ticker, asset.name);
    const priceInBase = price[currencyKey] ?? 0;
    // Native value: stablecoin quantity ≈ peg currency units (1 USDC ≈ $1, 1 EURS ≈ €1)
    // More precisely: use CoinGecko's price in peg currency if available, else approximate
    const pegLower = peg.toLowerCase();
    const priceInPeg = (pegLower === "usd" || pegLower === "eur")
      ? (price[pegLower] ?? priceInBase)
      : priceInBase; // Non-USD/EUR peg (GBP, CHF) — fall back to base currency price
    for (const pos of asset.positions) {
      const { base, native } = ensureCcy(peg);
      base.cash += pos.quantity * priceInBase;
      native.cash += pos.quantity * priceInPeg;
    }
  }

  // Stocks: group by asset.currency
  for (const asset of stockAssets) {
    const key = asset.yahoo_ticker || asset.ticker;
    const priceData = stockPrices[key];
    if (!priceData) continue;
    const totalQty = asset.positions.reduce((sum, p) => sum + p.quantity, 0);
    const valueNative = totalQty * priceData.price;
    const valueBase = convertToBase(valueNative, asset.currency, primaryCurrency, fxRates);
    const { base, native } = ensureCcy(asset.currency.toUpperCase());
    base.stocks += valueBase;
    native.stocks += valueNative;
  }

  // Crypto: non-stablecoins → USD (stablecoins already counted in cash above)
  for (const asset of cryptoAssets) {
    if (isStablecoin(asset.subcategory)) continue;
    const price = cryptoPrices[asset.coingecko_id];
    if (!price) continue;
    const priceInBase = price[currencyKey] ?? 0;
    const priceInUsd = price.usd ?? 0;
    for (const pos of asset.positions) {
      const { base, native } = ensureCcy("USD");
      base.crypto += pos.quantity * priceInBase;
      native.crypto += pos.quantity * priceInUsd;
    }
  }

  const totalPortfolioValue = summary.totalValue;
  const currencyExposure: CurrencyExposureEntry[] = [...baseMap.keys()]
    .map((currency) => {
      const base = baseMap.get(currency)!;
      const native = nativeMap.get(currency)!;
      const value = base.crypto + base.stocks + base.cash;
      return {
        currency,
        value,
        percent: totalPortfolioValue > 0 ? (value / totalPortfolioValue) * 100 : 0,
        nativeTotal: native.crypto + native.stocks + native.cash,
        cryptoValue: native.crypto,
        stocksValue: native.stocks,
        cashValue: native.cash,
        cryptoValueBase: base.crypto,
        stocksValueBase: base.stocks,
        cashValueBase: base.cash,
      };
    })
    .filter((e) => e.value > MIN_BREAKDOWN_DISPLAY_VALUE)
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
    if (!eurUsdRate) console.warn("[dashboard-insights] Missing USD rate for EUR-based EUR/USD cross");
  } else if (pc === "USD") {
    const eurRate = fxRates["EUR"];
    eurUsdRate = eurRate ? 1 / eurRate : 0;
    if (!eurRate) console.warn("[dashboard-insights] Missing EUR rate for USD-based EUR/USD cross");
  } else {
    const usdRate = fxRates["USD"];
    const eurRate = fxRates["EUR"];
    eurUsdRate = usdRate && eurRate ? usdRate / eurRate : 0;
    if (!usdRate || !eurRate) console.warn(`[dashboard-insights] Missing USD/EUR rates for ${pc}-based EUR/USD cross`);
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
    solPriceUsd,
    solChange24h,
    stoxx50Price,
    stoxx50Change24h,
    silverPriceUsd: silverPrice,
    silverChange24h,
    oilPriceUsd: oilPrice,
    oilChange24h,
    treasury10yYield: treasury10yPrice,
    treasury10yChange24h,
    vixPrice,
    vixChange24h,
    eurUsdRate,
    eurUsdChange24h,

    cryptoAssetCount,
    cryptoPositionCount,
    cryptoChange24h,
    btcDominancePercent,
    btcValueInBase,
    minedStakedPercent,
    minedStakedCount,
    cryptoBreakdown,

    stockAssetCount,
    stockPositionCount,
    stockChange24h,
    equitiesBreakdown,
    topHolding,
    stocksWeightedYield,
    stocksDividendIncomeYearly,

    cashAccountCount,
    weightedAvgApy,
    apyIncomeDaily,
    apyIncomeMonthly,
    apyIncomeYearly,
    cashCurrencyBreakdown,
    currencyExposure,
  };
}
