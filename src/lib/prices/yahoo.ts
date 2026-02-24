import type { YahooStockPriceData, YahooSearchResult } from "@/lib/types";

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";

// ─── Search ────────────────────────────────────────────────

/**
 * Search Yahoo Finance for stocks/ETFs matching a query.
 * Returns up to 8 results with symbol, name, exchange, and type info.
 */
export async function searchStocks(
  query: string
): Promise<YahooSearchResult[]> {
  try {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 300 },
    });

    if (!res.ok) return [];

    const json = await res.json();
    const quotes = json?.quotes;
    if (!Array.isArray(quotes)) return [];

    return quotes
      .filter(
        (q: Record<string, unknown>) =>
          q.isYahooFinance &&
          (q.quoteType === "EQUITY" || q.quoteType === "ETF")
      )
      .map(
        (q: Record<string, unknown>): YahooSearchResult => ({
          symbol: (q.symbol as string) ?? "",
          shortname: (q.shortname as string) ?? "",
          longname: (q.longname as string) ?? (q.shortname as string) ?? "",
          quoteType: (q.quoteType as string) ?? "",
          exchDisp: (q.exchDisp as string) ?? "",
          exchange: (q.exchange as string) ?? "",
        })
      );
  } catch (err) {
    console.error("[yahoo] Search error:", err);
    return [];
  }
}

// ─── Quote detail (for enriching search results) ───────────

/**
 * Fetch quote metadata for a single ticker from the chart API.
 * Returns the actual trading currency and full name.
 * Used to enrich search results with accurate currency info.
 */
export async function getStockQuote(
  ticker: string
): Promise<{ currency: string; name: string; price: number } | null> {
  try {
    const url = `${CHART_URL}/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 300 },
    });

    if (!res.ok) return null;

    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) return null;

    return {
      currency: meta.currency ?? "USD",
      name: meta.longName ?? meta.shortName ?? ticker,
      price: meta.regularMarketPrice ?? 0,
    };
  } catch {
    return null;
  }
}

// ─── Prices ────────────────────────────────────────────────

/**
 * Fetch current prices for multiple stock tickers from Yahoo Finance.
 * Makes one request per ticker (Yahoo doesn't support batch in the chart API).
 * Uses Next.js fetch cache with 60s revalidation.
 */
export async function getStockPrices(
  yahooTickers: string[]
): Promise<YahooStockPriceData> {
  if (yahooTickers.length === 0) return {};

  const results = await Promise.allSettled(
    yahooTickers.map((ticker) => fetchSinglePrice(ticker))
  );

  const data: YahooStockPriceData = {};
  results.forEach((result, i) => {
    if (result.status === "fulfilled" && result.value) {
      data[yahooTickers[i]] = result.value;
    }
  });

  return data;
}

export async function fetchSinglePrice(ticker: string): Promise<{
  price: number;
  previousClose: number;
  change24h: number;
  currency: string;
  name: string;
} | null> {
  try {
    const url = `${CHART_URL}/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      console.error(`[yahoo] Price fetch failed for ${ticker}:`, res.status);
      return null;
    }

    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;

    if (!meta) return null;

    const price = meta.regularMarketPrice ?? 0;
    const previousClose = meta.chartPreviousClose ?? meta.previousClose ?? 0;
    const change24h =
      previousClose > 0
        ? ((price - previousClose) / previousClose) * 100
        : 0;

    return {
      price,
      previousClose,
      change24h,
      currency: meta.currency ?? "USD",
      name: meta.longName ?? meta.shortName ?? ticker,
    };
  } catch (err) {
    console.error(`[yahoo] Error fetching ${ticker}:`, err);
    return null;
  }
}
