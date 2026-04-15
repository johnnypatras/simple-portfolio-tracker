import { memo, useState } from "react";
import { fmtCurrencyCompact, fmtPct, changeColorClass } from "@/lib/format";

const DEPOSIT_BREAKDOWN_LIMIT = 5;

function TooltipRow({
  label, value, cur, colored, bold, pct, indent,
}: {
  label: string; value: number; cur: string; colored?: boolean; bold?: boolean;
  pct?: number; indent?: boolean;
}) {
  const formatted = `${value > 0 ? "+" : ""}${fmtCurrencyCompact(value, cur)}`;
  const colorCls = colored ? changeColorClass(value) : indent ? "text-zinc-400" : "text-zinc-300";
  const hasPct = pct != null && isFinite(pct) && Math.abs(pct) >= 0.05;
  return (
    <>
      <span className={`${indent ? "pl-3 text-zinc-400" : "text-zinc-400"} ${bold ? "font-medium" : ""} whitespace-nowrap`}>{label}</span>
      <span className={`${colorCls} ${bold ? "font-medium" : ""} tabular-nums whitespace-nowrap text-right`}>{formatted}</span>
      <span className={`text-zinc-400 tabular-nums whitespace-nowrap ${bold ? "font-medium" : ""}`}>
        {hasPct ? `(${fmtPct(pct!)})` : ""}
      </span>
    </>
  );
}

function DepositSection({ deposits, depositBreakdown, cur, base }: {
  deposits: number;
  depositBreakdown?: { name: string; value: number }[];
  cur: string;
  base?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = depositBreakdown ?? [];
  const hasBreakdown = items.length >= 1;
  const needsExpand = items.length > DEPOSIT_BREAKDOWN_LIMIT;
  const visible = expanded ? items : items.slice(0, DEPOSIT_BREAKDOWN_LIMIT);

  return (
    <>
      <div className="col-span-3 border-t border-zinc-700 mt-1 pt-1" />
      <TooltipRow label={deposits > 0 ? "Deposits" : "Withdrawals"} value={deposits} cur={cur} pct={base ? (deposits / base) * 100 : undefined} />
      {hasBreakdown && visible.map((e) => (
        <TooltipRow key={e.name} label={e.name} value={e.value} cur={cur} indent />
      ))}
      {needsExpand && (
        <button
          type="button"
          aria-expanded={expanded}
          className="col-span-3 text-[10px] text-zinc-400 hover:text-zinc-300 text-left pl-3 transition-colors"
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        >
          {expanded ? "Show less" : `+${items.length - DEPOSIT_BREAKDOWN_LIMIT} more`}
        </button>
      )}
    </>
  );
}

export const ChangeTooltip = memo(function ChangeTooltip({
  valueChange, fxValueChange, deposits, depositBreakdown, startValue, cur, open,
}: {
  valueChange: number; fxValueChange: number; deposits: number;
  depositBreakdown?: { name: string; value: number }[];
  startValue?: number; cur: string; open?: boolean;
}) {
  const hasFx = Math.abs(fxValueChange) >= 0.5;
  const hasDeposits = Math.abs(deposits) >= 0.5;

  // Nothing to decompose — suppress tooltip
  if (!hasFx && !hasDeposits) return null;

  const assetPrices = valueChange - fxValueChange - deposits;
  const marketChange = valueChange - deposits; // prices + FX combined
  const fxLabel = cur === "EUR" ? "EUR/USD" : "USD/EUR";
  const base = startValue && startValue > 0 ? startValue : undefined;

  return (
    <div className={`absolute right-0 sm:right-auto sm:left-0 top-full mt-1 z-50 ${open ? "block" : "hidden group-hover/tip:block group-focus-within/tip:block"}`}>
      <div className="bg-zinc-800/95 backdrop-blur border border-zinc-700 rounded-lg shadow-xl px-2.5 py-2 text-[10px] tabular-nums grid grid-cols-[auto_auto_auto] gap-x-2.5 gap-y-0.5 w-max max-w-[min(320px,calc(100vw-3rem))]">
        {/* Market row: price + FX performance, excluding deposits — only when deposits exist */}
        {hasDeposits && (
          <TooltipRow label="Market" value={marketChange} cur={cur} colored bold pct={base ? (marketChange / base) * 100 : undefined} />
        )}
        {/* Prices + FX decomposition — indented under Market when deposits exist */}
        {(hasFx || !hasDeposits) && <TooltipRow label="Prices" value={assetPrices} cur={cur} colored={!hasDeposits} indent={hasDeposits} pct={base ? (assetPrices / base) * 100 : undefined} />}
        {hasFx && <TooltipRow label={fxLabel} value={fxValueChange} cur={cur} colored={!hasDeposits} indent={hasDeposits} pct={base ? (fxValueChange / base) * 100 : undefined} />}
        {hasDeposits && (
          <DepositSection deposits={deposits} depositBreakdown={depositBreakdown} cur={cur} base={base} />
        )}
        {/* Separator + Total row */}
        <div className="col-span-3 border-t border-zinc-700 mt-1 pt-1" />
        <TooltipRow label="Total" value={valueChange} cur={cur} colored bold pct={base ? (valueChange / base) * 100 : undefined} />
      </div>
    </div>
  );
});
