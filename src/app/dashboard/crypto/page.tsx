import { getCryptoAssetsWithPositions, backfillCryptoImages } from "@/lib/actions/crypto";
import { getWallets } from "@/lib/actions/wallets";
import { getProfile } from "@/lib/actions/profile";
import { getPrices } from "@/lib/prices/coingecko";
import { getFXRates } from "@/lib/prices/fx";
import { fetchSinglePrice } from "@/lib/prices/yahoo";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { CryptoTable } from "@/components/crypto/crypto-table";
import { MobileMenuButton } from "@/components/sidebar";

export default async function CryptoPage() {
  const [assets, wallets, profile] = await Promise.all([
    getCryptoAssetsWithPositions(),
    getWallets(),
    getProfile(),
  ]);

  const cur = profile.primary_currency;

  // Fetch live prices + FX rates + EUR/USD change in parallel
  const coinIds = assets.map((a) => a.coingecko_id);
  const [prices, fxRates, eurUsdData] = await Promise.all([
    getPrices(coinIds),
    getFXRates(cur, ["USD", "EUR"]),
    fetchSinglePrice("EURUSD=X"),
  ]);

  // Fire-and-forget: backfill missing icons from CoinGecko
  backfillCryptoImages().catch(() => {});

  // Compute crypto-only aggregate for summary header enrichment
  const summary = aggregatePortfolio({
    cryptoAssets: assets,
    cryptoPrices: prices,
    stockAssets: [],
    stockPrices: {},
    bankAccounts: [],
    exchangeDeposits: [],
    brokerDeposits: [],
    primaryCurrency: cur,
    fxRates,
    eurUsdChange24h: eurUsdData?.change24h ?? 0,
  });

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
        fxChangePercent={summary.cryptoFxChange24hPercent}
        fxChangeValue={summary.cryptoFxValueChange24h}
        stablecoinChange={summary.stablecoinValueChange24h}
      />
    </div>
  );
}
