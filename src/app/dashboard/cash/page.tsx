import { getBankAccounts } from "@/lib/actions/bank-accounts";
import { getExchangeDeposits } from "@/lib/actions/exchange-deposits";
import { getBrokerDeposits } from "@/lib/actions/broker-deposits";
import { getWallets } from "@/lib/actions/wallets";
import { getBrokers } from "@/lib/actions/brokers";
import { getProfile } from "@/lib/actions/profile";
import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getPrices } from "@/lib/prices/coingecko";
import { getFXRates } from "@/lib/prices/fx";
import { getStockPrices } from "@/lib/prices/yahoo";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
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
      "USD", "EUR", // always include for EUR/USD cross rate
      ...bankAccounts.map((b) => b.currency),
      ...exchangeDeposits.map((d) => d.currency),
      ...brokerDeposits.map((d) => d.currency),
    ]),
  ];

  // Fetch stablecoin prices + FX rates + EUR/USD change in parallel
  const [stablecoinPrices, fxRates, eurUsdBatch] = await Promise.all([
    stablecoins.length > 0
      ? getPrices(stablecoins.map((a) => a.coingecko_id))
      : Promise.resolve({}),
    getFXRates(profile.primary_currency, allCurrencies),
    getStockPrices(["EURUSD=X"]),
  ]);
  const eurUsdData = eurUsdBatch["EURUSD=X"] ?? null;

  // Compute cash-only aggregate for summary header enrichment
  const summary = aggregatePortfolio({
    cryptoAssets: stablecoins,
    cryptoPrices: stablecoinPrices,
    stockAssets: [],
    stockPrices: {},
    bankAccounts,
    exchangeDeposits,
    brokerDeposits,
    primaryCurrency: profile.primary_currency,
    fxRates,
    eurUsdChange24h: eurUsdData?.change24h ?? 0,
  });

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <h1 className="text-2xl font-semibold text-zinc-100">Banks & Deposits</h1>
        </div>
        <p className="text-sm text-zinc-500 mt-1">
          Bank accounts and fiat deposits
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
        cashChangePercent={summary.change24hPercent}
        cashChangeValue={summary.cashTotalValueChange24h}
        fxChangePercent={summary.cashTotalFxChange24hPercent}
        fxChangeValue={summary.cashTotalFxValueChange24h}
        stablecoinChange={summary.stablecoinValueChange24h}
      />
    </div>
  );
}
