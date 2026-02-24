import { getBankAccounts } from "@/lib/actions/bank-accounts";
import { getExchangeDeposits } from "@/lib/actions/exchange-deposits";
import { getBrokerDeposits } from "@/lib/actions/broker-deposits";
import { getWallets } from "@/lib/actions/wallets";
import { getBrokers } from "@/lib/actions/brokers";
import { getProfile } from "@/lib/actions/profile";
import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getPrices } from "@/lib/prices/coingecko";
import { getFXRates } from "@/lib/prices/fx";
import { CashTable } from "@/components/cash/cash-table";
import { MobileMenuButton } from "@/components/sidebar";

export default async function CashPage() {
  const [bankAccounts, exchangeDeposits, brokerDeposits, wallets, brokers, profile, cryptoAssets] =
    await Promise.all([
      getBankAccounts(),
      getExchangeDeposits(),
      getBrokerDeposits(),
      getWallets(),
      getBrokers(),
      getProfile(),
      getCryptoAssetsWithPositions(),
    ]);

  // Stablecoins are reclassified as cash — fetch their CoinGecko prices
  const stablecoins = cryptoAssets.filter((a) => a.subcategory?.toLowerCase() === "stablecoin");

  // Collect all currencies that need FX conversion
  const allCurrencies = [
    ...new Set([
      ...bankAccounts.map((b) => b.currency),
      ...exchangeDeposits.map((d) => d.currency),
      ...brokerDeposits.map((d) => d.currency),
    ]),
  ];

  // Fetch stablecoin prices + FX rates in parallel (both depend on round 1 only)
  const [stablecoinPrices, fxRates] = await Promise.all([
    stablecoins.length > 0
      ? getPrices(stablecoins.map((a) => a.coingecko_id))
      : Promise.resolve({}),
    getFXRates(profile.primary_currency, allCurrencies),
  ]);

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <h1 className="text-2xl font-semibold text-zinc-100">Banks & Deposits</h1>
        </div>
        <p className="text-sm text-zinc-500 mt-1">
          Bank accounts and exchange / broker deposits
        </p>
      </div>
      <CashTable
        bankAccounts={bankAccounts}
        exchangeDeposits={exchangeDeposits}
        brokerDeposits={brokerDeposits}
        wallets={wallets}
        brokers={brokers}
        primaryCurrency={profile.primary_currency}
        fxRates={fxRates}
        stablecoins={stablecoins}
        stablecoinPrices={stablecoinPrices}
      />
    </div>
  );
}
