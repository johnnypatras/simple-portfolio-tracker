import type {
  CryptoAssetWithPositions,
  StockAssetWithPositions,
  BankAccount,
  ExchangeDeposit,
  BrokerDeposit,
  HoldingItem,
  CoinGeckoPriceData,
  YahooStockPriceData,
} from "@/lib/types";
import { convertToBase } from "@/lib/prices/fx";

interface BuildPaletteHoldingsInput {
  cryptoAssets: CryptoAssetWithPositions[];
  cryptoPrices: CoinGeckoPriceData;
  stockAssets: StockAssetWithPositions[];
  stockPrices: YahooStockPriceData;
  bankAccounts: BankAccount[];
  exchangeDeposits: ExchangeDeposit[];
  brokerDeposits: BrokerDeposit[];
  fxRates: Record<string, number>;
  primaryCurrency: string;
  /** Path prefix for detail links, e.g. "/dashboard" or "/share/abc123" */
  pathPrefix: string;
}

/**
 * Builds the flat HoldingItem array used by the command palette.
 * Shared across dashboard page, share page, and /api/holdings.
 */
export function buildPaletteHoldings({
  cryptoAssets,
  cryptoPrices,
  stockAssets,
  stockPrices,
  bankAccounts,
  exchangeDeposits,
  brokerDeposits,
  fxRates,
  primaryCurrency,
  pathPrefix,
}: BuildPaletteHoldingsInput): HoldingItem[] {
  return [
    ...cryptoAssets.map((a) => {
      const price = cryptoPrices[a.coingecko_id];
      const totalQty = a.positions.reduce((s, p) => s + p.quantity, 0);
      const priceUsd = price?.usd ?? 0;
      const valueBase = convertToBase(priceUsd * totalQty, "USD", primaryCurrency, fxRates);
      const priceBase = convertToBase(priceUsd, "USD", primaryCurrency, fxRates);
      return {
        id: a.id,
        type: "crypto" as const,
        name: a.name,
        ticker: a.ticker.toUpperCase(),
        value: valueBase,
        change24h: price?.usd_24h_change,
        icon: a.image_url,
        detailPath: `${pathPrefix}/crypto`,
        quantity: totalQty,
        pricePerUnit: priceBase,
        currency: "USD",
      };
    }),
    ...stockAssets.map((a) => {
      const tick = a.yahoo_ticker || a.ticker;
      const price = stockPrices[tick];
      const totalQty = a.positions.reduce((s, p) => s + p.quantity, 0);
      const priceNative = price?.price ?? 0;
      const valueBase = convertToBase(priceNative * totalQty, a.currency, primaryCurrency, fxRates);
      const priceBase = convertToBase(priceNative, a.currency, primaryCurrency, fxRates);
      return {
        id: a.id,
        type: "stock" as const,
        name: a.name,
        ticker: a.ticker,
        value: valueBase,
        change24h: price?.change24h,
        detailPath: `${pathPrefix}/stocks`,
        quantity: totalQty,
        pricePerUnit: priceBase,
        currency: a.currency,
      };
    }),
    ...bankAccounts.map((a) => ({
      id: a.id,
      type: "bank" as const,
      name: `${a.name} (${a.currency})`,
      value: convertToBase(a.balance, a.currency, primaryCurrency, fxRates),
      detailPath: `${pathPrefix}/cash`,
    })),
    ...exchangeDeposits.map((d) => ({
      id: d.id,
      type: "exchange_deposit" as const,
      name: `${d.wallet_name} ${d.currency}`,
      value: convertToBase(d.amount, d.currency, primaryCurrency, fxRates),
      detailPath: `${pathPrefix}/cash`,
    })),
    ...brokerDeposits.map((d) => ({
      id: d.id,
      type: "broker_deposit" as const,
      name: `${d.broker_name} ${d.currency}`,
      value: convertToBase(d.amount, d.currency, primaryCurrency, fxRates),
      detailPath: `${pathPrefix}/cash`,
    })),
  ];
}
