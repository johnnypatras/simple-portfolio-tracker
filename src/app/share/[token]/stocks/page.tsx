import { notFound } from "next/navigation";
import { requireScope } from "../scope-gate";
import { getSharedPortfolio } from "@/lib/actions/shared-portfolio";
import { getStockPrices, getDividendYields, fetchSinglePrice } from "@/lib/prices/yahoo";
import { getFXRates } from "@/lib/prices/fx";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";
import { StockTable } from "@/components/stocks/stock-table";

export default async function SharedStocksPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  await requireScope(token, "full");

  const data = await getSharedPortfolio(token);
  if (!data) notFound();

  const { stockAssets, brokers, profile } = data;
  const cur = profile.primary_currency;

  const yahooTickers = stockAssets
    .map((a) => a.yahoo_ticker || a.ticker)
    .filter(Boolean);

  const uniqueCurrencies = [...new Set(["USD", "EUR", ...stockAssets.map((a) => a.currency)])];
  const [prices, fxRates, eurUsdData, dividends] = await Promise.all([
    getStockPrices(yahooTickers),
    getFXRates(cur, uniqueCurrencies),
    fetchSinglePrice("EURUSD=X"),
    getDividendYields(yahooTickers),
  ]);

  const summary = aggregatePortfolio({
    cryptoAssets: [],
    cryptoPrices: {},
    stockAssets,
    stockPrices: prices,
    bankAccounts: [],
    exchangeDeposits: [],
    brokerDeposits: [],
    primaryCurrency: cur,
    fxRates,
    eurUsdChange24h: eurUsdData?.change24h ?? 0,
  });

  return (
    <StockTable
      assets={stockAssets}
      brokers={brokers}
      prices={prices}
      primaryCurrency={cur}
      fxRates={fxRates}
      fxChangePercent={summary.stocksFxChange24hPercent}
      fxChangeValue={summary.stocksFxValueChange24h}
      dividends={dividends}
    />
  );
}
