import { getCryptoAssetsWithPositions, backfillCryptoImages } from "@/lib/actions/crypto";
import { getWallets } from "@/lib/actions/wallets";
import { getProfile } from "@/lib/actions/profile";
import { deriveCashFlows } from "@/lib/actions/benchmark";
import { getPrices } from "@/lib/prices/coingecko";
import { getFXRatesSafe } from "@/lib/prices/fx";
import { getStockPrices } from "@/lib/prices/yahoo";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { computeDeposits } from "@/lib/portfolio/dashboard-changes";
import { CryptoTable } from "@/components/crypto/crypto-table";
import { MobileMenuButton } from "@/components/sidebar";

export default async function CryptoPage() {
  const [assets, wallets, profile, cashFlowResult] = await Promise.all([
    getCryptoAssetsWithPositions(),
    getWallets(),
    getProfile(),
    deriveCashFlows(),
  ]);

  const cashFlows = cashFlowResult.events;

  const cur = profile.primary_currency;

  // Fetch live prices + FX rates + EUR/USD change in parallel
  const coinIds = assets.map((a) => a.coingecko_id);
  const [prices, fxRates, eurUsdBatch] = await Promise.all([
    getPrices(coinIds),
    getFXRatesSafe(cur, ["USD", "EUR"]),
    getStockPrices(["EURUSD=X"]),
  ]);
  const eurUsdData = eurUsdBatch["EURUSD=X"] ?? null;

  // Fire-and-forget: backfill missing icons from CoinGecko. Log failures instead
  // of swallowing silently so operational issues surface in logs.
  backfillCryptoImages().catch((err) => {
    console.warn("[crypto-page] backfillCryptoImages failed:", err instanceof Error ? err.message : err);
  });

  // Compute crypto-only aggregate for summary header enrichment
  const summary = aggregatePortfolio({
    cryptoAssets: assets,
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
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <h1 className="text-2xl font-semibold text-zinc-100">
            Crypto Portfolio
          </h1>
        </div>
      </div>
      <CryptoTable
        assets={assets}
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
