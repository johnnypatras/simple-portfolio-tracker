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

interface BuildPaletteHoldingsInput {
  cryptoAssets: CryptoAssetWithPositions[];
  cryptoPrices: CoinGeckoPriceData;
  stockAssets: StockAssetWithPositions[];
  stockPrices: YahooStockPriceData;
  bankAccounts: BankAccount[];
  exchangeDeposits: ExchangeDeposit[];
  brokerDeposits: BrokerDeposit[];
  fxRates: Record<string, number>;
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
  pathPrefix,
}: BuildPaletteHoldingsInput): HoldingItem[] {
  return [
    ...cryptoAssets.map((a) => {
      const price = cryptoPrices[a.coingecko_id];
      const totalQty = a.positions.reduce((s, p) => s + p.quantity, 0);
      const priceUsd = price?.usd ?? 0;
      const fxMul = fxRates["USD"] ?? 1;
      return {
        id: a.id,
        type: "crypto" as const,
        name: a.name,
        ticker: a.ticker.toUpperCase(),
        value: priceUsd * totalQty * fxMul,
        change24h: price?.usd_24h_change,
        icon: a.image_url,
        detailPath: `${pathPrefix}/crypto`,
        quantity: totalQty,
        pricePerUnit: priceUsd * fxMul,
        currency: "USD",
      };
    }),
    ...stockAssets.map((a) => {
      const tick = a.yahoo_ticker || a.ticker;
      const price = stockPrices[tick];
      const totalQty = a.positions.reduce((s, p) => s + p.quantity, 0);
      const nativeCurrency = price?.currency ?? a.currency;
      const priceNative = price?.price ?? 0;
      const fxMul = fxRates[nativeCurrency] ?? 1;
      return {
        id: a.id,
        type: "stock" as const,
        name: a.name,
        ticker: a.ticker,
        value: priceNative * totalQty * fxMul,
        change24h: price?.change24h,
        detailPath: `${pathPrefix}/stocks`,
        quantity: totalQty,
        pricePerUnit: priceNative * fxMul,
        currency: nativeCurrency,
      };
    }),
    ...bankAccounts.map((a) => ({
      id: a.id,
      type: "bank" as const,
      name: `${a.name} (${a.currency})`,
      value: a.balance * (fxRates[a.currency] ?? 1),
      detailPath: `${pathPrefix}/cash`,
    })),
    ...exchangeDeposits.map((d) => ({
      id: d.id,
      type: "exchange_deposit" as const,
      name: `${d.wallet_name} ${d.currency}`,
      value: d.amount * (fxRates[d.currency] ?? 1),
      detailPath: `${pathPrefix}/cash`,
    })),
    ...brokerDeposits.map((d) => ({
      id: d.id,
      type: "broker_deposit" as const,
      name: `${d.broker_name} ${d.currency}`,
      value: d.amount * (fxRates[d.currency] ?? 1),
      detailPath: `${pathPrefix}/cash`,
    })),
  ];
}
