"use client";

import { useState, useCallback } from "react";
import { RotateCcw } from "lucide-react";
import type { PortfolioSummary } from "@/lib/portfolio/aggregate";
import { fmtCurrency, changeColorClass } from "@/lib/format";

// ─── Types ──────────────────────────────────────────────

interface Allocation {
  crypto: number;
  stocks: number;
  cash: number;
}

interface WhatIfCalculatorProps {
  viewerSummary: PortfolioSummary;
  ownerSummary: PortfolioSummary;
  viewerName: string;
  ownerName: string;
  currency: string;
}

type AssetClass = keyof Allocation;

const CLASS_META: { key: AssetClass; label: string; colorDot: string; colorBar: string }[] = [
  { key: "crypto", label: "Crypto", colorDot: "bg-orange-500", colorBar: "bg-orange-500" },
  { key: "stocks", label: "Equities", colorDot: "bg-blue-500", colorBar: "bg-blue-500" },
  { key: "cash", label: "Cash", colorDot: "bg-emerald-500", colorBar: "bg-emerald-500" },
];

// ─── Linked allocation logic ────────────────────────────

/**
 * When one allocation field changes, redistribute the difference
 * across the other two proportionally to their current shares.
 * Edge: if both others are 0, split equally.
 * Always returns values clamped to [0, 100] that sum to 100.
 */
function adjustAllocation(
  current: Allocation,
  changed: AssetClass,
  newValue: number
): Allocation {
  const clamped = Math.min(100, Math.max(0, newValue));
  const delta = clamped - current[changed];

  const otherKeys = (Object.keys(current) as AssetClass[]).filter(
    (k) => k !== changed
  );
  const otherSum = otherKeys.reduce((s, k) => s + current[k], 0);

  const result = { ...current, [changed]: clamped };

  if (otherSum === 0) {
    // Both others are 0 — split the reduction equally
    const each = -delta / otherKeys.length;
    for (const k of otherKeys) {
      result[k] = Math.max(0, Math.round(each));
    }
  } else {
    // Distribute proportionally
    for (const k of otherKeys) {
      const proportion = current[k] / otherSum;
      result[k] = Math.max(0, Math.round(current[k] - delta * proportion));
    }
  }

  // Fix rounding: ensure sum is exactly 100
  const sum = result.crypto + result.stocks + result.cash;
  if (sum !== 100) {
    // Adjust the largest "other" field by the rounding error
    const largest = otherKeys.reduce((a, b) =>
      result[a] >= result[b] ? a : b
    );
    result[largest] = Math.max(0, result[largest] + (100 - sum));
  }

  return result;
}

// ─── Allocation row ─────────────────────────────────────

function AllocationRow({
  label,
  colorDot,
  colorBar,
  value,
  onChange,
}: {
  label: string;
  colorDot: string;
  colorBar: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5 w-20 shrink-0">
        <div className={`w-2 h-2 rounded-full ${colorDot}`} />
        <span className="text-xs text-zinc-400">{label}</span>
      </div>
      <div className="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={`h-full rounded-full ${colorBar} transition-all duration-200`}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        <input
          type="number"
          min={0}
          max={100}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-12 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-200 text-right
                     focus:outline-none focus:border-zinc-500 [appearance:textfield]
                     [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span className="text-[10px] text-zinc-600">%</span>
      </div>
    </div>
  );
}

// ─── Result row ─────────────────────────────────────────

function ResultRow({
  label,
  colorDot,
  currentValue,
  newValue,
  currency,
  isTotalRow,
}: {
  label: string;
  colorDot?: string;
  currentValue: number;
  newValue: number;
  currency: string;
  isTotalRow?: boolean;
}) {
  const delta = newValue - currentValue;
  const textWeight = isTotalRow ? "font-semibold" : "font-normal";

  return (
    <div
      className={`grid grid-cols-4 gap-2 py-2 items-center ${
        isTotalRow
          ? "border-t border-zinc-700 mt-1 pt-3"
          : "border-b border-zinc-800/50"
      }`}
    >
      {/* Label */}
      <div className="flex items-center gap-1.5">
        {colorDot && <div className={`w-2 h-2 rounded-full ${colorDot}`} />}
        <span className={`text-xs text-zinc-300 ${textWeight}`}>{label}</span>
      </div>

      {/* Current */}
      <div className={`text-xs text-zinc-400 text-right ${textWeight}`}>
        {fmtCurrency(currentValue, currency, 0)}
      </div>

      {/* What If */}
      <div className={`text-xs text-zinc-200 text-right ${textWeight}`}>
        {fmtCurrency(newValue, currency, 0)}
      </div>

      {/* Change */}
      <div className={`text-xs text-right ${changeColorClass(delta)}`}>
        {Math.abs(delta) < 1 ? (
          <span className="text-zinc-600">—</span>
        ) : (
          <>
            {delta >= 0 ? "+" : ""}
            {fmtCurrency(Math.abs(delta), currency, 0)}
            {delta < 0 && <span className="text-zinc-600"> less</span>}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────

export function WhatIfCalculator({
  viewerSummary,
  ownerSummary,
  viewerName,
  ownerName,
  currency,
}: WhatIfCalculatorProps) {
  const defaultTotal = viewerSummary.totalValue;
  const defaultAlloc: Allocation = {
    crypto: Math.round(viewerSummary.allocation.crypto),
    stocks: Math.round(viewerSummary.allocation.stocks),
    cash: Math.round(viewerSummary.allocation.cash),
  };

  const [total, setTotal] = useState(defaultTotal);
  const [alloc, setAlloc] = useState<Allocation>(defaultAlloc);

  const handleAllocChange = useCallback(
    (key: AssetClass, value: number) => {
      setAlloc((prev) => adjustAllocation(prev, key, value));
    },
    []
  );

  const reset = useCallback(() => {
    setTotal(defaultTotal);
    setAlloc(defaultAlloc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultTotal]);

  const matchOwnerTotal = useCallback(() => {
    setTotal(ownerSummary.totalValue);
  }, [ownerSummary.totalValue]);

  const matchOwnerAlloc = useCallback(() => {
    setAlloc({
      crypto: Math.round(ownerSummary.allocation.crypto),
      stocks: Math.round(ownerSummary.allocation.stocks),
      cash: Math.round(ownerSummary.allocation.cash),
    });
  }, [ownerSummary.allocation]);

  // Computed what-if values
  const newCrypto = total * (alloc.crypto / 100);
  const newStocks = total * (alloc.stocks / 100);
  const newCash = total * (alloc.cash / 100);
  const newTotal = newCrypto + newStocks + newCash;

  const isDisabled = total === 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800/50 rounded-lg p-4 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
          What If Calculator
        </h2>
        <button
          onClick={reset}
          className="flex items-center gap-1 text-[11px] text-zinc-600 hover:text-zinc-300 transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          Reset
        </button>
      </div>

      {/* ── Total investment input ─────────────────────── */}
      <div>
        <div className="text-[10px] text-zinc-600 uppercase tracking-wider font-medium mb-2">
          Total Investment
        </div>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-zinc-500">
              {currency}
            </span>
            <input
              type="number"
              value={Math.round(total)}
              onChange={(e) => setTotal(Math.max(0, Number(e.target.value)))}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-11 pr-3 py-2 text-sm text-zinc-200
                         focus:outline-none focus:border-zinc-500 [appearance:textfield]
                         [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
          </div>
          <button
            onClick={matchOwnerTotal}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 border border-zinc-800 rounded-md px-2.5 py-2 transition-colors whitespace-nowrap"
          >
            Match {ownerName}
          </button>
        </div>
      </div>

      {/* ── Allocation sliders ─────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-medium">
            Allocation
          </span>
          <button
            onClick={matchOwnerAlloc}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Match {ownerName}&apos;s mix
          </button>
        </div>
        <div className={`space-y-2.5 ${isDisabled ? "opacity-40 pointer-events-none" : ""}`}>
          {CLASS_META.map((cls) => (
            <AllocationRow
              key={cls.key}
              label={cls.label}
              colorDot={cls.colorDot}
              colorBar={cls.colorBar}
              value={alloc[cls.key]}
              onChange={(v) => handleAllocChange(cls.key, v)}
            />
          ))}
        </div>
      </div>

      {/* ── Results table ──────────────────────────────── */}
      <div>
        <div className="text-[10px] text-zinc-600 uppercase tracking-wider font-medium mb-2">
          Result
        </div>

        {/* Column headers */}
        <div className="grid grid-cols-4 gap-2 mb-1">
          <div />
          <div className="text-[10px] text-zinc-600 text-right">{viewerName} Now</div>
          <div className="text-[10px] text-zinc-600 text-right">What If</div>
          <div className="text-[10px] text-zinc-600 text-right">Change</div>
        </div>

        {/* Class rows */}
        {CLASS_META.map((cls) => {
          const currentMap: Record<AssetClass, number> = {
            crypto: viewerSummary.cryptoValue,
            stocks: viewerSummary.stocksValue,
            cash: viewerSummary.cashValue,
          };
          const newMap: Record<AssetClass, number> = {
            crypto: newCrypto,
            stocks: newStocks,
            cash: newCash,
          };
          return (
            <ResultRow
              key={cls.key}
              label={cls.label}
              colorDot={cls.colorDot}
              currentValue={currentMap[cls.key]}
              newValue={newMap[cls.key]}
              currency={currency}
            />
          );
        })}

        {/* Total row */}
        <ResultRow
          label="Total"
          currentValue={viewerSummary.totalValue}
          newValue={newTotal}
          currency={currency}
          isTotalRow
        />
      </div>
    </div>
  );
}
