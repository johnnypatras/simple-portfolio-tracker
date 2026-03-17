import { notFound } from "next/navigation";
import { requireScope } from "../scope-gate";
import { getSharedPortfolio } from "@/lib/actions/shared-portfolio";
import { deriveCashFlows } from "@/lib/actions/benchmark";
import { getPrices } from "@/lib/prices/coingecko";
import { getFXRatesSafe } from "@/lib/prices/fx";
import { getStockPrices } from "@/lib/prices/yahoo";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { computeDeposits } from "@/lib/portfolio/dashboard-changes";
import { CryptoTable } from "@/components/crypto/crypto-table";

export default async function SharedCryptoPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  await requireScope(token, "full");

  const data = await getSharedPortfolio(token);
  if (!data) notFound();

  const { cryptoAssets, wallets, profile, share } = data;
  const cur = profile.primary_currency;

  const coinIds = cryptoAssets.map((a) => a.coingecko_id);
  const [prices, fxRates, eurUsdBatch, cashFlowResult] = await Promise.all([
    getPrices(coinIds),
    getFXRatesSafe(cur, ["USD", "EUR"]),
    getStockPrices(["EURUSD=X"]),
    deriveCashFlows(share.owner_id),
  ]);

  const cashFlows = cashFlowResult.events;
  const eurUsdData = eurUsdBatch["EURUSD=X"] ?? null;

  const summary = aggregatePortfolio({
    cryptoAssets,
    cryptoPrices: prices,
    stockAssets: [],
    stockPrices: {},
    cashAccounts: [],
    primaryCurrency: cur,
    fxRates,
    eurUsdChange24h: eurUsdData?.change24h ?? 0,
  });

  const fxMul = cur === "USD" || summary.totalValueUsd === 0 ? 1 : summary.totalValue / summary.totalValueUsd;
  const dep = computeDeposits("24h", cashFlows, cur, fxMul, "crypto");

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Crypto Portfolio</h1>
      </div>
      <CryptoTable
        assets={cryptoAssets}
        prices={prices}
        wallets={wallets}
        primaryCurrency={cur}
        fxRates={fxRates}
        fxValueChange24h={summary.cryptoFxValueChange24h}
        deposits={dep.total}
        depositBreakdown={dep.breakdown}
      />
    </div>
  );
}
