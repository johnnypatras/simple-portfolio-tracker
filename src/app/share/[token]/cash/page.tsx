import { notFound } from "next/navigation";
import { requireScope } from "../scope-gate";
import { getSharedPortfolio } from "@/lib/actions/shared-portfolio";
import { deriveCashFlows } from "@/lib/actions/benchmark";
import { getPrices } from "@/lib/prices/coingecko";
import { getFXRatesSafe } from "@/lib/prices/fx";
import { getStockPrices } from "@/lib/prices/yahoo";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { computeDeposits } from "@/lib/portfolio/dashboard-changes";
import { CashTable } from "@/components/cash/cash-table";
import { isStablecoin } from "@/lib/cashflow";

export default async function SharedCashPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  await requireScope(token, "full");

  const data = await getSharedPortfolio(token);
  if (!data) notFound();

  const { cashAccounts, cryptoAssets, profile, share } = data;
  const cur = profile.primary_currency;

  // Stablecoins are reclassified as cash
  const stablecoins = cryptoAssets.filter((a) => isStablecoin(a.subcategory));

  const allCurrencies = [
    ...new Set([
      "USD", "EUR",
      ...cashAccounts.map((a) => a.currency),
    ]),
  ];

  // fxRatesUsd/fxRatesEur enable direct (not 2-legged cross) conversion for the
  // USD/EUR snapshot sub-lines in aggregatePortfolio — see assemble.ts.
  const [stablecoinPrices, fxRates, fxRatesUsd, fxRatesEur, eurUsdBatch, cashFlowResult] = await Promise.all([
    stablecoins.length > 0
      ? getPrices(stablecoins.map((a) => a.coingecko_id))
      : Promise.resolve({}),
    getFXRatesSafe(cur, allCurrencies),
    getFXRatesSafe("USD", allCurrencies.filter((c) => c !== "USD")),
    getFXRatesSafe("EUR", allCurrencies.filter((c) => c !== "EUR")),
    getStockPrices(["EURUSD=X"]),
    deriveCashFlows(share.owner_id),
  ]);

  const cashFlows = cashFlowResult.events;
  const eurUsdData = eurUsdBatch["EURUSD=X"] ?? null;

  const summary = aggregatePortfolio({
    cryptoAssets: stablecoins,
    cryptoPrices: stablecoinPrices,
    stockAssets: [],
    stockPrices: {},
    cashAccounts,
    primaryCurrency: cur,
    fxRates,
    fxRatesUsd,
    fxRatesEur,
    eurUsdChange24h: eurUsdData?.change24h ?? 0,
  });

  const fxMul = cur === "USD" || summary.totalValueUsd === 0 ? 1 : summary.totalValue / summary.totalValueUsd;
  const dep = computeDeposits("24h", cashFlows, cur, fxMul, "cash");

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Banks & Deposits</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Bank accounts and fiat deposits
        </p>
      </div>
      <CashTable
        cashAccounts={cashAccounts}
        primaryCurrency={cur}
        fxRates={fxRates}
        stablecoins={stablecoins}
        stablecoinPrices={stablecoinPrices}
        cashChangePercent={summary.change24hPercent}
        cashChangeValue={summary.cashTotalValueChange24h}
        fxValueChange24h={summary.cashTotalFxValueChange24h}
        deposits={dep.total}
        depositBreakdown={dep.breakdown}
      />
    </div>
  );
}
