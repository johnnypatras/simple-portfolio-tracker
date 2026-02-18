import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getWallets } from "@/lib/actions/wallets";
import { getProfile } from "@/lib/actions/profile";
import { getPrices } from "@/lib/prices/coingecko";
import { CryptoTable } from "@/components/crypto/crypto-table";

export default async function CryptoPage() {
  const [assets, wallets, profile] = await Promise.all([
    getCryptoAssetsWithPositions(),
    getWallets(),
    getProfile(),
  ]);

  // Fetch live prices for all tracked coins in one batched call
  const coinIds = assets.map((a) => a.coingecko_id);
  const prices = await getPrices(coinIds);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">
          Crypto Portfolio
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Manage your cryptocurrency holdings across wallets
        </p>
      </div>
      <CryptoTable
        assets={assets}
        prices={prices}
        wallets={wallets}
        primaryCurrency={profile.primary_currency}
      />
    </div>
  );
}
