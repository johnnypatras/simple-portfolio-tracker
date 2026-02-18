import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/actions/profile";
import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getBankAccounts } from "@/lib/actions/bank-accounts";
import { getExchangeDeposits } from "@/lib/actions/exchange-deposits";
import { getPrices } from "@/lib/prices/coingecko";
import { getStockPrices } from "@/lib/prices/yahoo";
import { getFXRates } from "@/lib/prices/fx";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { PortfolioCards } from "@/components/dashboard/portfolio-cards";

export default async function DashboardPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Fetch all portfolio data in parallel
  const [profile, cryptoAssets, stockAssets, bankAccounts, exchangeDeposits] =
    await Promise.all([
      getProfile(),
      getCryptoAssetsWithPositions(),
      getStockAssetsWithPositions(),
      getBankAccounts(),
      getExchangeDeposits(),
    ]);

  const primaryCurrency = profile.primary_currency;

  // Build ticker/coin ID lists for price fetching
  const coinIds = cryptoAssets.map((a) => a.coingecko_id);
  const yahooTickers = stockAssets
    .map((a) => a.yahoo_ticker || a.ticker)
    .filter(Boolean);

  // Collect all unique currencies that need FX conversion
  const allCurrencies = [
    ...new Set([
      ...stockAssets.map((a) => a.currency),
      ...bankAccounts.map((a) => a.currency),
      ...exchangeDeposits.map((a) => a.currency),
    ]),
  ];

  // Fetch prices + FX rates in parallel
  const [cryptoPrices, stockPrices, fxRates] = await Promise.all([
    getPrices(coinIds),
    getStockPrices(yahooTickers),
    getFXRates(primaryCurrency, allCurrencies),
  ]);

  // Aggregate everything into a single summary
  const summary = aggregatePortfolio({
    cryptoAssets,
    cryptoPrices,
    stockAssets,
    stockPrices,
    bankAccounts,
    exchangeDeposits,
    primaryCurrency,
    fxRates,
  });

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Dashboard</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Welcome back{user?.email ? `, ${user.email}` : ""}
        </p>
      </div>

      <PortfolioCards summary={summary} />
    </div>
  );
}
