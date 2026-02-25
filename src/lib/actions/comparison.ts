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
import { getFXRates } from "@/lib/prices/fx";
import { aggregatePortfolio, type PortfolioSummary } from "@/lib/portfolio/aggregate";

// ─── Types ──────────────────────────────────────────────

export interface ComparisonData {
  viewer: { name: string; summary: PortfolioSummary };
  owner: { name: string; summary: PortfolioSummary };
  normalizedCurrency: string;
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

  return {
    ok: true,
    data: {
      viewer: { name: viewerName, summary: viewerSummary },
      owner: { name: ownerName, summary: ownerSummary },
      normalizedCurrency: viewerCurrency,
    },
  };
}
