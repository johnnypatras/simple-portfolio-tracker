import { getPrices } from "@/lib/prices/coingecko";
import { getStockAndIndexPrices } from "@/lib/prices/yahoo";
import { getFXRatesSafe } from "@/lib/prices/fx";
import type { FXRates } from "@/lib/prices/fx";
import { getLatestManualNavsAt, partitionStockAssetsForPricing, injectManualNavPrices } from "@/lib/manual-nav";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { aggregatePortfolio } from "./aggregate";
import type { PortfolioSummary } from "./aggregate";
import { computeDashboardInsights } from "./dashboard-insights";
import type { DashboardInsights } from "./dashboard-insights";
import { buildPaletteHoldings } from "./holdings";
import type {
  CryptoAssetWithPositions,
  CoinGeckoPriceData,
  StockAssetWithPositions,
  YahooStockPriceData,
  YahooDividendMap,
  CashAccount,
  HoldingItem,
  BaseCurrency,
} from "@/lib/types";

interface PortfolioAssets {
  cryptoAssets: CryptoAssetWithPositions[];
  stockAssets: StockAssetWithPositions[];
  cashAccounts: CashAccount[];
  primaryCurrency: BaseCurrency;
}

export interface AssembledPortfolio {
  summary: PortfolioSummary;
  insights: DashboardInsights;
  cryptoPrices: CoinGeckoPriceData;
  stockPrices: YahooStockPriceData;
  dividends: YahooDividendMap;
  fxRates: FXRates;
  fxRatesUsd: FXRates;
  fxRatesEur: FXRates;
  paletteHoldings: HoldingItem[];
  fxStale: boolean;
  fxUnavailable: boolean;
}

export async function assemblePortfolioView(
  assets: PortfolioAssets,
  pathPrefix: string,
  options?: {
    /**
     * When set, the manual-NAV lookup uses the service-role admin client with
     * this user_id explicitly. Used by /share/[token]/* pages where the
     * viewer is not the owner and RLS would scope the lookup to zero rows.
     * When undefined, falls back to the authenticated server client + RLS.
     */
    ownerUserId?: string;
  },
): Promise<AssembledPortfolio> {
  const { cryptoAssets, stockAssets, cashAccounts, primaryCurrency } = assets;

  const coinIds = [
    ...new Set(["bitcoin", "ethereum", "solana", ...cryptoAssets.map((a) => a.coingecko_id)]),
  ];
  // Yahoo batch covers kind='yahoo' only. kind='manual' assets are priced via
  // manual_nav_updates and injected into stockPrices below. See
  // partitionStockAssetsForPricing + injectManualNavPrices in @/lib/manual-nav.
  const { manualStockAssets, yahooTickers } = partitionStockAssetsForPricing(stockAssets);

  const allCurrencies = [
    ...new Set([
      "EUR", "USD",
      ...stockAssets.map((a) => a.currency),
      ...cashAccounts.map((a) => a.currency),
    ]),
  ];

  const supabase = await createServerSupabaseClient();
  const today = new Date().toISOString().slice(0, 10);

  // For share-page reads (ownerUserId provided), use the admin client + explicit
  // user_id arg so the SQL function still scopes correctly. RLS bypass is safe:
  // shared-portfolio.ts already gates which fields the viewer sees; manual NAV
  // values just complete that picture.
  const navClient = options?.ownerUserId ? createAdminClient() : supabase;

  const [cryptoPrices, { stockPrices, indexPrices, dividends }, fxRates, fxRatesUsd, fxRatesEur, manualNavs] =
    await Promise.all([
      getPrices(coinIds),
      getStockAndIndexPrices(yahooTickers),
      getFXRatesSafe(primaryCurrency, allCurrencies),
      getFXRatesSafe("USD", allCurrencies.filter((c) => c !== "USD")),
      getFXRatesSafe("EUR", allCurrencies.filter((c) => c !== "EUR")),
      manualStockAssets.length > 0
        ? getLatestManualNavsAt(navClient, today, options?.ownerUserId)
        : Promise.resolve([]),
    ]);

  // Inject manual NAVs into stockPrices keyed by `asset.ticker` (yahoo_ticker is
  // null for manual assets). Downstream readers use `stockPrices[yahoo_ticker || ticker]`
  // — manual assets resolve via the ticker fallback. Single injection point.
  injectManualNavPrices(manualStockAssets, manualNavs, stockPrices);

  const eurUsdData = indexPrices["EURUSD=X"] ?? null;

  const summary = aggregatePortfolio({
    cryptoAssets,
    cryptoPrices,
    stockAssets,
    stockPrices,
    cashAccounts,
    primaryCurrency,
    fxRates,
    fxRatesUsd,
    fxRatesEur,
    eurUsdChange24h: eurUsdData?.change24h ?? 0,
  });

  const insights = computeDashboardInsights({
    cryptoAssets, cryptoPrices, stockAssets, stockPrices,
    cashAccounts,
    primaryCurrency, fxRates, summary,
    sp500Price: indexPrices["^GSPC"]?.price ?? 0,
    sp500Change24h: indexPrices["^GSPC"]?.change24h ?? 0,
    goldPrice: indexPrices["GC=F"]?.price ?? 0,
    goldChange24h: indexPrices["GC=F"]?.change24h ?? 0,
    nasdaqPrice: indexPrices["^IXIC"]?.price ?? 0,
    nasdaqChange24h: indexPrices["^IXIC"]?.change24h ?? 0,
    dowPrice: indexPrices["^DJI"]?.price ?? 0,
    dowChange24h: indexPrices["^DJI"]?.change24h ?? 0,
    eurUsdChange24h: eurUsdData?.change24h ?? 0,
    solPriceUsd: cryptoPrices["solana"]?.usd ?? 0,
    solChange24h: cryptoPrices["solana"]?.usd_24h_change ?? 0,
    stoxx50Price: indexPrices["^STOXX50E"]?.price ?? 0,
    stoxx50Change24h: indexPrices["^STOXX50E"]?.change24h ?? 0,
    silverPrice: indexPrices["SI=F"]?.price ?? 0,
    silverChange24h: indexPrices["SI=F"]?.change24h ?? 0,
    oilPrice: indexPrices["BZ=F"]?.price ?? 0,
    oilChange24h: indexPrices["BZ=F"]?.change24h ?? 0,
    treasury10yPrice: indexPrices["^TNX"]?.price ?? 0,
    treasury10yChange24h: indexPrices["^TNX"]?.change24h ?? 0,
    vixPrice: indexPrices["^VIX"]?.price ?? 0,
    vixChange24h: indexPrices["^VIX"]?.change24h ?? 0,
    dividends,
  });

  const paletteHoldings = buildPaletteHoldings({
    cryptoAssets, cryptoPrices, stockAssets, stockPrices,
    cashAccounts, fxRates, primaryCurrency, pathPrefix,
  });

  // FX markets close Friday ~22:00 UTC, reopen Sunday ~22:00 UTC.
  // Weekend: 48h threshold (normal freeze). Weekday: 24h (catches Yahoo silently serving stale data).
  const dayOfWeek = new Date().getUTCDay(); // 0=Sun, 6=Sat
  const fxStaleThreshold = (dayOfWeek === 0 || dayOfWeek === 6) ? 48 * 3600 : 24 * 3600;
  const fxStale = eurUsdData?.regularMarketTime != null
    ? Date.now() / 1000 - eurUsdData.regularMarketTime > fxStaleThreshold
    : false;
  const fxUnavailable = !eurUsdData?.price;

  return { summary, insights, cryptoPrices, stockPrices, dividends, fxRates, fxRatesUsd, fxRatesEur, paletteHoldings, fxStale, fxUnavailable };
}
