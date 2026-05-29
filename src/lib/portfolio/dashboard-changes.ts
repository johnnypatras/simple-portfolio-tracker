/**
 * Dashboard change calculations — pure computation, no React.
 *
 * Computes period-based portfolio and per-asset-class value changes,
 * FX decomposition, and deposit sums from snapshots and cash flows.
 */

import type { PortfolioSnapshot, AssetClass, CashFlowEvent, RealCashFlowEvent, BaseCurrency } from "@/lib/types";
import { MIN_BREAKDOWN_DISPLAY_VALUE } from "@/lib/constants";

// ── Types ──────────────────────────────────────────────────

export interface ClassChange {
  percent: number;
  valueChange: number;
  available: boolean;
  fxPercent: number;
  fxValueChange: number;
}

export type ChangePeriod = "24h" | "3d" | "7d" | "30d" | "90d" | "1y" | "all";

export interface DepositResult {
  total: number;
  breakdown: { name: string; value: number }[];
}

/** All the values needed by change calculations, threaded from the component. */
export interface ChangeContext {
  primaryCurrency: BaseCurrency;
  totalValue: number;
  totalValueUsd: number;
  totalValueEur: number;
  totalValueChange24h: number;
  change24hPercent: number;
  fxChange24hPercent: number;
  fxValueChange24h: number;
  cryptoValue: number;
  cryptoValueUsd: number;
  cryptoValueEur: number;
  cryptoValueChange24h: number;
  cryptoFxChange24hPercent: number;
  cryptoFxValueChange24h: number;
  stocksValue: number;
  stocksValueUsd: number;
  stocksValueEur: number;
  stocksValueChange24h: number;
  stocksFxChange24hPercent: number;
  stocksFxValueChange24h: number;
  stocksHomeCurrencyEur: number;
  cashValue: number;
  cashValueUsd: number;
  cashValueEur: number;
  cashTotalValueChange24h: number;
  cashTotalFxChange24hPercent: number;
  cashTotalFxValueChange24h: number;
  cashHomeCurrencyEur: number;
  /** 24h crypto change percentage from DashboardInsights */
  cryptoChange24hPercent: number;
  pastSnapshots: Record<string, PortfolioSnapshot | null>;
  cashFlows: CashFlowEvent[];
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Derive per-class FX impact from snapshot dual-currency data.
 *
 * Computes the FX component of a value change by comparing the primary
 * currency return with the other currency return. The difference is the
 * FX impact. For classes with EUR-denominated holdings, scales the FX
 * amount by the average FX-sensitive fraction (foreign-currency portion).
 */
export function deriveClassFx(
  currentClassValue: number,
  currentClassUsd: number,
  currentClassEur: number,
  pastClassUsd: number,
  snapshot: PortfolioSnapshot,
  primaryCurrency: BaseCurrency,
  currentHomeCurrencyEur?: number,
  pastHomeCurrencyEur?: number | null,
): { fxPct: number; fxAbs: number; pastClassEur: number | null } {
  const snapTotalUsd = snapshot.total_value_usd ?? 0;
  const snapTotalEur = snapshot.total_value_eur ?? 0;
  // When EUR columns are null (old snapshots) or values are zero, we can't derive FX
  if (snapTotalUsd === 0 || snapTotalEur === 0 || pastClassUsd === 0)
    return { fxPct: 0, fxAbs: 0, pastClassEur: null };

  const impliedRate = snapTotalEur / snapTotalUsd;
  const pastClassEur = pastClassUsd * impliedRate;

  const usdReturn = ((currentClassUsd - pastClassUsd) / pastClassUsd) * 100;
  const eurReturn = ((currentClassEur - pastClassEur) / pastClassEur) * 100;

  const primaryReturn = primaryCurrency === "EUR" ? eurReturn : usdReturn;
  const otherReturn = primaryCurrency === "EUR" ? usdReturn : eurReturn;
  const fxPct = primaryReturn - otherReturn;
  let fxAbs = fxPct !== 0 && fxPct > -100 ? currentClassValue - currentClassValue / (1 + fxPct / 100) : 0;

  // Scale FX amount: only the foreign-currency (non-home) portion is FX-sensitive
  if (currentHomeCurrencyEur != null && pastHomeCurrencyEur != null
      && currentClassEur > 0 && pastClassEur > 0) {
    const currentFxFraction = 1 - (currentHomeCurrencyEur / currentClassEur);
    const pastFxFraction = 1 - (Number(pastHomeCurrencyEur) / pastClassEur);
    const avgFxFraction = (currentFxFraction + pastFxFraction) / 2;
    fxAbs = fxAbs * Math.max(0, Math.min(1, avgFxFraction));
  }

  return { fxPct, fxAbs, pastClassEur };
}

// ── Main functions ─────────────────────────────────────────

/** Total portfolio change for the given period. */
export function getChangeForPeriod(
  period: ChangePeriod,
  ctx: ChangeContext,
): ClassChange {
  if (period === "24h") {
    return {
      percent: ctx.change24hPercent,
      valueChange: ctx.totalValueChange24h,
      available: true,
      fxPercent: ctx.fxChange24hPercent,
      fxValueChange: ctx.fxValueChange24h,
    };
  }
  const snapshot = ctx.pastSnapshots[period];
  if (!snapshot) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };

  const valueKey = ctx.primaryCurrency === "EUR" ? "total_value_eur" : "total_value_usd";
  const otherKey = ctx.primaryCurrency === "EUR" ? "total_value_usd" : "total_value_eur";
  const currentValueOther = ctx.primaryCurrency === "EUR" ? ctx.totalValueUsd : ctx.totalValueEur;

  // pastValue is the AUGMENTED snapshot value: post-Phase-4 the period
  // snapshots come from getSnapshots → augmentAndExtendSnapshots, so backdated
  // crypto/stock/cash lots already contribute their reconstructed value at this
  // date. The `<= 0` guard therefore does NOT mean "no back-fill" — it catches a
  // genuinely-empty past portfolio (brand-new account, or no holdings yet as of
  // N days ago), returning "—" instead of a meaningless +∞% from a zero base.
  const pastValue = snapshot[valueKey] ?? 0;

  if (pastValue <= 0) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };

  const primaryReturn = ((ctx.totalValue - pastValue) / pastValue) * 100;

  // FX decomposition — compare directly against snapshot values
  const pastOther = snapshot[otherKey] ?? 0;

  let fxPct = 0;
  if (pastOther > 0 && currentValueOther > 0) {
    const otherReturn = ((currentValueOther - pastOther) / pastOther) * 100;
    fxPct = primaryReturn - otherReturn;
  }
  const fxAbs = fxPct !== 0 && fxPct > -100
    ? ctx.totalValue - ctx.totalValue / (1 + fxPct / 100)
    : 0;

  return {
    percent: primaryReturn,
    valueChange: ctx.totalValue - pastValue,
    available: true,
    fxPercent: fxPct,
    fxValueChange: fxAbs,
  };
}

/** Crypto value change for the given period. */
export function getCryptoChangeForPeriod(
  period: ChangePeriod,
  ctx: ChangeContext,
): ClassChange {
  if (period === "24h") {
    return {
      percent: ctx.cryptoChange24hPercent,
      valueChange: ctx.cryptoValueChange24h,
      available: true,
      fxPercent: ctx.cryptoFxChange24hPercent,
      fxValueChange: ctx.cryptoFxValueChange24h,
    };
  }
  const snapshot = ctx.pastSnapshots[period];
  if (!snapshot) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };
  // pastUsd is the augmented snapshot crypto value; `<= 0` means no crypto
  // existed at this date (new account / no holdings yet), not "no back-fill".
  const pastUsd = snapshot.crypto_value_usd ?? 0;
  if (pastUsd <= 0) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };
  const { fxPct, fxAbs, pastClassEur } = deriveClassFx(
    ctx.cryptoValue, ctx.cryptoValueUsd, ctx.cryptoValueEur, pastUsd, snapshot, ctx.primaryCurrency,
  );
  const pastEur = ctx.primaryCurrency === "EUR" ? pastClassEur : pastUsd;
  if (pastEur == null) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };
  const delta = ctx.cryptoValue - pastEur;
  const pct = pastEur > 0 ? (delta / pastEur) * 100 : 0;
  return { percent: pct, valueChange: delta, available: true, fxPercent: fxPct, fxValueChange: fxAbs };
}

/** Stock value change for the given period. */
export function getStockChangeForPeriod(
  period: ChangePeriod,
  ctx: ChangeContext,
): ClassChange {
  if (period === "24h") {
    const pct = ctx.stocksValue > 0 ? (ctx.stocksValueChange24h / ctx.stocksValue) * 100 : 0;
    return {
      percent: pct, valueChange: ctx.stocksValueChange24h, available: true,
      fxPercent: ctx.stocksFxChange24hPercent, fxValueChange: ctx.stocksFxValueChange24h,
    };
  }
  const snapshot = ctx.pastSnapshots[period];
  if (!snapshot) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };
  // pastUsd is the augmented snapshot stocks value; `<= 0` means no stocks
  // existed at this date (new account / no holdings yet), not "no back-fill".
  const pastUsd = snapshot.stocks_value_usd ?? 0;
  if (pastUsd <= 0) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };
  const { fxPct, fxAbs, pastClassEur } = deriveClassFx(
    ctx.stocksValue, ctx.stocksValueUsd, ctx.stocksValueEur, pastUsd, snapshot, ctx.primaryCurrency,
    ctx.stocksHomeCurrencyEur, snapshot.stocks_eur_denominated_value,
  );
  const pastEur = ctx.primaryCurrency === "EUR" ? pastClassEur : pastUsd;
  if (pastEur == null) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };
  const delta = ctx.stocksValue - pastEur;
  const pct = pastEur > 0 ? (delta / pastEur) * 100 : 0;
  return { percent: pct, valueChange: delta, available: true, fxPercent: fxPct, fxValueChange: fxAbs };
}

/** Cash value change for the given period. */
export function getCashChangeForPeriod(
  period: ChangePeriod,
  ctx: ChangeContext,
): ClassChange {
  if (period === "24h") {
    const pct = ctx.cashValue > 0 ? (ctx.cashTotalValueChange24h / ctx.cashValue) * 100 : 0;
    return {
      percent: pct, valueChange: ctx.cashTotalValueChange24h, available: true,
      fxPercent: ctx.cashTotalFxChange24hPercent, fxValueChange: ctx.cashTotalFxValueChange24h,
    };
  }
  const snapshot = ctx.pastSnapshots[period];
  if (!snapshot) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };
  // pastUsd is the augmented snapshot cash value; `<= 0` means no cash existed
  // at this date (new account / no holdings yet), not "no back-fill".
  const pastUsd = snapshot.cash_value_usd ?? 0;
  if (pastUsd <= 0) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };
  const { fxPct, fxAbs, pastClassEur } = deriveClassFx(
    ctx.cashValue, ctx.cashValueUsd, ctx.cashValueEur, pastUsd, snapshot, ctx.primaryCurrency,
    ctx.cashHomeCurrencyEur, snapshot.cash_eur_denominated_value,
  );
  const pastEur = ctx.primaryCurrency === "EUR" ? pastClassEur : pastUsd;
  if (pastEur == null) return { percent: 0, valueChange: 0, available: false, fxPercent: 0, fxValueChange: 0 };
  const delta = ctx.cashValue - pastEur;
  const pct = pastEur > 0 ? (delta / pastEur) * 100 : 0;
  return { percent: pct, valueChange: delta, available: true, fxPercent: fxPct, fxValueChange: fxAbs };
}

/** Deposit sums per period from cash flow events, optionally filtered by asset class. */
export function getDepositsForPeriod(
  period: ChangePeriod,
  ctx: ChangeContext,
  filterClass?: AssetClass,
): DepositResult {
  const fxMul = ctx.primaryCurrency === "USD" || ctx.totalValueUsd === 0 ? 1 : ctx.totalValue / ctx.totalValueUsd;
  return computeDeposits(period, ctx.cashFlows, ctx.primaryCurrency, fxMul, filterClass);
}

/**
 * Standalone deposit computation — usable without the full ChangeContext.
 * The detail pages (crypto/stocks/cash) call this directly.
 */
export function computeDeposits(
  period: ChangePeriod,
  cashFlows: CashFlowEvent[],
  primaryCurrency: BaseCurrency,
  fxMul: number,
  filterClass?: AssetClass,
): DepositResult {
  const now = new Date();
  const msMap: Record<ChangePeriod, number> = {
    "24h": 86400000, "3d": 3 * 86400000, "7d": 7 * 86400000, "30d": 30 * 86400000,
    "90d": 90 * 86400000, "1y": 365 * 86400000, "all": 100 * 365 * 86400000,
  };
  const cutoff = new Date(now.getTime() - msMap[period]);
  cutoff.setUTCHours(0, 0, 0, 0);
  // Strip synthetic benchmark-only flows BEFORE date/class filtering. These are
  // produced by buildBenchmarkCashFlows for is_adjustment backdated lots so the
  // S&P benchmark line has cash flows to replay; they were never real deposits
  // and would otherwise surface in the deposit tooltip as "Unknown" entries.
  // Typed guard (not a plain predicate): TS narrows the union through
  // `f is RealCashFlowEvent`, so `f.entity_name` below is accessible without a
  // cast. A plain `f => !f.synthetic` predicate would leave the result typed
  // as CashFlowEvent[] and make the entity_name read a compile error.
  const realFlows = cashFlows.filter((f): f is RealCashFlowEvent => !f.synthetic);
  const filtered = realFlows.filter(
    f => new Date(f.date) >= cutoff && (!filterClass || f.asset_class === filterClass)
  );
  const amt = (f: CashFlowEvent): number =>
    primaryCurrency === "EUR" && f.amount_eur != null ? f.amount_eur : f.amount_usd * fxMul;
  const total = filtered.reduce((s, f) => s + amt(f), 0);
  // Group by entity name
  const byName = new Map<string, number>();
  for (const f of filtered) {
    const name = f.entity_name || "Unknown";
    byName.set(name, (byName.get(name) ?? 0) + amt(f));
  }
  const breakdown = [...byName.entries()]
    .map(([name, value]) => ({ name, value }))
    .filter(e => Math.abs(e.value) >= MIN_BREAKDOWN_DISPLAY_VALUE)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return { total, breakdown };
}
