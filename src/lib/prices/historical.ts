/**
 * Historical price fetch layer for chart back-extension.
 *
 * Sources (all free, no paid plan):
 *   - Crypto: Yahoo /v8/chart `{SYM}-USD` (BTC-USD, …) — multi-year daily,
 *     USD-denominated. CoinGecko free tier caps market_chart at ~365 days.
 *   - Stocks: Yahoo /v8/chart `{ticker}` — native trading currency.
 *   - FX:     Frankfurter timeseries (ECB), converted to USD-per-1-unit.
 *
 * Every call is fetchWithTimeout-guarded (8s) and returns [] on any failure
 * (graceful degradation — the lot contributes $0 for the missing date range).
 * Returns parsed { date: "YYYY-MM-DD", price } rows; the caller maps
 * these into historical_prices rows + upserts via the admin client.
 *
 * Storage invariant (enforced by the caller): one currency per (asset_kind,
 * asset_key). Crypto is always USD (Yahoo {SYM}-USD); a stock's currency is
 * its native trading currency; fx rows are USD-per-1-unit (currency='USD').
 */
import { fetchWithTimeout } from "./fetch-with-timeout";

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const FRANKFURTER_BASE = "https://api.frankfurter.dev/v1";
// Mirrors yahoo.ts; kept local so the prices fetch layer stays self-contained.
const SECONDS_PER_DAY = 86400;
/** Pad the Yahoo range so forward-fill has a prior trading day at the start edge. */
const RANGE_PAD_DAYS = 5;
/**
 * Pad the FX range BACKWARD so a business-day rate always exists at-or-before
 * the requested startDate. Frankfurter (ECB) has no weekend/holiday rates;
 * without this lead pad a backdated date landing before the first returned
 * rate would leave the EUR mirror at 0 and collapse the EUR chart to a
 * zero-ramp. 10 days clears weekends + long holiday closures (e.g. year-end).
 */
const FX_LEAD_PAD_DAYS = 10;
/**
 * Delay before retrying a single 429 rate-limit response. Mirrors
 * COINGECKO_429_RETRY_MS in coingecko.ts — a brief pause lets the upstream
 * rate-limit window clear without a second miss. Applies to both the Yahoo
 * chart and Frankfurter timeseries fetchers below.
 */
const RATE_LIMIT_RETRY_MS = 500;

function toUnixDayStart(date: string): number {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
}

/** Shift a YYYY-MM-DD date by `deltaDays` (UTC), returning YYYY-MM-DD. */
function isoShift(date: string, deltaDays: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Daily closes for a Yahoo symbol over [startDate, endDate] (inclusive),
 * using explicit period1/period2 — NEVER range=Xy (Yahoo silently downsamples
 * range=max to quarterly, see fetchIndexHistory in yahoo.ts). Works for crypto
 * `{SYM}-USD` and ordinary stock tickers alike.
 */
export async function fetchYahooDailyHistory(
  symbol: string,
  startDate: string,
  endDate: string,
): Promise<{ date: string; price: number }[]> {
  const period1 = toUnixDayStart(startDate) - RANGE_PAD_DAYS * SECONDS_PER_DAY;
  const period2 = toUnixDayStart(endDate) + SECONDS_PER_DAY; // include endDate
  try {
    const url = `${YAHOO_CHART_URL}/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;
    const fetchOptions = {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 3600 },
    };
    let res = await fetchWithTimeout(url, fetchOptions);

    if (res.status === 429) {
      console.warn(`[historical] Yahoo rate limited (429) for ${symbol}, retrying in ${RATE_LIMIT_RETRY_MS}ms…`);
      await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS));
      res = await fetchWithTimeout(url, fetchOptions);
    }

    if (!res.ok) {
      const msg = `[historical] Yahoo history failed for ${symbol}: ${res.status}`;
      console.warn(msg);
      try {
        const Sentry = await import("@sentry/nextjs");
        Sentry.captureMessage(msg, {
          level: "warning",
          tags: { phase: "yahoo_history" },
          extra: { symbol, status: res.status },
        });
      } catch {
        // Sentry unavailable in tests / non-prod — log already happened
      }
      return [];
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const msg = `[historical] Yahoo non-JSON for ${symbol} (captcha?): ${contentType}`;
      console.warn(msg);
      try {
        const Sentry = await import("@sentry/nextjs");
        Sentry.captureMessage(msg, {
          level: "warning",
          tags: { phase: "yahoo_history" },
          extra: { symbol, contentType },
        });
      } catch {
        // Sentry unavailable in tests / non-prod — log already happened
      }
      return [];
    }
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return [];

    // Yahoo can silently downsample to coarser granularity even with explicit
    // period1/period2 (see fetchIndexHistory). This data is cached permanently
    // (append-only), so bad daily data would never self-heal. Refuse to return
    // (and therefore cache) anything that isn't true daily granularity — the
    // lot contributes $0 for the uncached date range instead.
    const granularity = result.meta?.dataGranularity;
    if (granularity && granularity !== "1d") {
      const msg = `[historical] Unexpected dataGranularity "${granularity}" for ${symbol} (expected "1d") — refusing to cache downsampled history`;
      console.error(msg);
      try {
        const Sentry = await import("@sentry/nextjs");
        Sentry.captureMessage(msg, "warning");
      } catch {
        // Sentry unavailable in tests / non-prod — log already happened
      }
      return [];
    }

    const timestamps: number[] = result.timestamp ?? [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
    const out: { date: string; price: number }[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close == null || !Number.isFinite(close) || close <= 0) continue;
      out.push({ date: new Date(timestamps[i] * 1000).toISOString().split("T")[0], price: close });
    }
    return out;
  } catch (err) {
    console.error(`[historical] Yahoo history error for ${symbol}:`, err);
    try {
      const Sentry = await import("@sentry/nextjs");
      Sentry.captureException(err, {
        tags: { phase: "yahoo_history" },
        extra: { symbol },
      });
    } catch {
      // Sentry unavailable in tests / non-prod — log already happened
    }
    return [];
  }
}

/**
 * USD-per-1-unit daily history for a foreign `currency` over [startDate,
 * endDate], from Frankfurter's timeseries (base=USD). Frankfurter returns
 * "currency per 1 USD"; we invert to "USD per 1 unit" so the synthesis layer's
 * usdPerUnit() can multiply directly. The start is padded backward by
 * FX_LEAD_PAD_DAYS so a prior business-day rate always exists at-or-before the
 * requested startDate (see the constant's comment). Returns [] on failure or
 * missing symbol.
 */
export async function fetchFxUsdPivotHistory(
  currency: string,
  startDate: string,
  endDate: string,
): Promise<{ date: string; price: number }[]> {
  if (currency === "USD") return []; // pivot — never stored
  const paddedStart = isoShift(startDate, -FX_LEAD_PAD_DAYS);
  try {
    const url = `${FRANKFURTER_BASE}/${paddedStart}..${endDate}?base=USD&symbols=${currency}`;
    const fetchOptions = { cache: "force-cache" as const };
    let res = await fetchWithTimeout(url, fetchOptions);

    if (res.status === 429) {
      console.warn(`[historical] Frankfurter rate limited (429) for ${currency}, retrying in ${RATE_LIMIT_RETRY_MS}ms…`);
      await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS));
      res = await fetchWithTimeout(url, fetchOptions);
    }

    if (!res.ok) {
      const msg = `[historical] Frankfurter timeseries failed for ${currency}: ${res.status}`;
      console.warn(msg);
      try {
        const Sentry = await import("@sentry/nextjs");
        Sentry.captureMessage(msg, {
          level: "warning",
          tags: { phase: "frankfurter_history" },
          extra: { currency, status: res.status },
        });
      } catch {
        // Sentry unavailable in tests / non-prod — log already happened
      }
      return [];
    }
    const json: { rates?: Record<string, Record<string, number>> } = await res.json();
    const rates = json.rates ?? {};
    const out: { date: string; price: number }[] = [];
    for (const [date, perUsd] of Object.entries(rates)) {
      const v = perUsd[currency];
      if (v == null || !Number.isFinite(v) || v <= 0) continue;
      out.push({ date, price: 1 / v }); // USD per 1 unit
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  } catch (err) {
    console.error(`[historical] Frankfurter timeseries error for ${currency}:`, err);
    try {
      const Sentry = await import("@sentry/nextjs");
      Sentry.captureException(err, {
        tags: { phase: "frankfurter_history" },
        extra: { currency },
      });
    } catch {
      // Sentry unavailable in tests / non-prod — log already happened
    }
    return [];
  }
}
