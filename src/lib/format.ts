/**
 * Shared formatting helpers used across server and client components.
 */

// Module-level cache for Intl.NumberFormat instances to avoid repeated construction
const _nfCache = new Map<string, Intl.NumberFormat>();

function _getCurrencyFormatter(currency: string, decimals: number): Intl.NumberFormat {
  const key = `c:${currency}:${decimals}`;
  let fmt = _nfCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    _nfCache.set(key, fmt);
  }
  return fmt;
}

function _getNumberFormatter(decimals: number, minDecimals?: number): Intl.NumberFormat {
  const min = minDecimals ?? decimals;
  const key = `n:${min}:${decimals}`;
  let fmt = _nfCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: min,
      maximumFractionDigits: decimals,
    });
    _nfCache.set(key, fmt);
  }
  return fmt;
}

/** Round to 2 decimal places (for financial display — NOT for DB precision). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Currency with configurable decimals (default 2 for backward compat) */
export function fmtCurrency(value: number, currency: string, decimals = 2): string {
  return _getCurrencyFormatter(currency, decimals).format(value);
}

/** Alias used by column renderers — 2-decimal currency */
export { fmtCurrency as formatCurrency };

/** Compact currency: 1.2M / 12.3K / 1,234 (decimals defaults to 0 for sub-million) */
export function fmtCurrencyCompact(value: number, currency: string, decimals = 0): string {
  if (Math.abs(value) >= 1_000_000) {
    const key = `cc:${currency}`;
    let fmt = _nfCache.get(key);
    if (!fmt) {
      fmt = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        notation: "compact",
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
      _nfCache.set(key, fmt);
    }
    return fmt.format(value);
  }
  return fmtCurrency(value, currency, decimals);
}

/** Signed percentage: +2.4% or -1.3% */
export function fmtPct(value: number, decimals = 1): string {
  if (!isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}%`;
}

/** Plain percentage without sign: 2.4% */
export function fmtPctPlain(value: number, decimals = 0): string {
  if (!isFinite(value)) return "—";
  return `${value.toFixed(decimals)}%`;
}

/** Tailwind color class for positive/negative/zero change */
export function changeColorClass(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-red-400";
  return "text-zinc-400";
}

/** Plain number with fixed decimal places */
export function formatNumber(n: number, decimals = 2): string {
  return _getNumberFormatter(decimals).format(n);
}

/** Format quantities (shares/holdings) — strips trailing zeros up to maxDecimals */
export function formatQuantity(n: number, maxDecimals: number): string {
  return _getNumberFormatter(maxDecimals, 2).format(n);
}

/** Color palette for group-by-source rows */
export const GROUP_PALETTE = [
  "text-blue-400",
  "text-purple-400",
  "text-amber-400",
  "text-emerald-400",
  "text-sky-400",
  "text-rose-400",
  "text-teal-400",
  "text-orange-400",
];
