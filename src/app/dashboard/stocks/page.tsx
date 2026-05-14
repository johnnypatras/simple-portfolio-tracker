import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getBrokers } from "@/lib/actions/brokers";
import { getProfile } from "@/lib/actions/profile";
import { deriveCashFlows } from "@/lib/actions/benchmark";
import { getStockAndIndexPrices } from "@/lib/prices/yahoo";
import { getFXRatesSafe } from "@/lib/prices/fx";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { computeDeposits } from "@/lib/portfolio/dashboard-changes";
import { StockTable } from "@/components/stocks/stock-table";
import { StaleNavBanner } from "@/components/stocks/stale-nav-banner";
import { MobileMenuButton } from "@/components/sidebar";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getLatestManualNavsAt, partitionStockAssetsForPricing, injectManualNavPrices } from "@/lib/manual-nav";

export default async function StocksPage() {
  const [assets, brokers, profile, cashFlowResult] = await Promise.all([
    getStockAssetsWithPositions(),
    getBrokers(),
    getProfile(),
    deriveCashFlows(),
  ]);

  const cashFlows = cashFlowResult.events;

  // Partition by kind: Yahoo batch covers kind='yahoo'; kind='manual' are priced
  // via manual_nav_updates and injected below.
  const { manualStockAssets, yahooTickers } = partitionStockAssetsForPricing(assets);

  // Fetch prices + FX rates + latest manual NAVs in parallel
  const cur = profile.primary_currency;
  const uniqueCurrencies = [...new Set(["USD", "EUR", ...assets.map((a) => a.currency)])];
  const supabase = await createServerSupabaseClient();
  const today = new Date().toISOString().slice(0, 10);
  const [{ stockPrices: prices, indexPrices, dividends }, fxRates, manualNavs] = await Promise.all([
    getStockAndIndexPrices(yahooTickers),
    getFXRatesSafe(cur, uniqueCurrencies),
    manualStockAssets.length > 0 ? getLatestManualNavsAt(supabase, today) : Promise.resolve([]),
  ]);
  injectManualNavPrices(manualStockAssets, manualNavs, prices);
  const eurUsdData = indexPrices["EURUSD=X"] ?? null;

  // Compute stocks-only aggregate for summary header enrichment
  const summary = aggregatePortfolio({
    cryptoAssets: [],
    cryptoPrices: {},
    stockAssets: assets,
    stockPrices: prices,
    cashAccounts: [],
    primaryCurrency: cur,
    fxRates,
    eurUsdChange24h: eurUsdData?.change24h ?? 0,
  });

  const fxMul = cur === "USD" || summary.totalValueUsd === 0 ? 1 : summary.totalValue / summary.totalValueUsd;
  const dep = computeDeposits("24h", cashFlows, cur, fxMul, "stocks");

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <h1 className="text-2xl font-semibold text-zinc-100">Equities</h1>
        </div>
      </div>
      {manualStockAssets.length > 0 && (
        <StaleNavBanner
          assets={manualStockAssets.map((a) => {
            const nav = manualNavs.find((n) => n.asset_id === a.id);
            return {
              ticker: a.ticker,
              name: a.name,
              latestNavDate: nav?.effective_date ?? null,
            };
          })}
        />
      )}
      <StockTable
        assets={assets}
        brokers={brokers}
        prices={prices}
        primaryCurrency={cur}
        fxRates={fxRates}
        dividends={dividends}
        fxValueChange24h={summary.stocksFxValueChange24h}
        deposits={dep.total}
        depositBreakdown={dep.breakdown}
        latestManualNavDates={Object.fromEntries(
          manualNavs.map((n) => [n.asset_id, n.effective_date])
        )}
      />
    </div>
  );
}
