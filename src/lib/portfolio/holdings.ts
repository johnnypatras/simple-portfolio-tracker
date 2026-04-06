import type {
  BaseCurrency,
  CryptoAssetWithPositions,
  StockAssetWithPositions,
  CashAccount,
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
  cashAccounts: CashAccount[];
  fxRates: Record<string, number>;
  primaryCurrency: BaseCurrency;
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
  cashAccounts,
  fxRates,
  primaryCurrency,
  pathPrefix,
}: BuildPaletteHoldingsInput): HoldingItem[] {
  // Detect coingecko_ids with multiple chains — append chain to name for disambiguation
  const chainCounts = new Map<string, number>();
  for (const a of cryptoAssets) {
    chainCounts.set(a.coingecko_id, (chainCounts.get(a.coingecko_id) ?? 0) + 1);
  }

  return [
    ...cryptoAssets.map((a) => {
      const price = cryptoPrices[a.coingecko_id];
      const totalQty = a.positions.reduce((s, p) => s + p.quantity, 0);
      const priceUsd = price?.usd ?? 0;
      const valueBase = convertToBase(priceUsd * totalQty, "USD", primaryCurrency, fxRates);
      const priceBase = convertToBase(priceUsd, "USD", primaryCurrency, fxRates);
      const needsChainLabel = (chainCounts.get(a.coingecko_id) ?? 0) > 1;
      return {
        id: a.id,
        type: "crypto" as const,
        name: needsChainLabel && a.chain ? `${a.name} (${a.chain})` : a.name,
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
    ...cashAccounts.map((ca) => ({
      id: ca.id,
      type: "cash" as const,
      name: ca.name ?? `${ca.currency} Cash`,
      ticker: ca.currency,
      value: convertToBase(ca.balance, ca.currency, primaryCurrency, fxRates),
      detailPath: `${pathPrefix}/cash`,
      quantity: undefined,
      pricePerUnit: undefined,
      currency: ca.currency,
    })),
  ];
}
