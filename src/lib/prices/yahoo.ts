import type { YahooStockPriceData, YahooSearchResult, YahooDividendData, YahooDividendMap } from "@/lib/types";

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote";
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

// ─── Crumb auth (required for v7 batch endpoint) ──────────

let cachedCrumb: { crumb: string; cookie: string; expiry: number } | null = null;

/**
 * Acquire a Yahoo Finance crumb + session cookie.
 * Yahoo v7 requires cookie-based auth with a CSRF-like crumb token.
 * Flow: GET fc.yahoo.com → extract cookies → GET getcrumb → cache both.
 */
async function getYahooCrumb(): Promise<{ crumb: string; cookie: string } | null> {
  // Return cached if still valid (30 min TTL)
  if (cachedCrumb && Date.now() < cachedCrumb.expiry) {
    return { crumb: cachedCrumb.crumb, cookie: cachedCrumb.cookie };
  }

  try {
    // Step 1: Get session cookies from Yahoo
    const cookieRes = await fetch("https://fc.yahoo.com/", {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "manual",
    });
    const setCookies = cookieRes.headers.getSetCookie?.() ?? [];
    const cookie = setCookies
      .map((c) => c.split(";")[0])
      .filter(Boolean)
      .join("; ");

    if (!cookie) {
      console.error("[yahoo] No cookies received from fc.yahoo.com");
      return null;
    }

    // Step 2: Exchange cookies for a crumb token
    const crumbRes = await fetch(
      "https://query2.finance.yahoo.com/v1/test/getcrumb",
      { headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie } }
    );
    if (!crumbRes.ok) {
      console.error("[yahoo] Crumb fetch failed:", crumbRes.status);
      return null;
    }
    const crumb = await crumbRes.text();
    if (!crumb || crumb.includes("Unauthorized")) return null;

    cachedCrumb = { crumb, cookie, expiry: Date.now() + 30 * 60 * 1000 };
    return { crumb, cookie };
  } catch (err) {
    console.error("[yahoo] Crumb auth error:", err);
    return null;
  }
}

// ─── Batch Quotes (v7) ─────────────────────────────────────

type QuoteResult = {
  price: number;
  previousClose: number;
  change24h: number;
  currency: string;
  name: string;
};

/**
 * Fetch quotes for multiple symbols in a single HTTP request via v7/finance/quote.
 * Requires crumb+cookie auth. Falls back gracefully if auth fails.
 */
async function fetchQuotesBatch(
  symbols: string[]
): Promise<Map<string, QuoteResult>> {
  const map = new Map<string, QuoteResult>();
  if (symbols.length === 0) return map;

  try {
    const auth = await getYahooCrumb();
    if (!auth) return map; // caller will fall back to v8/chart

    const url = `${QUOTE_URL}?symbols=${symbols.join(",")}&crumb=${encodeURIComponent(auth.crumb)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Cookie: auth.cookie },
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      // Invalidate crumb on auth failure so next call retries
      if (res.status === 401 || res.status === 403) cachedCrumb = null;
      console.error("[yahoo] Batch quote fetch failed:", res.status);
      return map;
    }

    const json = await res.json();
    const quotes = json?.quoteResponse?.result;
    if (!Array.isArray(quotes)) return map;

    for (const q of quotes) {
      const symbol = q.symbol as string;
      if (!symbol) continue;

      const price = (q.regularMarketPrice as number) ?? 0;
      const previousClose = (q.regularMarketPreviousClose as number) ?? 0;
      const change24h = (q.regularMarketChangePercent as number) ?? 0;

      map.set(symbol, {
        price,
        previousClose,
        change24h,
        currency: (q.currency as string) ?? "USD",
        name: (q.longName as string) ?? (q.shortName as string) ?? symbol,
      });
    }
  } catch (err) {
    console.error("[yahoo] Batch quote error:", err);
  }

  return map;
}

// ─── Prices ────────────────────────────────────────────────

/**
 * Fetch current prices for multiple stock tickers via a single v7 batch request.
 * Falls back to individual v8/chart requests if the batch fails for any ticker.
 */
export async function getStockPrices(
  yahooTickers: string[]
): Promise<YahooStockPriceData> {
  if (yahooTickers.length === 0) return {};

  const batchResult = await fetchQuotesBatch(yahooTickers);

  const data: YahooStockPriceData = {};
  for (const ticker of yahooTickers) {
    const quote = batchResult.get(ticker);
    if (quote) {
      data[ticker] = quote;
    }
  }

  // Fall back to individual fetch for any missing tickers
  const missing = yahooTickers.filter((t) => !data[t]);
  if (missing.length > 0) {
    const fallbackResults = await Promise.allSettled(
      missing.map((ticker) => fetchSinglePrice(ticker))
    );
    fallbackResults.forEach((result, i) => {
      if (result.status === "fulfilled" && result.value) {
        data[missing[i]] = result.value;
      }
    });
  }

  return data;
}

// ─── Index & Combined Batch ─────────────────────────────────

const INDEX_SYMBOLS = ["^GSPC", "GC=F", "^IXIC", "^DJI", "EURUSD=X"] as const;

export type IndexPrices = {
  [symbol: string]: QuoteResult;
};

/**
 * Fetch all market index/indicator quotes in a single batch.
 * Returns: ^GSPC (S&P 500), GC=F (Gold), ^IXIC (Nasdaq), ^DJI (Dow), EURUSD=X.
 */
export async function getIndexPrices(): Promise<IndexPrices> {
  const batch = await fetchQuotesBatch([...INDEX_SYMBOLS]);
  const data: IndexPrices = {};
  for (const sym of INDEX_SYMBOLS) {
    const quote = batch.get(sym);
    if (quote) data[sym] = quote;
  }
  return data;
}

/**
 * Fetch stock prices + index prices in a single combined batch.
 * Deduplicates overlapping symbols (e.g. if EURUSD=X is also in user tickers).
 * Returns split result: { stockPrices, indexPrices }.
 */
export async function getStockAndIndexPrices(
  yahooTickers: string[]
): Promise<{ stockPrices: YahooStockPriceData; indexPrices: IndexPrices }> {
  // Merge all symbols, deduplicating
  const allSymbols = [...new Set([...yahooTickers, ...INDEX_SYMBOLS])];

  const batch = await fetchQuotesBatch(allSymbols);

  // Split results
  const stockPrices: YahooStockPriceData = {};
  for (const ticker of yahooTickers) {
    const quote = batch.get(ticker);
    if (quote) stockPrices[ticker] = quote;
  }

  // Fall back to individual fetch for any missing stock tickers
  const missing = yahooTickers.filter((t) => !stockPrices[t]);
  if (missing.length > 0) {
    const fallbackResults = await Promise.allSettled(
      missing.map((ticker) => fetchSinglePrice(ticker))
    );
    fallbackResults.forEach((result, i) => {
      if (result.status === "fulfilled" && result.value) {
        stockPrices[missing[i]] = result.value;
      }
    });
  }

  const indexPrices: IndexPrices = {};
  for (const sym of INDEX_SYMBOLS) {
    const quote = batch.get(sym);
    if (quote) indexPrices[sym] = quote;
  }

  return { stockPrices, indexPrices };
}

// ─── Single-ticker (v8/chart) ──────────────────────────────

async function fetchSinglePrice(ticker: string): Promise<{
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

// ─── Index History (for benchmark lines) ─────────────────

/**
 * Fetch daily closing prices for an index over N days.
 * Used to plot benchmark lines (e.g. ^SP500TR) on the portfolio chart.
 * Cached for 1 hour since historical data rarely changes.
 */
export async function fetchIndexHistory(
  ticker: string,
  days: number
): Promise<{ date: string; close: number }[]> {
  const range =
    days <= 7 ? "7d" : days <= 30 ? "1mo" : days <= 90 ? "3mo" : days <= 365 ? "1y" : "max";

  try {
    const url = `${CHART_URL}/${encodeURIComponent(ticker)}?interval=1d&range=${range}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 3600 }, // 1 hour
    });

    if (!res.ok) {
      console.error(`[yahoo] Index history fetch failed for ${ticker}:`, res.status);
      return [];
    }

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return [];

    const timestamps: number[] = result.timestamp ?? [];
    const closes: (number | null)[] =
      result.indicators?.quote?.[0]?.close ?? [];

    const points: { date: string; close: number }[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close == null) continue;
      const date = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
      points.push({ date, close });
    }

    return points;
  } catch (err) {
    console.error(`[yahoo] Index history error for ${ticker}:`, err);
    return [];
  }
}

// ─── Dividend Yields ──────────────────────────────────────

/**
 * Fetch trailing 12-month dividend yield for a single ticker.
 * Uses interval=3mo to minimize payload (~4 OHLCV points instead of ~365)
 * while still getting the full dividends event data.
 * Cached for 6 hours since dividends only change quarterly.
 */
async function fetchSingleDividendYield(
  ticker: string
): Promise<YahooDividendData | null> {
  try {
    const url = `${CHART_URL}/${encodeURIComponent(ticker)}?interval=3mo&range=1y&events=div`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 21600 }, // 6 hours
    });

    if (!res.ok) return null;

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const currentPrice = meta?.regularMarketPrice ?? 0;
    const currency = meta?.currency ?? "USD";

    const dividends = result.events?.dividends;
    if (!dividends || typeof dividends !== "object") {
      return { trailingYield: 0, annualDividend: 0, dividendCount: 0, currency };
    }

    const divEntries = Object.values(dividends) as { amount: number }[];
    const annualDividend = divEntries.reduce((sum, d) => sum + (d.amount ?? 0), 0);
    const dividendCount = divEntries.length;
    const trailingYield =
      currentPrice > 0 ? (annualDividend / currentPrice) * 100 : 0;

    return { trailingYield, annualDividend, dividendCount, currency };
  } catch (err) {
    console.error(`[yahoo] Dividend fetch error for ${ticker}:`, err);
    return null;
  }
}

/**
 * Fetch dividend yields for multiple tickers in parallel.
 * Mirrors the getStockPrices() pattern with fault-tolerant Promise.allSettled.
 */
export async function getDividendYields(
  yahooTickers: string[]
): Promise<YahooDividendMap> {
  if (yahooTickers.length === 0) return {};

  const results = await Promise.allSettled(
    yahooTickers.map((ticker) => fetchSingleDividendYield(ticker))
  );

  const data: YahooDividendMap = {};
  results.forEach((result, i) => {
    if (result.status === "fulfilled" && result.value) {
      data[yahooTickers[i]] = result.value;
    }
  });

  return data;
}
