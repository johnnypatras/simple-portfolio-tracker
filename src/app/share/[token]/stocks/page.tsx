import { notFound } from "next/navigation";
import { requireScope } from "../scope-gate";
import { getSharedPortfolio } from "@/lib/actions/shared-portfolio";
import { deriveCashFlows } from "@/lib/actions/benchmark";
import { getStockAndIndexPrices } from "@/lib/prices/yahoo";
import { getFXRatesSafe } from "@/lib/prices/fx";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { computeDeposits } from "@/lib/portfolio/dashboard-changes";
import { StockTable } from "@/components/stocks/stock-table";

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

  const yahooTickers = stockAssets
    .map((a) => a.yahoo_ticker || a.ticker)
    .filter(Boolean);

  const uniqueCurrencies = [...new Set(["USD", "EUR", ...stockAssets.map((a) => a.currency)])];
  const [{ stockPrices: prices, indexPrices, dividends }, fxRates, cashFlowResult] = await Promise.all([
    getStockAndIndexPrices(yahooTickers),
    getFXRatesSafe(cur, uniqueCurrencies),
    deriveCashFlows(share.owner_id),
  ]);

  const cashFlows = cashFlowResult.events;
  const eurUsdData = indexPrices["EURUSD=X"] ?? null;

  const summary = aggregatePortfolio({
    cryptoAssets: [],
    cryptoPrices: {},
    stockAssets,
    stockPrices: prices,
    bankAccounts: [],
    exchangeDeposits: [],
    brokerDeposits: [],
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
      />
    </div>
  );
}
