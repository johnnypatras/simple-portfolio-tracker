import { notFound } from "next/navigation";
import { requireScope } from "../scope-gate";
import { getSharedPortfolio } from "@/lib/actions/shared-portfolio";
import { getPrices } from "@/lib/prices/coingecko";
import { getStockPrices, getDividendYields, fetchSinglePrice } from "@/lib/prices/yahoo";
import { getFXRates } from "@/lib/prices/fx";
import { AccountsView } from "@/components/accounts/accounts-view";

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
    institutions, cryptoAssets, stockAssets, wallets, brokers,
    bankAccounts, exchangeDeposits, brokerDeposits, profile,
  } = data;
  const primaryCurrency = profile.primary_currency;

  const coinIds = cryptoAssets.map((a) => a.coingecko_id);
  const yahooTickers = stockAssets.map((a) => a.yahoo_ticker || a.ticker).filter(Boolean);
  const allCurrencies = [
    ...new Set([
      "EUR", "USD",
      ...stockAssets.map((a) => a.currency),
      ...bankAccounts.map((a) => a.currency),
      ...exchangeDeposits.map((a) => a.currency),
      ...brokerDeposits.map((a) => a.currency),
    ]),
  ];

  const [cryptoPrices, stockPrices, fxRates, dividends] = await Promise.all([
    getPrices(coinIds),
    getStockPrices(yahooTickers),
    getFXRates(primaryCurrency, allCurrencies),
    getDividendYields(yahooTickers),
  ]);

  return (
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
  );
}
