"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ComparisonData } from "@/lib/actions/comparison";
import { fmtCurrency, fmtPct, changeColorClass } from "@/lib/format";
import { AllocationRadar } from "./allocation-radar";
import { HoldingsOverlap } from "./holdings-overlap";
import { PerformanceRaceChart } from "./performance-race-chart";
import { WhatIfCalculator } from "./what-if-calculator";

interface ComparisonPageProps {
  data: ComparisonData;
  token: string;
}

// ─── Summary stat card ──────────────────────────────────

function StatCard({
  label,
  value,
  subtext,
  subtextColor,
}: {
  label: string;
  value: string;
  subtext?: string;
  subtextColor?: string;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800/50 rounded-lg p-4">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className="text-lg font-semibold text-zinc-100">{value}</div>
      {subtext && (
        <div className={`text-xs mt-0.5 ${subtextColor ?? "text-zinc-500"}`}>
          {subtext}
        </div>
      )}
    </div>
  );
}

// ─── Breakdown card (per asset class) ───────────────────

function BreakdownCard({
  label,
  colorClass,
  viewerValue,
  ownerValue,
  viewerName,
  ownerName,
  currency,
}: {
  label: string;
  colorClass: string;
  viewerValue: number;
  ownerValue: number;
  viewerName: string;
  ownerName: string;
  currency: string;
}) {
  const delta = viewerValue - ownerValue;
  const deltaPercent = ownerValue !== 0 ? (delta / ownerValue) * 100 : 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800/50 rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className={`w-2.5 h-2.5 rounded-full ${colorClass}`} />
        <span className="text-sm font-medium text-zinc-200">{label}</span>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-0.5">
            {viewerName}
          </div>
          <div className="text-base font-semibold text-zinc-100">
            {fmtCurrency(viewerValue, currency, 0)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-0.5">
            {ownerName}
          </div>
          <div className="text-base font-semibold text-zinc-400">
            {fmtCurrency(ownerValue, currency, 0)}
          </div>
        </div>
      </div>
      {(viewerValue > 0 || ownerValue > 0) && (
        <div className={`text-xs ${changeColorClass(delta)}`}>
          {delta >= 0 ? "+" : ""}
          {fmtCurrency(Math.abs(delta), currency, 0)}
          {delta >= 0 ? " more" : " less"}
          {ownerValue > 0 && ` (${fmtPct(deltaPercent)})`}
        </div>
      )}
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────

export function ComparisonPage({ data, token }: ComparisonPageProps) {
  const { viewer, owner, normalizedCurrency: cur } = data;
  const vs = viewer.summary;
  const os = owner.summary;

  // Empty portfolio state
  if (vs.totalValue === 0) {
    return (
      <div className="pt-8">
        <Link
          href={`/share/${token}`}
          className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-300 transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to shared portfolio
        </Link>
        <div className="flex flex-col items-center justify-center py-16 text-center">
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
      </div>
    );
  }

  const totalDelta = vs.totalValue - os.totalValue;
  const totalDeltaPercent =
    os.totalValue !== 0 ? (totalDelta / os.totalValue) * 100 : 0;

  // Determine best performing class (where viewer is ahead most in absolute terms)
  const classDiffs = [
    { label: "Crypto", diff: vs.cryptoValue - os.cryptoValue },
    { label: "Equities", diff: vs.stocksValue - os.stocksValue },
    { label: "Cash", diff: vs.cashValue - os.cashValue },
  ];
  const bestClass = classDiffs.reduce((a, b) => (b.diff > a.diff ? b : a));

  return (
    <div className="pt-8 space-y-8">
      {/* ── Header ──────────────────────────────────────── */}
      <div>
        <Link
          href={`/share/${token}`}
          className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-300 transition-colors mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to shared portfolio
        </Link>
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-xl font-bold text-zinc-100">
            You vs {owner.name}
          </h1>
          <span className="text-xs text-zinc-600 uppercase tracking-wider">
            All values in {cur}
          </span>
        </div>
      </div>

      {/* ── Summary cards ───────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Your Total"
          value={fmtCurrency(vs.totalValue, cur, 0)}
          subtext={`${fmtPct(vs.change24hPercent)} 24h`}
          subtextColor={changeColorClass(vs.change24hPercent)}
        />
        <StatCard
          label={`${owner.name}'s Total`}
          value={fmtCurrency(os.totalValue, cur, 0)}
          subtext={`${fmtPct(os.change24hPercent)} 24h`}
          subtextColor={changeColorClass(os.change24hPercent)}
        />
        <StatCard
          label="Difference"
          value={`${totalDelta >= 0 ? "+" : ""}${fmtCurrency(Math.abs(totalDelta), cur, 0)}`}
          subtext={`${totalDelta >= 0 ? "ahead" : "behind"} (${fmtPct(totalDeltaPercent)})`}
          subtextColor={changeColorClass(totalDelta)}
        />
        <StatCard
          label="Strongest Class"
          value={bestClass.label}
          subtext={
            bestClass.diff >= 0
              ? `+${fmtCurrency(bestClass.diff, cur, 0)} ahead`
              : `${fmtCurrency(Math.abs(bestClass.diff), cur, 0)} behind`
          }
          subtextColor={changeColorClass(bestClass.diff)}
        />
      </div>

      {/* ── Allocation radar + breakdown ────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Radar chart */}
        <div className="bg-zinc-900 border border-zinc-800/50 rounded-lg p-4">
          <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">
            Allocation
          </h2>
          <AllocationRadar
            viewerAllocation={vs.allocation}
            ownerAllocation={os.allocation}
            viewerName="You"
            ownerName={owner.name}
          />
        </div>

        {/* Breakdown cards */}
        <div className="space-y-3">
          <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">
            Breakdown
          </h2>
          <BreakdownCard
            label="Crypto"
            colorClass="bg-orange-400"
            viewerValue={vs.cryptoValue}
            ownerValue={os.cryptoValue}
            viewerName="You"
            ownerName={owner.name}
            currency={cur}
          />
          <BreakdownCard
            label="Equities"
            colorClass="bg-blue-400"
            viewerValue={vs.stocksValue}
            ownerValue={os.stocksValue}
            viewerName="You"
            ownerName={owner.name}
            currency={cur}
          />
          <BreakdownCard
            label="Cash"
            colorClass="bg-emerald-400"
            viewerValue={vs.cashValue}
            ownerValue={os.cashValue}
            viewerName="You"
            ownerName={owner.name}
            currency={cur}
          />
        </div>
      </div>

      {/* ── Holdings overlap ─────────────────────────────── */}
      <HoldingsOverlap
        holdings={data.holdings}
        viewerName="You"
        ownerName={owner.name}
        currency={cur}
      />

      {/* ── Performance race chart ─────────────────────── */}
      <PerformanceRaceChart
        viewerSnapshots={data.viewerSnapshots}
        ownerSnapshots={data.ownerSnapshots}
        viewerLiveValue={vs.totalValue}
        ownerLiveValue={os.totalValue}
        viewerName="You"
        ownerName={owner.name}
        currency={cur}
      />

      {/* ── What If Calculator ──────────────────────────── */}
      <WhatIfCalculator
        viewerSummary={vs}
        ownerSummary={os}
        viewerName="You"
        ownerName={owner.name}
        currency={cur}
      />
    </div>
  );
}
