import { getProfile } from "@/lib/actions/profile";
import { getInstitutionsWithRoles } from "@/lib/actions/institutions";
import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getWallets } from "@/lib/actions/wallets";
import { getBrokers } from "@/lib/actions/brokers";
import { getBankAccounts } from "@/lib/actions/bank-accounts";
import { getExchangeDeposits } from "@/lib/actions/exchange-deposits";
import { getBrokerDeposits } from "@/lib/actions/broker-deposits";
import { getPrices } from "@/lib/prices/coingecko";
import { getStockPrices, getDividendYields } from "@/lib/prices/yahoo";
import { getFXRates } from "@/lib/prices/fx";
import { AccountsView } from "@/components/accounts/accounts-view";
import { MobileMenuButton } from "@/components/sidebar";

export default async function AccountsPage() {
  // ── Round 1: DB records + independent fetches in parallel ──
  const [
    profile, institutions, cryptoAssets, stockAssets,
    wallets, brokers, bankAccounts,
    exchangeDeposits, brokerDeposits,
  ] = await Promise.all([
    getProfile(),
    getInstitutionsWithRoles(),
    getCryptoAssetsWithPositions(),
    getStockAssetsWithPositions(),
    getWallets(),
    getBrokers(),
    getBankAccounts(),
    getExchangeDeposits(),
    getBrokerDeposits(),
  ]);

  const primaryCurrency = profile.primary_currency;

  // Build ticker/coin ID lists for price fetching
  const coinIds = cryptoAssets.map((a) => a.coingecko_id);
  const yahooTickers = stockAssets
    .map((a) => a.yahoo_ticker || a.ticker)
    .filter(Boolean);

  // Collect all currencies that need FX conversion
  const allCurrencies = [
    ...new Set([
      "EUR", "USD",
      ...stockAssets.map((a) => a.currency),
      ...bankAccounts.map((a) => a.currency),
      ...exchangeDeposits.map((a) => a.currency),
      ...brokerDeposits.map((a) => a.currency),
    ]),
  ];

  // ── Round 2: Price fetches that depend on Round 1 data ──
  const [cryptoPrices, stockPrices, fxRates, dividends] = await Promise.all([
    getPrices(coinIds),
    getStockPrices(yahooTickers),
    getFXRates(primaryCurrency, allCurrencies),
    getDividendYields(yahooTickers),
  ]);

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <h1 className="text-2xl font-semibold text-zinc-100">Accounts</h1>
        </div>
        <p className="text-sm text-zinc-500 mt-1">
          View all institutions and their assets in one place
        </p>
      </div>
      <AccountsView
        institutions={institutions}
        cryptoAssets={cryptoAssets}
        stockAssets={stockAssets}
        wallets={wallets}
        brokers={brokers}
        bankAccounts={bankAccounts}
        exchangeDeposits={exchangeDeposits}
        brokerDeposits={brokerDeposits}
        cryptoPrices={cryptoPrices}
        stockPrices={stockPrices}
        fxRates={fxRates}
        dividends={dividends}
        primaryCurrency={primaryCurrency}
      />
    </div>
  );
}
