import { notFound } from "next/navigation";
import { requireScope } from "../scope-gate";
import { getSharedPortfolio } from "@/lib/actions/shared-portfolio";
import { getPrices } from "@/lib/prices/coingecko";
import { getStockPrices } from "@/lib/prices/yahoo";
import { getFXRatesSafe } from "@/lib/prices/fx";
import { AccountsView } from "@/components/accounts/accounts-view";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getLatestManualNavsAt,
  partitionStockAssetsForPricing,
  injectManualNavPrices,
} from "@/lib/manual-nav";

export default async function SharedAccountsPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  await requireScope(token, "full");

  const data = await getSharedPortfolio(token);
  if (!data) notFound();

  const {
    share, institutions, cryptoAssets, stockAssets, wallets, brokers,
    cashAccounts, profile,
  } = data;
  const primaryCurrency = profile.primary_currency;

  const coinIds = cryptoAssets.map((a) => a.coingecko_id);
  const { manualStockAssets, yahooTickers } = partitionStockAssetsForPricing(stockAssets);
  const allCurrencies = [
    ...new Set([
      "EUR", "USD",
      ...stockAssets.map((a) => a.currency),
      ...cashAccounts.map((a) => a.currency),
    ]),
  ];

  // Cross-user manual NAV lookup uses the admin client with explicit owner_id.
  const admin = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);
  const [cryptoPrices, stockPrices, fxRates, manualNavs] = await Promise.all([
    getPrices(coinIds),
    getStockPrices(yahooTickers),
    getFXRatesSafe(primaryCurrency, allCurrencies),
    manualStockAssets.length > 0
      ? getLatestManualNavsAt(admin, today, share.owner_id)
      : Promise.resolve([]),
  ]);
  injectManualNavPrices(manualStockAssets, manualNavs, stockPrices);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Accounts</h1>
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
