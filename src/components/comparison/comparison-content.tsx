"use client";

import Link from "next/link";
import type { ComparisonData } from "@/lib/actions/comparison";
import { fmtCurrency, fmtPct, changeColorClass } from "@/lib/format";

interface ComparisonContentProps {
  data: ComparisonData;
  token: string;
}

// ─── Allocation bar ─────────────────────────────────────

function AllocationBar({
  allocation,
  label,
}: {
  allocation: { crypto: number; stocks: number; cash: number };
  label: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>{label}</span>
        <span>
          {allocation.crypto.toFixed(0)}% / {allocation.stocks.toFixed(0)}% /{" "}
          {allocation.cash.toFixed(0)}%
        </span>
      </div>
      <div className="flex h-2 rounded-full overflow-hidden bg-zinc-800">
        {allocation.crypto > 0 && (
          <div
            className="bg-orange-400 transition-all duration-500"
            style={{ width: `${allocation.crypto}%` }}
          />
        )}
        {allocation.stocks > 0 && (
          <div
            className="bg-blue-400 transition-all duration-500"
            style={{ width: `${allocation.stocks}%` }}
          />
        )}
        {allocation.cash > 0 && (
          <div
            className="bg-emerald-400 transition-all duration-500"
            style={{ width: `${allocation.cash}%` }}
          />
        )}
      </div>
    </div>
  );
}

// ─── Class breakdown row ────────────────────────────────

function BreakdownRow({
  label,
  colorClass,
  viewerValue,
  ownerValue,
  currency,
}: {
  label: string;
  colorClass: string;
  viewerValue: number;
  ownerValue: number;
  currency: string;
}) {
  const delta = viewerValue - ownerValue;
  const deltaPercent = ownerValue !== 0 ? (delta / ownerValue) * 100 : 0;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${colorClass}`} />
        <span className="text-xs font-medium text-zinc-300">{label}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 pl-4">
        <div className="text-sm text-zinc-100">
          {fmtCurrency(viewerValue, currency, 0)}
        </div>
        <div className="text-sm text-zinc-400">
          {fmtCurrency(ownerValue, currency, 0)}
        </div>
      </div>
      {(viewerValue > 0 || ownerValue > 0) && (
        <div className={`text-xs pl-4 ${changeColorClass(delta)}`}>
          {delta >= 0 ? "+" : ""}
          {fmtCurrency(Math.abs(delta), currency, 0)}
          {delta >= 0 ? " more" : " less"}
          {ownerValue > 0 && ` (${fmtPct(deltaPercent)})`}
        </div>
      )}
    </div>
  );
}

// ─── Main content ───────────────────────────────────────

export function ComparisonContent({ data, token }: ComparisonContentProps) {
  const { viewer, owner, normalizedCurrency: cur } = data;
  const vs = viewer.summary;
  const os = owner.summary;

  // Empty portfolio state
  if (vs.totalValue === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
        <div className="text-zinc-500 text-sm mb-3">
          You haven&apos;t added any assets yet.
        </div>
        <Link
          href="/dashboard"
          className="text-blue-400 hover:text-blue-300 text-sm font-medium transition-colors"
        >
          Add assets to your portfolio to compare
        </Link>
      </div>
    );
  }

  const totalDelta = vs.totalValue - os.totalValue;
  const totalDeltaPercent =
    os.totalValue !== 0 ? (totalDelta / os.totalValue) * 100 : 0;

  return (
    <div className="space-y-5">
      {/* Currency note */}
      <div className="text-[10px] text-zinc-600 uppercase tracking-wider">
        All values in {cur}
      </div>

      {/* ── Total value comparison ────────────────────── */}
      <div>
        <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">
          Total Value
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-zinc-500 mb-0.5">You</div>
            <div className="text-lg font-semibold text-zinc-100">
              {fmtCurrency(vs.totalValue, cur, 0)}
            </div>
            <div className={`text-xs ${changeColorClass(vs.change24hPercent)}`}>
              {fmtPct(vs.change24hPercent)} 24h
            </div>
          </div>
          <div>
            <div className="text-xs text-zinc-500 mb-0.5">{owner.name}</div>
            <div className="text-lg font-semibold text-zinc-400">
              {fmtCurrency(os.totalValue, cur, 0)}
            </div>
            <div className={`text-xs ${changeColorClass(os.change24hPercent)}`}>
              {fmtPct(os.change24hPercent)} 24h
            </div>
          </div>
        </div>
        <div
          className={`mt-2 text-xs font-medium ${changeColorClass(totalDelta)}`}
        >
          {totalDelta >= 0 ? "+" : ""}
          {fmtCurrency(Math.abs(totalDelta), cur, 0)}
          {totalDelta >= 0 ? " ahead" : " behind"}
          {os.totalValue > 0 && ` (${fmtPct(totalDeltaPercent)})`}
        </div>
      </div>

      {/* ── Allocation comparison ─────────────────────── */}
      <div>
        <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">
          Allocation
        </div>
        <div className="space-y-3">
          <AllocationBar allocation={vs.allocation} label="You" />
          <AllocationBar allocation={os.allocation} label={owner.name} />
        </div>
        {/* Allocation delta summary */}
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
          <DeltaBadge
            label="Crypto"
            delta={vs.allocation.crypto - os.allocation.crypto}
          />
          <DeltaBadge
            label="Stocks"
            delta={vs.allocation.stocks - os.allocation.stocks}
          />
          <DeltaBadge
            label="Cash"
            delta={vs.allocation.cash - os.allocation.cash}
          />
        </div>
      </div>

      {/* ── Class-level breakdown ─────────────────────── */}
      <div>
        <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">
          Breakdown
        </div>
        {/* Column headers */}
        <div className="grid grid-cols-2 gap-3 pl-4 mb-2">
          <div className="text-[10px] text-zinc-600 uppercase tracking-wider">
            You
          </div>
          <div className="text-[10px] text-zinc-600 uppercase tracking-wider">
            {owner.name}
          </div>
        </div>
        <div className="space-y-3">
          <BreakdownRow
            label="Crypto"
            colorClass="bg-orange-400"
            viewerValue={vs.cryptoValue}
            ownerValue={os.cryptoValue}
            currency={cur}
          />
          <BreakdownRow
            label="Equities"
            colorClass="bg-blue-400"
            viewerValue={vs.stocksValue}
            ownerValue={os.stocksValue}
            currency={cur}
          />
          <BreakdownRow
            label="Cash"
            colorClass="bg-emerald-400"
            viewerValue={vs.cashValue}
            ownerValue={os.cashValue}
            currency={cur}
          />
        </div>
      </div>

      {/* ── Footer ────────────────────────────────────── */}
      <div className="pt-3 border-t border-zinc-800/50">
        <Link
          href={`/dashboard/compare/${token}`}
          className="text-xs text-blue-400 hover:text-blue-300 font-medium transition-colors"
        >
          View full comparison &rarr;
        </Link>
      </div>
    </div>
  );
}

// ─── Allocation delta badge ─────────────────────────────

function DeltaBadge({ label, delta }: { label: string; delta: number }) {
  if (Math.abs(delta) < 0.5) return null;
  return (
    <span className={changeColorClass(delta)}>
      {delta > 0 ? "+" : ""}
      {delta.toFixed(0)}pp {label.toLowerCase()}
    </span>
  );
}
