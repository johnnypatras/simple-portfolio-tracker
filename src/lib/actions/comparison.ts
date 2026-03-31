"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/actions/profile";
import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getCashAccounts } from "@/lib/actions/cash-accounts";
import { getSharedPortfolio } from "@/lib/actions/shared-portfolio";
import { getSnapshots } from "@/lib/actions/snapshots";
import { getPrices } from "@/lib/prices/coingecko";
import { getStockPrices } from "@/lib/prices/yahoo";
import { getFXRatesSafe, convertToBase } from "@/lib/prices/fx";
import { aggregatePortfolio, type PortfolioSummary } from "@/lib/portfolio/aggregate";
import { isStablecoin } from "@/lib/cashflow";
import type { PortfolioSnapshot } from "@/lib/types";

// ─── Types ──────────────────────────────────────────────

export interface ComparisonHoldingItem {
  key: string;             // dedup key: coingecko_id | ticker | "cash:{currency}"
  name: string;            // "Bitcoin", "VWCE", "EUR Cash"
  ticker: string;          // "BTC", "VWCE", "EUR"
  class: "crypto" | "stocks" | "cash";
  imageUrl: string | null; // CoinGecko thumb for crypto, null for others
  viewerValue: number;     // 0 if viewer doesn't hold it
  ownerValue: number;      // 0 if owner doesn't hold it
}

export interface ComparisonData {
  viewer: { name: string; summary: PortfolioSummary };
  owner: { name: string; summary: PortfolioSummary };
  normalizedCurrency: string;
  holdings: ComparisonHoldingItem[];
  viewerSnapshots: PortfolioSnapshot[];
  ownerSnapshots: PortfolioSnapshot[];
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

  // 3. Fetch viewer's portfolio data + snapshots in parallel
  let viewerCrypto: Awaited<ReturnType<typeof getCryptoAssetsWithPositions>>;
  let viewerStocks: Awaited<ReturnType<typeof getStockAssetsWithPositions>>;
  let viewerCashAccounts: Awaited<ReturnType<typeof getCashAccounts>>;
  let viewerSnapshots: Awaited<ReturnType<typeof getSnapshots>>;
  try {
    [viewerCrypto, viewerStocks, viewerCashAccounts, viewerSnapshots] = await Promise.all([
      getCryptoAssetsWithPositions(),
      getStockAssetsWithPositions(),
      getCashAccounts(),
      getSnapshots(365),
    ]);
  } catch (err) {
    console.error("[comparison] Failed to load viewer data:", err);
    return { ok: false, error: "Failed to load comparison data" };
  }

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
      ...viewerCashAccounts.map((a) => a.currency),
      ...ownerData.stockAssets.map((a) => a.currency),
      ...ownerData.cashAccounts.map((a) => a.currency),
    ]),
  ];

  // 5. Single set of price fetches (shared between both aggregations)
  //    Fold EURUSD=X into the stock batch for a single Yahoo request
  const allTickersWithEurUsd = [...new Set([...allYahooTickers, "EURUSD=X"])];
  const [cryptoPrices, allStockPrices, fxRates, fxRatesUsd, fxRatesEur] = await Promise.all([
    getPrices(allCoinIds),
    getStockPrices(allTickersWithEurUsd),
    getFXRatesSafe(viewerCurrency, allCurrencies),
    getFXRatesSafe("USD", allCurrencies.filter((c) => c !== "USD")),
    getFXRatesSafe("EUR", allCurrencies.filter((c) => c !== "EUR")),
  ]);

  const eurUsdChange24h = allStockPrices["EURUSD=X"]?.change24h ?? 0;
  // Separate EURUSD=X from stock prices passed to aggregation
  const stockPrices = Object.fromEntries(
    Object.entries(allStockPrices).filter(([k]) => k !== "EURUSD=X")
  );

  // 6. Aggregate both portfolios with the VIEWER's currency
  const viewerSummary = aggregatePortfolio({
    cryptoAssets: viewerCrypto,
    cryptoPrices,
    stockAssets: viewerStocks,
    stockPrices,
    cashAccounts: viewerCashAccounts,
    primaryCurrency: viewerCurrency,
    fxRates,
    fxRatesUsd,
    fxRatesEur,
    eurUsdChange24h,
  });

  const ownerSummary = aggregatePortfolio({
    cryptoAssets: ownerData.cryptoAssets,
    cryptoPrices,
    stockAssets: ownerData.stockAssets,
    stockPrices,
    cashAccounts: ownerData.cashAccounts,
    primaryCurrency: viewerCurrency,
    fxRates,
    fxRatesUsd,
    fxRatesEur,
    eurUsdChange24h,
  });

  // 7. Compute per-asset holdings for overlap visualization.
  //    Only names/tickers/values leave the server — no quantities or positions.
  const currencyKey = viewerCurrency.toLowerCase() as "usd" | "eur";
  const holdingsMap = new Map<string, ComparisonHoldingItem>();

  function upsertHolding(
    key: string,
    init: Omit<ComparisonHoldingItem, "viewerValue" | "ownerValue">,
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

      const isStable = isStablecoin(asset.subcategory);
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
          class: "stocks",
          imageUrl: null,
        },
        assets.side,
        value
      );
    }
  }

  // Cash holdings (unified cash accounts by currency)
  for (const { list, side } of [
    { list: viewerCashAccounts, side: "viewer" as const },
    { list: ownerData.cashAccounts, side: "owner" as const },
  ]) {
    for (const cash of list) {
      const value = convertToBase(cash.balance, cash.currency, viewerCurrency, fxRates);
      if (value === 0) continue;
      upsertHolding(
        `cash:${cash.currency}`,
        { key: `cash:${cash.currency}`, name: `${cash.currency} Cash`, ticker: cash.currency, class: "cash", imageUrl: null },
        side,
        value
      );
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
      viewerSnapshots,
      ownerSnapshots: ownerData.snapshots,
    },
  };
}
