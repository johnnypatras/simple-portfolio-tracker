import { getCashAccounts } from "@/lib/actions/cash-accounts";
import { getInstitutionsWithRoles } from "@/lib/actions/institutions";
import { getProfile } from "@/lib/actions/profile";
import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { deriveCashFlows } from "@/lib/actions/benchmark";
import { getPrices } from "@/lib/prices/coingecko";
import { getFXRatesSafe } from "@/lib/prices/fx";
import { getStockPrices } from "@/lib/prices/yahoo";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { getOwnerAssetTransactions } from "@/lib/portfolio/owner-pnl";
import { computeDeposits } from "@/lib/portfolio/dashboard-changes";
import { CashTable } from "@/components/cash/cash-table";
import { MobileMenuButton } from "@/components/sidebar";
import { isStablecoin } from "@/lib/cashflow";

export default async function CashPage() {
  const [cashAccounts, profile, cryptoAssets, cashFlowResult, institutions] =
    await Promise.all([
      getCashAccounts(),
      getProfile(),
      getCryptoAssetsWithPositions(),
      deriveCashFlows(),
      getInstitutionsWithRoles(),
    ]);

  const cashFlows = cashFlowResult.events;

  // Stablecoins are reclassified as cash — fetch their CoinGecko prices
  const stablecoins = cryptoAssets.filter((a) => isStablecoin(a.subcategory));

  // Collect all currencies that need FX conversion
  const allCurrencies = [
    ...new Set([
      "USD", "EUR", // always include for EUR/USD cross rate
      ...cashAccounts.map((a) => a.currency),
    ]),
  ];

  // Fetch stablecoin prices + FX rates + EUR/USD change in parallel.
  // fxRatesUsd/fxRatesEur enable direct (not 2-legged cross) conversion for the
  // USD/EUR snapshot sub-lines in aggregatePortfolio — see assemble.ts.
  const [stablecoinPrices, fxRates, fxRatesUsd, fxRatesEur, eurUsdBatch, assetTransactions] = await Promise.all([
    stablecoins.length > 0
      ? getPrices(stablecoins.map((a) => a.coingecko_id))
      : Promise.resolve({}),
    getFXRatesSafe(profile.primary_currency, allCurrencies),
    getFXRatesSafe("USD", allCurrencies.filter((c) => c !== "USD")),
    getFXRatesSafe("EUR", allCurrencies.filter((c) => c !== "EUR")),
    getStockPrices(["EURUSD=X"]),
    getOwnerAssetTransactions(),
  ]);
  const eurUsdData = eurUsdBatch["EURUSD=X"] ?? null;

  // Compute cash-only aggregate for summary header enrichment
  const summary = aggregatePortfolio({
    cryptoAssets: stablecoins,
    cryptoPrices: stablecoinPrices,
    stockAssets: [],
    stockPrices: {},
    cashAccounts,
    primaryCurrency: profile.primary_currency,
    fxRates,
    fxRatesUsd,
    fxRatesEur,
    eurUsdChange24h: eurUsdData?.change24h ?? 0,
    // null → no P&L computed (graceful degradation already logged in the helper).
    assetTransactions: assetTransactions ?? undefined,
  });

  const cur = profile.primary_currency;
  const fxMul = cur === "USD" || summary.totalValueUsd === 0 ? 1 : summary.totalValue / summary.totalValueUsd;
  const dep = computeDeposits("24h", cashFlows, cur, fxMul, "cash");

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <h1 className="text-2xl font-semibold text-zinc-100">Banks & Deposits</h1>
        </div>
        <p className="text-sm text-zinc-400 mt-1">
          Bank accounts and fiat deposits
        </p>
      </div>
      <CashTable
        cashAccounts={cashAccounts}
        primaryCurrency={profile.primary_currency}
        fxRates={fxRates}
        stablecoins={stablecoins}
        stablecoinPrices={stablecoinPrices}
        cashChangePercent={summary.change24hPercent}
        cashChangeValue={summary.cashTotalValueChange24h}
        fxValueChange24h={summary.cashTotalFxValueChange24h}
        deposits={dep.total}
        depositBreakdown={dep.breakdown}
        institutions={institutions}
        pnlByAsset={summary.pnlByAsset}
      />
    </div>
  );
}
