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

/**
 * Snap a value to exactly 0 when it would RENDER as zero at the given display
 * precision (i.e. |value| is under half a display unit). Keeps sign, color and
 * digits agreeing — a −€0.30 change must never show as a red "−€0".
 * Always returns +0 in the zero case (never −0, which Intl renders signed).
 */
export function snapDisplayZero(value: number, decimals: number): number {
  return Math.abs(value) < 0.5 / 10 ** decimals ? 0 : value;
}

/** Render-ready period-change pair — see {@link changeDisplayParts}. */
export interface ChangeDisplay {
  /** Signed currency change ("+€342", "-€1,298.50") — unsigned "€0" when display-zero. */
  value: string;
  /** Signed 1-decimal percent ("+1.9%", "-0.7%") — unsigned "0.0%" when display-zero. */
  pct: string;
  /** emerald/red from the DISPLAY-rounded direction; zinc when both parts are zero. */
  colorClass: string;
  /** Both parts round to zero → callers render the pct alone ("0.0%"). */
  isDisplayZero: boolean;
}

/**
 * Format a value+percent change pair with sign, color and the zero state all
 * derived from the values ROUNDED AT THEIR DISPLAY PRECISION — the single
 * source of truth for every inline period-change line (dashboard cards +
 * detail-page summary panels). `compact: true` renders whole currency units
 * (dashboard cards); default is 2-decimal currency (detail panels).
 * Direction (sign/color) follows the percent first — it is the headline of the
 * pair — and falls back to the value's direction when the percent rounds away.
 */
export function changeDisplayParts(
  valueChange: number,
  percent: number,
  currency: string,
  opts: { compact?: boolean } = {},
): ChangeDisplay {
  const v = snapDisplayZero(valueChange, opts.compact ? 0 : 2);
  const p = snapDisplayZero(percent, 1);
  const formatted = opts.compact
    ? fmtCurrencyCompact(v, currency)
    : fmtCurrency(v, currency);
  return {
    value: `${v > 0 ? "+" : ""}${formatted}`,
    pct: p === 0 ? "0.0%" : fmtPct(p),
    colorClass: changeColorClass(p !== 0 ? p : v),
    isDisplayZero: v === 0 && p === 0,
  };
}

/**
 * At-a-glance new-money disclosure shown next to a snapshot-period change
 * ("€10,000 deposited" / "€5,000 withdrawn"). Returns null when the deposit
 * total rounds to zero at display precision, so a negligible flow renders
 * nothing rather than "€0 deposited". Uses the same compact formatter as the
 * card's change value for visual parity (full numbers < €1M, compact above).
 */
export function formatDepositNote(total: number, currency: string): string | null {
  if (!isFinite(total)) return null;
  if (snapDisplayZero(total, 0) === 0) return null;
  const magnitude = fmtCurrencyCompact(Math.abs(total), currency);
  return total > 0 ? `${magnitude} deposited` : `${magnitude} withdrawn`;
}

/** Plain number with fixed decimal places */
export function formatNumber(n: number, decimals = 2): string {
  return _getNumberFormatter(decimals).format(n);
}

/** Format quantities (shares/holdings) — strips trailing zeros up to maxDecimals */
export function formatQuantity(n: number, maxDecimals: number): string {
  return _getNumberFormatter(maxDecimals, 2).format(n);
}

/**
 * Format a `YYYY-MM-DD` date for the correction-date suggest chip
 * ("Backdate to last change (Mar 2)?"). Month-short + day, with the year added
 * only when it differs from the current year (so a same-year backdate stays
 * terse and an older one is unambiguous).
 *
 * The string is parsed by splitting its components into a LOCAL date — not
 * `new Date("YYYY-MM-DD")`, which parses as UTC midnight and would render the
 * previous day in negative-offset timezones. `now` is injectable for
 * deterministic tests; returns the raw input unchanged if it isn't `YYYY-MM-DD`.
 */
export function formatBackdateChipDate(isoDate: string, now: Date = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  const [, yStr, moStr, dStr] = m;
  const year = Number(yStr);
  const d = new Date(year, Number(moStr) - 1, Number(dStr));
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(year !== now.getFullYear() ? { year: "numeric" } : {}),
  });
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
