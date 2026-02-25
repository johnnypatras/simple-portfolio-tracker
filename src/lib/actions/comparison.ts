"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/actions/profile";
import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getBankAccounts } from "@/lib/actions/bank-accounts";
import { getExchangeDeposits } from "@/lib/actions/exchange-deposits";
import { getBrokerDeposits } from "@/lib/actions/broker-deposits";
import { getSharedPortfolio } from "@/lib/actions/shared-portfolio";
import { getPrices } from "@/lib/prices/coingecko";
import { getStockPrices, fetchSinglePrice } from "@/lib/prices/yahoo";
import { getFXRates, convertToBase } from "@/lib/prices/fx";
import { aggregatePortfolio, type PortfolioSummary } from "@/lib/portfolio/aggregate";

// ─── Types ──────────────────────────────────────────────

export interface HoldingItem {
  key: string;             // dedup key: coingecko_id | ticker | "cash:{currency}"
  name: string;            // "Bitcoin", "VWCE", "EUR Cash"
  ticker: string;          // "BTC", "VWCE", "EUR"
  class: "crypto" | "equities" | "cash";
  imageUrl: string | null; // CoinGecko thumb for crypto, null for others
  viewerValue: number;     // 0 if viewer doesn't hold it
  ownerValue: number;      // 0 if owner doesn't hold it
}

export interface ComparisonData {
  viewer: { name: string; summary: PortfolioSummary };
  owner: { name: string; summary: PortfolioSummary };
  normalizedCurrency: string;
  holdings: HoldingItem[];
}

export type ComparisonResult =
  | { ok: true; data: ComparisonData }
  | { ok: false; error: string };

// ─── Server action ──────────────────────────────────────

/**
 * Fetch both the viewer's and the owner's portfolio, aggregate both
 * in the viewer's primary currency, and return summaries for comparison.
 *
 * Security: only aggregated totals leave the server — raw positions
 * are consumed server-side and never serialized to the client.
 */
export async function getComparisonData(
  token: string
): Promise<ComparisonResult> {
  // 1. Auth check
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  // 2. Fetch viewer profile + owner's shared data in parallel
  const [viewerProfile, ownerData] = await Promise.all([
    getProfile(),
    getSharedPortfolio(token),
  ]);
  if (!ownerData) return { ok: false, error: "invalid_token" };

  const viewerCurrency = viewerProfile.primary_currency;
  const ownerName = ownerData.profile.display_name || "Anonymous";
  const viewerName = viewerProfile.display_name || "You";

  // 3. Fetch viewer's portfolio data in parallel
  const [
    viewerCrypto,
    viewerStocks,
    viewerBanks,
    viewerExchangeDeps,
    viewerBrokerDeps,
  ] = await Promise.all([
    getCryptoAssetsWithPositions(),
    getStockAssetsWithPositions(),
    getBankAccounts(),
    getExchangeDeposits(),
    getBrokerDeposits(),
  ]);

  // 4. Build merged ticker/coin/currency lists from BOTH portfolios
  const allCoinIds = [
    ...new Set([
      "bitcoin",
      "ethereum",
      ...viewerCrypto.map((a) => a.coingecko_id),
      ...ownerData.cryptoAssets.map((a) => a.coingecko_id),
    ]),
  ];

  const allYahooTickers = [
    ...new Set([
      ...viewerStocks.map((a) => a.yahoo_ticker || a.ticker).filter(Boolean),
      ...ownerData.stockAssets
        .map((a) => a.yahoo_ticker || a.ticker)
        .filter(Boolean),
    ]),
  ];

  const allCurrencies = [
    ...new Set([
      "EUR",
      "USD",
      ...viewerStocks.map((a) => a.currency),
      ...viewerBanks.map((a) => a.currency),
      ...viewerExchangeDeps.map((a) => a.currency),
      ...viewerBrokerDeps.map((a) => a.currency),
      ...ownerData.stockAssets.map((a) => a.currency),
      ...ownerData.bankAccounts.map((a) => a.currency),
      ...ownerData.exchangeDeposits.map((a) => a.currency),
      ...ownerData.brokerDeposits.map((a) => a.currency),
    ]),
  ];

  // 5. Single set of price fetches (shared between both aggregations)
  const [cryptoPrices, stockPrices, fxRates, eurUsdData] = await Promise.all([
    getPrices(allCoinIds),
    getStockPrices(allYahooTickers),
    getFXRates(viewerCurrency, allCurrencies),
    fetchSinglePrice("EURUSD=X"),
  ]);

  const eurUsdChange24h = eurUsdData?.change24h ?? 0;

  // 6. Aggregate both portfolios with the VIEWER's currency
  const viewerSummary = aggregatePortfolio({
    cryptoAssets: viewerCrypto,
    cryptoPrices,
    stockAssets: viewerStocks,
    stockPrices,
    bankAccounts: viewerBanks,
    exchangeDeposits: viewerExchangeDeps,
    brokerDeposits: viewerBrokerDeps,
    primaryCurrency: viewerCurrency,
    fxRates,
    eurUsdChange24h,
  });

  const ownerSummary = aggregatePortfolio({
    cryptoAssets: ownerData.cryptoAssets,
    cryptoPrices,
    stockAssets: ownerData.stockAssets,
    stockPrices,
    bankAccounts: ownerData.bankAccounts,
    exchangeDeposits: ownerData.exchangeDeposits,
    brokerDeposits: ownerData.brokerDeposits,
    primaryCurrency: viewerCurrency,
    fxRates,
    eurUsdChange24h,
  });

  // 7. Compute per-asset holdings for overlap visualization.
  //    Only names/tickers/values leave the server — no quantities or positions.
  const currencyKey = viewerCurrency.toLowerCase() as "usd" | "eur";
  const holdingsMap = new Map<string, HoldingItem>();

  function upsertHolding(
    key: string,
    init: Omit<HoldingItem, "viewerValue" | "ownerValue">,
    side: "viewer" | "owner",
    value: number
  ) {
    let h = holdingsMap.get(key);
    if (!h) {
      h = { ...init, viewerValue: 0, ownerValue: 0 };
      holdingsMap.set(key, h);
    }
    if (side === "viewer") h.viewerValue += value;
    else h.ownerValue += value;
  }

  // Crypto holdings
  for (const assets of [
    { list: viewerCrypto, side: "viewer" as const },
    { list: ownerData.cryptoAssets, side: "owner" as const },
  ]) {
    for (const asset of assets.list) {
      const price = cryptoPrices[asset.coingecko_id];
      if (!price) continue;
      const priceInBase = price[currencyKey] ?? 0;
      const totalQty = asset.positions.reduce((s, p) => s + p.quantity, 0);
      const value = totalQty * priceInBase;
      if (value === 0) continue;

      const isStable = asset.subcategory?.toLowerCase() === "stablecoin";
      upsertHolding(
        isStable ? `cash:${asset.ticker.toUpperCase()}` : asset.coingecko_id,
        {
          key: isStable ? `cash:${asset.ticker.toUpperCase()}` : asset.coingecko_id,
          name: isStable ? `${asset.ticker.toUpperCase()} (Stablecoin)` : asset.name,
          ticker: asset.ticker.toUpperCase(),
          class: isStable ? "cash" : "crypto",
          imageUrl: asset.image_url,
        },
        assets.side,
        value
      );
    }
  }

  // Stock holdings (merge by display ticker — e.g. VWCE.DE + VWCE.AS → VWCE)
  for (const assets of [
    { list: viewerStocks, side: "viewer" as const },
    { list: ownerData.stockAssets, side: "owner" as const },
  ]) {
    for (const asset of assets.list) {
      const yahooKey = asset.yahoo_ticker || asset.ticker;
      const priceData = stockPrices[yahooKey];
      if (!priceData) continue;
      const totalQty = asset.positions.reduce((s, p) => s + p.quantity, 0);
      const valueNative = totalQty * priceData.price;
      const value = convertToBase(valueNative, asset.currency, viewerCurrency, fxRates);
      if (value === 0) continue;

      // Use base ticker (strip exchange suffix) for merging
      const displayTicker = asset.ticker.split(".")[0];
      upsertHolding(
        `stock:${displayTicker}`,
        {
          key: `stock:${displayTicker}`,
          name: asset.name,
          ticker: displayTicker,
          class: "equities",
          imageUrl: null,
        },
        assets.side,
        value
      );
    }
  }

  // Cash holdings (bank accounts + exchange deposits + broker deposits by currency)
  for (const sources of [
    {
      viewer: { banks: viewerBanks, exDeps: viewerExchangeDeps, brDeps: viewerBrokerDeps },
      owner: {
        banks: ownerData.bankAccounts,
        exDeps: ownerData.exchangeDeposits,
        brDeps: ownerData.brokerDeposits,
      },
    },
  ]) {
    for (const side of ["viewer", "owner"] as const) {
      const src = sources[side];
      for (const bank of src.banks) {
        const value = convertToBase(bank.balance, bank.currency, viewerCurrency, fxRates);
        if (value === 0) continue;
        upsertHolding(
          `cash:${bank.currency}`,
          { key: `cash:${bank.currency}`, name: `${bank.currency} Cash`, ticker: bank.currency, class: "cash", imageUrl: null },
          side,
          value
        );
      }
      for (const dep of src.exDeps) {
        const value = convertToBase(dep.amount, dep.currency, viewerCurrency, fxRates);
        if (value === 0) continue;
        upsertHolding(
          `cash:${dep.currency}`,
          { key: `cash:${dep.currency}`, name: `${dep.currency} Cash`, ticker: dep.currency, class: "cash", imageUrl: null },
          side,
          value
        );
      }
      for (const dep of src.brDeps) {
        const value = convertToBase(dep.amount, dep.currency, viewerCurrency, fxRates);
        if (value === 0) continue;
        upsertHolding(
          `cash:${dep.currency}`,
          { key: `cash:${dep.currency}`, name: `${dep.currency} Cash`, ticker: dep.currency, class: "cash", imageUrl: null },
          side,
          value
        );
      }
    }
  }

  // Sort by max value descending
  const holdings = [...holdingsMap.values()].sort(
    (a, b) => Math.max(b.viewerValue, b.ownerValue) - Math.max(a.viewerValue, a.ownerValue)
  );

  return {
    ok: true,
    data: {
      viewer: { name: viewerName, summary: viewerSummary },
      owner: { name: ownerName, summary: ownerSummary },
      normalizedCurrency: viewerCurrency,
      holdings,
    },
  };
}
