/**
 * FX conversion service using Frankfurter API (ECB data).
 * Free, no API key, batch support, 15-min cache.
 *
 * Two variants:
 * - getFXRates(): THROWS on failure — use for delta computation (data integrity)
 * - getFXRatesSafe(): falls back to { base: 1 } — use for dashboard display
 */

import { fetchWithTimeout } from "./fetch-with-timeout";

export type FXRates = Record<string, number>;

const API_BASE = "https://api.frankfurter.dev/v1";

/**
 * Fetch exchange rates from Frankfurter (European Central Bank data).
 * THROWS on API failure — use for delta computation where silent fallback
 * would permanently corrupt cached values.
 *
 * Returns rates relative to `base`, e.g.:
 *   getFXRates("USD", ["EUR", "GBP"]) → { EUR: 0.92, GBP: 0.79, USD: 1 }
 *
 * The base currency is always included with rate 1.
 * Pass `date` (YYYY-MM-DD) for historical rates; omit for latest.
 */
export async function getFXRates(
  base: string,
  targets: string[],
  date?: string
): Promise<FXRates> {
  // Filter out the base currency and deduplicate
  const symbols = [...new Set(targets.filter((t) => t !== base))];

  // Always include the base at rate 1
  if (symbols.length === 0) return { [base]: 1 };

  const endpoint = date ? `${API_BASE}/${date}` : `${API_BASE}/latest`;
  const url = `${endpoint}?base=${base}&symbols=${symbols.join(",")}`;
  // Historical rates are immutable — cache forever; latest rates refresh every 15 min
  const cacheOpts = date ? { cache: "force-cache" as const } : { next: { revalidate: 900 } };

  // Retry once on failure before throwing
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(url, cacheOpts);

      if (!res.ok) {
        if (attempt === 0) {
          console.warn(`[fx] Frankfurter API error ${res.status}, retrying...`);
          continue;
        }
        throw new Error(`Frankfurter API returned ${res.status} for ${base}→${symbols.join(",")}`);
      }

      const data: { rates: Record<string, number> } = await res.json();

      // Validate response has all requested rates
      for (const sym of symbols) {
        if (data.rates[sym] == null) {
          throw new Error(`Frankfurter returned no rate for ${base}→${sym}`);
        }
      }

      return { ...data.rates, [base]: 1 };
    } catch (err) {
      if (attempt === 0 && err instanceof TypeError) {
        // Network error — retry once
        console.warn("[fx] Network error, retrying...", err.message);
        continue;
      }
      throw err;
    }
  }

  // Should never reach here, but TypeScript needs it
  throw new Error(`[fx] All retries exhausted for ${base}→${symbols.join(",")}`);
}

/**
 * Safe version of getFXRates that falls back to { base: 1 } on failure.
 * Use for dashboard display where showing approximate values is better than crashing.
 * NEVER use for delta computation — use getFXRates() instead.
 */
export async function getFXRatesSafe(
  base: string,
  targets: string[],
  date?: string
): Promise<FXRates> {
  try {
    return await getFXRates(base, targets, date);
  } catch (err) {
    console.error("[fx] getFXRatesSafe fallback:", err instanceof Error ? err.message : err);
    return { [base]: 1 };
  }
}

/**
 * Convert an amount from one currency to the base currency.
 *
 * `rates` must be keyed relative to the base (as returned by getFXRates).
 * rates[X] = how many X per 1 base unit.
 * So to convert FROM X TO base: amount / rates[X]
 * To convert FROM base TO X: amount * rates[X]
 */
export function convertToBase(
  amount: number,
  fromCurrency: string,
  baseCurrency: string,
  rates: FXRates
): number {
  if (fromCurrency === baseCurrency) return amount;

  const rate = rates[fromCurrency];
  if (!rate || rate === 0) {
    console.warn(`[fx] No rate for ${fromCurrency}, returning unconverted`);
    return amount;
  }

  // rates[X] = X per 1 base. So base = amount / rates[X]
  return amount / rate;
}

/**
 * Estimate 24h FX impact on an asset priced in `assetCurrency`
 * when the user's primary currency is `primaryCurrency`.
 *
 * Only EUR↔USD is supported (we get EUR/USD 24h change from Yahoo).
 * Other pairs return 0 (no 24h FX data available).
 */
export function fxChangeForCurrency(
  assetCurrency: string,
  primaryCurrency: string,
  eurUsdChange24h: number,
): number {
  if (assetCurrency === primaryCurrency) return 0;
  if (primaryCurrency === "EUR" && assetCurrency === "USD") return -eurUsdChange24h;
  if (primaryCurrency === "USD" && assetCurrency === "EUR") return eurUsdChange24h;
  return 0;
}
