import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getWallets } from "@/lib/actions/wallets";
import { getProfile } from "@/lib/actions/profile";
import { getPrices } from "@/lib/prices/coingecko";
import { CryptoTable } from "@/components/crypto/crypto-table";
import { MobileMenuButton } from "@/components/sidebar";

export default async function CryptoPage() {
  const [assets, wallets, profile] = await Promise.all([
    getCryptoAssetsWithPositions(),
    getWallets(),
    getProfile(),
  ]);

  // Fetch live prices for all tracked coins in one batched call
  const coinIds = assets.map((a) => a.coingecko_id);
  const prices = await getPrices(coinIds);

  const cur = profile.primary_currency;

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
      />
    </div>
  );
}
