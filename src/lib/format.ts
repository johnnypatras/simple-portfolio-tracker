/**
 * Shared formatting helpers used across server and client components.
 */

/** Compact currency: 1.23M / 12.3K / 1,234 (decimals defaults to 0) */
export function fmtCurrencyCompact(value: number, currency: string, decimals = 0): string {
  if (Math.abs(value) >= 1_000_000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(value);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** Full currency with 2 decimals */
export function fmtCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(value);
}

/** Signed percentage: +2.4% or -1.3% */
export function fmtPct(value: number, decimals = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}%`;
}

/** Tailwind color class for positive/negative/zero change */
export function changeColorClass(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-red-400";
  return "text-zinc-400";
}
