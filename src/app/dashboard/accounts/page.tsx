import { getProfile } from "@/lib/actions/profile";
import { getInstitutionsWithRoles } from "@/lib/actions/institutions";
import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getWallets } from "@/lib/actions/wallets";
import { getBrokers } from "@/lib/actions/brokers";
import { getCashAccounts } from "@/lib/actions/cash-accounts";
import { getPrices } from "@/lib/prices/coingecko";
import { getStockPrices } from "@/lib/prices/yahoo";
import { getFXRatesSafe } from "@/lib/prices/fx";
import { AccountsView } from "@/components/accounts/accounts-view";
import { MobileMenuButton } from "@/components/sidebar";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getLatestManualNavsAt, partitionStockAssetsForPricing, injectManualNavPrices } from "@/lib/manual-nav";

export default async function AccountsPage() {
  // ── Round 1: DB records + independent fetches in parallel ──
  const [
    profile, institutions, cryptoAssets, stockAssets,
    wallets, brokers, cashAccounts,
  ] = await Promise.all([
    getProfile(),
    getInstitutionsWithRoles(),
    getCryptoAssetsWithPositions(),
    getStockAssetsWithPositions(),
    getWallets(),
    getBrokers(),
    getCashAccounts(),
  ]);

  const primaryCurrency = profile.primary_currency;

  // Build ticker/coin ID lists for price fetching. Partition stock assets so
  // kind='manual' get NAV-priced from manual_nav_updates (not Yahoo).
  const coinIds = cryptoAssets.map((a) => a.coingecko_id);
  const { manualStockAssets, yahooTickers } = partitionStockAssetsForPricing(stockAssets);

  // Collect all currencies that need FX conversion
  const allCurrencies = [
    ...new Set([
      "EUR", "USD",
      ...stockAssets.map((a) => a.currency),
      ...cashAccounts.map((a) => a.currency),
    ]),
  ];

  // ── Round 2: Price fetches that depend on Round 1 data ──
  const supabase = await createServerSupabaseClient();
  const today = new Date().toISOString().slice(0, 10);
  const [cryptoPrices, stockPrices, fxRates, manualNavs] = await Promise.all([
    getPrices(coinIds),
    getStockPrices(yahooTickers),
    getFXRatesSafe(primaryCurrency, allCurrencies),
    manualStockAssets.length > 0 ? getLatestManualNavsAt(supabase, today) : Promise.resolve([]),
  ]);
  injectManualNavPrices(manualStockAssets, manualNavs, stockPrices);

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <h1 className="text-2xl font-semibold text-zinc-100">Accounts</h1>
        </div>
        <p className="text-sm text-zinc-400 mt-1">
          View all institutions and their assets in one place
        </p>
      </div>
      <AccountsView
        institutions={institutions}
        cryptoAssets={cryptoAssets}
        stockAssets={stockAssets}
        wallets={wallets}
        brokers={brokers}
        cashAccounts={cashAccounts}
        cryptoPrices={cryptoPrices}
        stockPrices={stockPrices}
        fxRates={fxRates}
        primaryCurrency={primaryCurrency}
      />
    </div>
  );
}
