import { notFound } from "next/navigation";
import { requireScope } from "../scope-gate";
import { getSharedPortfolio } from "@/lib/actions/shared-portfolio";
import { deriveCashFlows } from "@/lib/actions/benchmark";
import { getStockAndIndexPrices } from "@/lib/prices/yahoo";
import { getFXRatesSafe } from "@/lib/prices/fx";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { computeDeposits } from "@/lib/portfolio/dashboard-changes";
import { StockTable } from "@/components/stocks/stock-table";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getLatestManualNavsAt,
  partitionStockAssetsForPricing,
  injectManualNavPrices,
} from "@/lib/manual-nav";

export default async function SharedStocksPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  await requireScope(token, "full");

  const data = await getSharedPortfolio(token);
  if (!data) notFound();

  const { stockAssets, brokers, profile, share } = data;
  const cur = profile.primary_currency;

  // Partition Yahoo vs manual NAV assets before pricing — only Yahoo tickers
  // need the batch quote endpoint; manual ones resolve via manual_nav_updates.
  const { manualStockAssets, yahooTickers } = partitionStockAssetsForPricing(stockAssets);

  // Service-role admin client for the cross-user NAV lookup (the viewer is
  // not the asset owner). RLS would scope to the viewer's auth.uid() and
  // return zero rows; admin bypasses RLS but we pass the owner's user_id
  // explicitly so the SQL function still scopes correctly.
  const admin = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);

  const uniqueCurrencies = [...new Set(["USD", "EUR", ...stockAssets.map((a) => a.currency)])];
  const [{ stockPrices: prices, indexPrices, dividends }, fxRates, cashFlowResult, manualNavs] = await Promise.all([
    getStockAndIndexPrices(yahooTickers),
    getFXRatesSafe(cur, uniqueCurrencies),
    deriveCashFlows(share.owner_id),
    manualStockAssets.length > 0
      ? getLatestManualNavsAt(admin, today, share.owner_id)
      : Promise.resolve([]),
  ]);
  injectManualNavPrices(manualStockAssets, manualNavs, prices);

  const cashFlows = cashFlowResult.events;
  const eurUsdData = indexPrices["EURUSD=X"] ?? null;

  const summary = aggregatePortfolio({
    cryptoAssets: [],
    cryptoPrices: {},
    stockAssets,
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
        <h1 className="text-2xl font-semibold text-zinc-100">Equities</h1>
      </div>
      <StockTable
        assets={stockAssets}
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
