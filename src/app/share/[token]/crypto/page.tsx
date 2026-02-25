import { notFound } from "next/navigation";
import { requireScope } from "../scope-gate";
import { getSharedPortfolio } from "@/lib/actions/shared-portfolio";
import { getPrices } from "@/lib/prices/coingecko";
import { getFXRates } from "@/lib/prices/fx";
import { fetchSinglePrice } from "@/lib/prices/yahoo";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { CryptoTable } from "@/components/crypto/crypto-table";

export default async function SharedCryptoPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  await requireScope(token, "full");

  const data = await getSharedPortfolio(token);
  if (!data) notFound();

  const { cryptoAssets, wallets, profile } = data;
  const cur = profile.primary_currency;

  const coinIds = cryptoAssets.map((a) => a.coingecko_id);
  const [prices, fxRates, eurUsdData] = await Promise.all([
    getPrices(coinIds),
    getFXRates(cur, ["USD", "EUR"]),
    fetchSinglePrice("EURUSD=X"),
  ]);

  const summary = aggregatePortfolio({
    cryptoAssets,
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
    <CryptoTable
      assets={cryptoAssets}
      prices={prices}
      wallets={wallets}
      primaryCurrency={cur}
      fxChangePercent={summary.cryptoFxChange24hPercent}
      fxChangeValue={summary.cryptoFxValueChange24h}
      stablecoinChange={summary.stablecoinValueChange24h}
    />
  );
}
