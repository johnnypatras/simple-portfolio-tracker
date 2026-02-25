import { notFound } from "next/navigation";
import { requireScope } from "../scope-gate";
import { getSharedPortfolio } from "@/lib/actions/shared-portfolio";
import { getPrices } from "@/lib/prices/coingecko";
import { getFXRates } from "@/lib/prices/fx";
import { fetchSinglePrice } from "@/lib/prices/yahoo";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { CashTable } from "@/components/cash/cash-table";

export default async function SharedCashPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  await requireScope(token, "full");

  const data = await getSharedPortfolio(token);
  if (!data) notFound();

  const { bankAccounts, exchangeDeposits, brokerDeposits, wallets, brokers, cryptoAssets, profile } = data;
  const cur = profile.primary_currency;

  // Stablecoins are reclassified as cash
  const stablecoins = cryptoAssets.filter((a) => a.subcategory?.toLowerCase() === "stablecoin");

  const allCurrencies = [
    ...new Set([
      "USD", "EUR",
      ...bankAccounts.map((b) => b.currency),
      ...exchangeDeposits.map((d) => d.currency),
      ...brokerDeposits.map((d) => d.currency),
    ]),
  ];

  const [stablecoinPrices, fxRates, eurUsdData] = await Promise.all([
    stablecoins.length > 0
      ? getPrices(stablecoins.map((a) => a.coingecko_id))
      : Promise.resolve({}),
    getFXRates(cur, allCurrencies),
    fetchSinglePrice("EURUSD=X"),
  ]);

  const summary = aggregatePortfolio({
    cryptoAssets: stablecoins,
    cryptoPrices: stablecoinPrices,
    stockAssets: [],
    stockPrices: {},
    bankAccounts,
    exchangeDeposits,
    brokerDeposits,
    primaryCurrency: cur,
    fxRates,
    eurUsdChange24h: eurUsdData?.change24h ?? 0,
  });

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Banks & Deposits</h1>
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
        primaryCurrency={cur}
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
