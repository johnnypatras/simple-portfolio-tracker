/**
 * Shared P&L column renderers for the three holdings tables (crypto / stock /
 * cash). Task 3.3b.
 *
 * One source of truth so the four cost-basis columns — Avg Cost, Unrealized,
 * Realized, Total P&L — render identically across all three tables.
 *
 * CURRENCY DISPLAY CONTRACT (documented + consistent across all three tables):
 *   EUR is the AUTHORITATIVE headline P&L everywhere. These renderers ALWAYS
 *   read `pnl.eur.*` regardless of the table's currency toggle. When the table
 *   is in USD mode (primaryCurrency !== "EUR") the cells carry
 *   `title={COST_COPY.fxDivergenceTooltip}` because the USD pass legitimately
 *   diverges by FX timing — the headline intentionally stays EUR. This matches
 *   the engine's "EUR authoritative, USD secondary, never reconciled" model
 *   (cost-basis.ts §7.7) and keeps one number across the whole UI.
 *
 * A missing P&L entry (no transactions / cost data, or graceful-degradation
 * when the read failed) renders "—" in every cell.
 */

import type { ReactNode } from "react";
import type { AssetPnL, CostBasisResult } from "@/lib/portfolio/cost-basis";
import { fmtCurrency, fmtPct, changeColorClass } from "@/lib/format";
import { COST_COPY } from "@/lib/cost-basis-copy";

const DASH = <span className="text-xs text-zinc-400">—</span>;

/** True when the table is showing a non-EUR headline (USD toggle). */
function isDivergent(primaryCurrency: string): boolean {
  return primaryCurrency.toUpperCase() !== "EUR";
}

/** Tooltip applied to P&L cells in USD mode — explains the EUR/USD divergence. */
function divergenceTitle(primaryCurrency: string): string | undefined {
  return isDivergent(primaryCurrency) ? COST_COPY.fxDivergenceTooltip : undefined;
}

/**
 * Per-unit avg cost in EUR. Sub-€1 gets 6-decimal precision (mirrors the crypto
 * price column's sub-$1 rule); €1+ uses standard 2-decimal currency. Always EUR
 * (authoritative). "—" when there is no cost (0 held units → avgCost 0).
 */
export function renderAvgCostCell(
  pnl: AssetPnL | undefined,
  primaryCurrency: string,
): ReactNode {
  if (!pnl) return DASH;
  const v = pnl.eur.avgCost;
  if (!(v > 0)) return DASH;
  const text = v >= 1 ? fmtCurrency(v, "EUR") : `€${v.toFixed(6)}`;
  return (
    <span
      className="text-sm text-zinc-100 tabular-nums"
      title={divergenceTitle(primaryCurrency)}
    >
      {text}
    </span>
  );
}

/**
 * Unrealized €  + % vs costBasis (only when costBasis > 0). Colored by sign.
 * "—" when no P&L entry. A zero unrealized is shown (€0.00) — it is meaningful
 * for a held position at break-even — but only when there is a cost basis.
 */
export function renderUnrealizedCell(
  pnl: AssetPnL | undefined,
  primaryCurrency: string,
): ReactNode {
  if (!pnl) return DASH;
  const { unrealized, costBasis } = pnl.eur;
  // No held cost basis → nothing to be unrealized against.
  if (!(costBasis > 0)) return DASH;
  const pct = (unrealized / costBasis) * 100;
  return (
    <span
      className={`text-sm tabular-nums ${changeColorClass(unrealized)}`}
      title={divergenceTitle(primaryCurrency)}
    >
      {fmtCurrency(unrealized, "EUR")}
      <span className="block text-[11px]">{fmtPct(pct)}</span>
    </span>
  );
}

/**
 * Realized € (locked-in gains/losses from disposals). Colored by sign.
 * "—" when EXACTLY 0 (pure-hold lockdown — a position never sold shows no
 * realized number) OR when there is no P&L entry.
 */
export function renderRealizedCell(
  pnl: AssetPnL | undefined,
  primaryCurrency: string,
): ReactNode {
  if (!pnl) return DASH;
  const { realized } = pnl.eur;
  if (realized === 0) return DASH; // pure-hold lockdown
  return (
    <span
      className={`text-sm tabular-nums ${changeColorClass(realized)}`}
      title={divergenceTitle(primaryCurrency)}
    >
      {fmtCurrency(realized, "EUR")}
    </span>
  );
}

/**
 * Total P&L € (realized + unrealized) + % vs costBasis (only when costBasis > 0).
 * Colored by sign. "—" when no P&L entry.
 */
export function renderTotalPnLCell(
  pnl: AssetPnL | undefined,
  primaryCurrency: string,
): ReactNode {
  if (!pnl) return DASH;
  const { totalPnL, costBasis } = pnl.eur;
  const pct = costBasis > 0 ? (totalPnL / costBasis) * 100 : null;
  return (
    <span
      className={`text-sm tabular-nums ${changeColorClass(totalPnL)}`}
      title={divergenceTitle(primaryCurrency)}
    >
      {fmtCurrency(totalPnL, "EUR")}
      {pct != null && <span className="block text-[11px]">{fmtPct(pct)}</span>}
    </span>
  );
}

/**
 * Sum the additive EUR P&L fields across a set of assets' streams into a single
 * synthetic {@link AssetPnL} for a GROUP row. avgCost has no group-level meaning
 * (it is a per-asset ratio) so it is forced to 0 → the Avg Cost cell renders "—"
 * on group rows. Mirrors how groups sum `value` today. Returns undefined when no
 * member has a P&L entry (→ all cells "—").
 */
export function sumGroupPnL(
  keys: string[],
  pnlByAsset: Record<string, AssetPnL> | undefined,
): AssetPnL | undefined {
  if (!pnlByAsset) return undefined;
  let any = false;
  const acc = (pick: (r: CostBasisResult) => number, cur: "eur" | "usd") =>
    keys.reduce((sum, k) => {
      const p = pnlByAsset[k];
      if (p) sum += pick(p[cur]);
      return sum;
    }, 0);
  for (const k of keys) {
    if (pnlByAsset[k]) {
      any = true;
      break;
    }
  }
  if (!any) return undefined;
  const build = (cur: "eur" | "usd"): CostBasisResult => ({
    avgCost: 0, // no group-level meaning → Avg Cost renders "—"
    costBasis: acc((r) => r.costBasis, cur),
    realized: acc((r) => r.realized, cur),
    unrealized: acc((r) => r.unrealized, cur),
    totalPnL: acc((r) => r.totalPnL, cur),
  });
  return { eur: build("eur"), usd: build("usd") };
}
