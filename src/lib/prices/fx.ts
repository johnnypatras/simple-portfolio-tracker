/**
 * FX conversion service using Frankfurter API (ECB data).
 * Free, no API key, batch support, 15-min cache.
 */

export type FXRates = Record<string, number>;

const API_BASE = "https://api.frankfurter.dev/v1";

/**
 * Fetch exchange rates from Frankfurter (European Central Bank data).
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

  try {
    const endpoint = date ? `${API_BASE}/${date}` : `${API_BASE}/latest`;
    const url = `${endpoint}?base=${base}&symbols=${symbols.join(",")}`;
    // Historical rates are immutable — cache forever; latest rates refresh every 15 min
    const cacheOpts = date ? { cache: "force-cache" as const } : { next: { revalidate: 900 } };
    const res = await fetch(url, cacheOpts);

    if (!res.ok) {
      console.error("[fx] Frankfurter API error:", res.status);
      return { [base]: 1 };
    }

    const data: { rates: Record<string, number> } = await res.json();
    return { ...data.rates, [base]: 1 };
  } catch (err) {
    console.error("[fx] Failed to fetch FX rates:", err);
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
