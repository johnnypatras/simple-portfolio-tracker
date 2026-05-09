import type { YahooStockPriceData, YahooSearchResult, YahooDividendMap } from "@/lib/types";
import { fetchWithTimeout } from "./fetch-with-timeout";

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
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 300 },
    });

    if (!res.ok) {
      console.warn(`[yahoo] Search failed (${res.status}) for query "${query}"`);
      return [];
    }

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
    console.warn(`[yahoo] Search error for query "${query}":`, err);
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
    const res = await fetchWithTimeout(url, {
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
  } catch (err) {
    console.warn(`[yahoo] getStockQuote failed for ticker "${ticker}":`, err);
    return null;
  }
}

// ─── Crumb auth (required for v7 batch endpoint) ──────────

/**
 * Yahoo crumbs expire ~1 hour after issue. Refresh at 30min to avoid edge
 * cases where a long-running cron invocation starts with a near-expired
 * crumb and races the expiry.
 */
const YAHOO_CRUMB_TTL_MS = 30 * 60 * 1000;

let cachedCrumb: { crumb: string; cookie: string; expiry: number } | null = null;

/** @internal — test-only: reset cached crumb so each test starts with clean auth state */
export function _resetCrumbForTesting(): void { cachedCrumb = null; }

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
    const cookieRes = await fetchWithTimeout("https://fc.yahoo.com/", {
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
    const crumbRes = await fetchWithTimeout(
      "https://query2.finance.yahoo.com/v1/test/getcrumb",
      { headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie } }
    );
    if (!crumbRes.ok) {
      console.error("[yahoo] Crumb fetch failed:", crumbRes.status);
      return null;
    }
    const crumb = await crumbRes.text();
    if (!crumb || crumb.includes("Unauthorized")) return null;

    cachedCrumb = { crumb, cookie, expiry: Date.now() + YAHOO_CRUMB_TTL_MS };
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
  trailingYield: number;
  annualDividend: number;
  regularMarketTime?: number;
};

/**
 * Fetch quotes for multiple symbols in a single HTTP request via v7/finance/quote.
 * Requires crumb+cookie auth. Falls back gracefully if auth fails.
 */
export async function fetchQuotesBatch(
  symbols: string[]
): Promise<Map<string, QuoteResult>> {
  const map = new Map<string, QuoteResult>();
  if (symbols.length === 0) return map;

  try {
    const auth = await getYahooCrumb();
    if (!auth) {
      console.warn(`[yahoo] Crumb auth failed — ${symbols.length} stock prices unavailable`);
      return map; // caller will fall back to v8/chart
    }

    const url = `${QUOTE_URL}?symbols=${symbols.join(",")}&crumb=${encodeURIComponent(auth.crumb)}`;
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0", Cookie: auth.cookie },
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      // Invalidate crumb on auth failure so next call retries
      if (res.status === 401 || res.status === 403) cachedCrumb = null;
      console.error(`[yahoo] Batch quote fetch failed (${res.status}) — ${symbols.length} stock prices unavailable`);
      return map;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      console.warn(`[yahoo] Batch quote returned non-JSON (captcha?) — ${symbols.length} stock prices unavailable, content-type: ${contentType}`);
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
        trailingYield: ((q.trailingAnnualDividendYield as number) ?? 0) * 100,
        annualDividend: (q.trailingAnnualDividendRate as number) ?? 0,
        regularMarketTime: (q.regularMarketTime as number) ?? undefined,
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

const INDEX_SYMBOLS = [
  "^GSPC", "GC=F", "^IXIC", "^DJI", "EURUSD=X",
  "^STOXX50E", "SI=F", "BZ=F", "^TNX", "^VIX",
] as const;

export type IndexPrices = {
  [symbol: string]: QuoteResult;
};

/**
 * Fetch all market index/indicator quotes in a single batch.
 * Returns: ^GSPC (S&P 500), GC=F (Gold), ^IXIC (Nasdaq), ^DJI (Dow), EURUSD=X,
 * ^STOXX50E (Euro Stoxx 50), SI=F (Silver), BZ=F (Brent Oil), ^TNX (10Y Treasury), ^VIX.
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

function extractDividendsFromBatch(
  batch: Map<string, QuoteResult>,
  tickers: string[]
): YahooDividendMap {
  const dividends: YahooDividendMap = {};
  for (const ticker of tickers) {
    const q = batch.get(ticker);
    if (!q) continue;
    dividends[ticker] = {
      trailingYield: q.trailingYield,
      annualDividend: q.annualDividend,
      dividendCount: 0,
      currency: q.currency,
    };
  }
  return dividends;
}

/**
 * Fetch stock prices + index prices in a single combined batch.
 * Deduplicates overlapping symbols (e.g. if EURUSD=X is also in user tickers).
 * Returns split result: { stockPrices, indexPrices, dividends }.
 */
export async function getStockAndIndexPrices(
  yahooTickers: string[]
): Promise<{ stockPrices: YahooStockPriceData; indexPrices: IndexPrices; dividends: YahooDividendMap }> {
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

  const dividends = extractDividendsFromBatch(batch, yahooTickers);

  return { stockPrices, indexPrices, dividends };
}

// ─── Single-ticker (v8/chart) ──────────────────────────────

async function fetchSinglePrice(ticker: string): Promise<QuoteResult | null> {
  try {
    const url = `${CHART_URL}/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      console.warn(`[yahoo] No data for ${ticker} (${res.status}${res.status === 404 ? " — may be delisted" : ""})`);
      return null;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      console.warn(`[yahoo] Non-JSON response for ${ticker} (captcha?), content-type: ${contentType}`);
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
      trailingYield: 0,
      annualDividend: 0,
    };
  } catch (err) {
    console.error(`[yahoo] Error fetching ${ticker}:`, err);
    return null;
  }
}

// ─── Index History (for benchmark lines) ─────────────────

const SECONDS_PER_DAY = 86400;
const SECONDS_PER_HOUR = 3600;
/** Buffer for trading days the user might own beyond `days` (weekends/holidays). */
const FETCH_LOOKBACK_BUFFER_DAYS = 5;

/**
 * Fetch daily closing prices for an index over N days.
 * Used to plot benchmark lines (e.g. ^SP500TR) on the portfolio chart.
 * Cached for 1 hour since historical data rarely changes.
 *
 * Why explicit `period1`/`period2` instead of Yahoo's `range=Xy` predefined
 * buckets:
 *
 *   Yahoo's chart endpoint silently downsamples to coarser granularity when
 *   the predefined range would otherwise return "too many" daily points,
 *   IGNORING the `interval=1d` URL parameter. Verified 2026-05-09 against
 *   ^SP500TR:
 *
 *     range=max:    155 points, meta.dataGranularity "3mo"   ❌
 *     range=10y:   2515 points, meta.dataGranularity "1d"    ✅
 *     range=5y:    1256 points, meta.dataGranularity "1d"    ✅
 *     period1/period2 over 30 years: 7766 points, "1d"       ✅
 *
 *   This caused a phantom +13% jump in the chart's S&P benchmark line at
 *   the Q1→Q2 boundary (forward-fill propagated Q1 close through March,
 *   then stepped to Q2 close on Apr 1). The hybrid alternative — predefined
 *   ranges up to 10y, period1/period2 beyond — would still trust Yahoo to
 *   honor `interval=1d` at every predefined range. The exact failure mode
 *   that motivated this rewrite was Yahoo regressing on that trust at
 *   `range=max`. One assumption is safer than seven, so we always use
 *   explicit timestamps.
 *
 *   `period2` is rounded to the hour so the URL stays stable within the
 *   1-hour fetch cache window (without rounding, a fresh `Date.now()` per
 *   call would bypass the cache).
 */
export async function fetchIndexHistory(
  ticker: string,
  days: number
): Promise<{ date: string; close: number }[]> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const period2 = Math.floor(nowSeconds / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;
  const lookbackDays = Math.max(1, days) + FETCH_LOOKBACK_BUFFER_DAYS;
  const period1 = period2 - lookbackDays * SECONDS_PER_DAY;

  try {
    const url = `${CHART_URL}/${encodeURIComponent(ticker)}?interval=1d&period1=${period1}&period2=${period2}`;
    const res = await fetchWithTimeout(url, {
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

    // Defensive: if Yahoo ever silently downgrades granularity again (the
    // exact failure mode that motivated this rewrite), surface it loudly
    // rather than producing a chart with a phantom step at every coarser
    // bucket boundary.
    const granularity = result.meta?.dataGranularity;
    if (granularity && granularity !== "1d") {
      const msg = `[yahoo] Unexpected dataGranularity "${granularity}" for ${ticker} (expected "1d") — benchmark chart may show false jumps`;
      console.error(msg);
      try {
        const Sentry = await import("@sentry/nextjs");
        Sentry.captureMessage(msg, "warning");
      } catch {
        // Sentry unavailable in tests / non-prod — log already happened
      }
    }

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

// Note: getDividendYields / fetchSingleDividendYield removed — dividend data
// is already extracted from the v7 batch response via extractDividendsFromBatch().
// The separate per-ticker v8/chart approach was dead code and an N+1 landmine.
