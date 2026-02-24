/**
 * Shared formatting helpers used across server and client components.
 */

/** Currency with configurable decimals (default 2 for backward compat) */
export function fmtCurrency(value: number, currency: string, decimals = 2): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** Alias used by column renderers — 2-decimal currency */
export { fmtCurrency as formatCurrency };

/** Compact currency: 1.2M / 12.3K / 1,234 (decimals defaults to 0 for sub-million) */
export function fmtCurrencyCompact(value: number, currency: string, decimals = 0): string {
  if (Math.abs(value) >= 1_000_000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: "compact",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
  }
  return fmtCurrency(value, currency, decimals);
}

/** Signed percentage: +2.4% or -1.3% */
export function fmtPct(value: number, decimals = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}%`;
}

/** Plain percentage without sign: 2.4% */
export function fmtPctPlain(value: number, decimals = 0): string {
  return `${value.toFixed(decimals)}%`;
}

/** Tailwind color class for positive/negative/zero change */
export function changeColorClass(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-red-400";
  return "text-zinc-400";
}
