"use client";

import Image from "next/image";
import type { HoldingItem } from "@/lib/actions/comparison";
import { fmtCurrency } from "@/lib/format";

interface HoldingsOverlapProps {
  holdings: HoldingItem[];
  viewerName: string;
  ownerName: string;
  currency: string;
}

// ─── Asset icon with fallback ────────────────────────────

function AssetIcon({
  item,
  size = 24,
}: {
  item: HoldingItem;
  size?: number;
}) {
  if (item.imageUrl) {
    return (
      <Image
        src={item.imageUrl}
        alt={item.name}
        width={size}
        height={size}
        className="rounded-full bg-zinc-800"
        unoptimized
      />
    );
  }
  // Fallback: colored circle with first letter
  const bg =
    item.class === "crypto"
      ? "bg-orange-500/20 text-orange-400"
      : item.class === "equities"
        ? "bg-blue-500/20 text-blue-400"
        : "bg-emerald-500/20 text-emerald-400";
  return (
    <div
      className={`flex items-center justify-center rounded-full ${bg}`}
      style={{ width: size, height: size }}
    >
      <span className="text-[10px] font-semibold leading-none">
        {item.ticker.charAt(0)}
      </span>
    </div>
  );
}

// ─── Dual bar for shared holdings ────────────────────────

function DualBar({
  viewerValue,
  ownerValue,
  maxValue,
}: {
  viewerValue: number;
  ownerValue: number;
  maxValue: number;
}) {
  const vPct = maxValue > 0 ? (viewerValue / maxValue) * 100 : 0;
  const oPct = maxValue > 0 ? (ownerValue / maxValue) * 100 : 0;

  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
        <div
          className="h-full rounded-full bg-blue-500"
          style={{ width: `${Math.min(vPct, 100)}%` }}
        />
      </div>
      <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
        <div
          className="h-full rounded-full bg-orange-500"
          style={{ width: `${Math.min(oPct, 100)}%` }}
        />
      </div>
    </div>
  );
}

// ─── Single holding row (shared section) ─────────────────

function SharedHoldingRow({
  item,
  maxValue,
  currency,
}: {
  item: HoldingItem;
  maxValue: number;
  currency: string;
}) {
  const delta = item.viewerValue - item.ownerValue;

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-zinc-800/50 last:border-b-0">
      <AssetIcon item={item} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2 mb-1.5">
          <div className="min-w-0">
            <span className="text-sm font-medium text-zinc-200 truncate block">
              {item.name}
            </span>
            <span className="text-[10px] text-zinc-600 uppercase">
              {item.ticker}
            </span>
          </div>
          <div className="text-right shrink-0">
            <div className="text-xs text-zinc-400">
              {delta >= 0 ? "+" : ""}
              {fmtCurrency(Math.abs(delta), currency, 0)}
              <span className="text-zinc-600">
                {delta >= 0 ? " more" : " less"}
              </span>
            </div>
          </div>
        </div>
        <DualBar
          viewerValue={item.viewerValue}
          ownerValue={item.ownerValue}
          maxValue={maxValue}
        />
        <div className="flex justify-between mt-1 text-[10px] text-zinc-600">
          <span>{fmtCurrency(item.viewerValue, currency, 0)}</span>
          <span>{fmtCurrency(item.ownerValue, currency, 0)}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Single holding row (unique section) ─────────────────

function UniqueHoldingRow({
  item,
  side,
  currency,
}: {
  item: HoldingItem;
  side: "viewer" | "owner";
  currency: string;
}) {
  const value = side === "viewer" ? item.viewerValue : item.ownerValue;

  return (
    <div className="flex items-center gap-2.5 py-2 border-b border-zinc-800/50 last:border-b-0">
      <AssetIcon item={item} size={20} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-zinc-300 truncate">{item.name}</div>
        <div className="text-[10px] text-zinc-600 uppercase">{item.ticker}</div>
      </div>
      <div className="text-sm font-medium text-zinc-400 shrink-0">
        {fmtCurrency(value, currency, 0)}
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────

export function HoldingsOverlap({
  holdings,
  viewerName,
  ownerName,
  currency,
}: HoldingsOverlapProps) {
  const shared = holdings.filter(
    (h) => h.viewerValue > 0 && h.ownerValue > 0
  );
  const viewerOnly = holdings.filter(
    (h) => h.viewerValue > 0 && h.ownerValue === 0
  );
  const ownerOnly = holdings.filter(
    (h) => h.ownerValue > 0 && h.viewerValue === 0
  );

  const totalUnique = holdings.length;
  const sharedCount = shared.length;
  const overlapPct = totalUnique > 0 ? (sharedCount / totalUnique) * 100 : 0;

  // Max value across all holdings for proportional bars
  const maxValue = Math.max(
    ...holdings.map((h) => Math.max(h.viewerValue, h.ownerValue)),
    1
  );

  if (holdings.length === 0) {
    return (
      <div className="bg-zinc-900 border border-zinc-800/50 rounded-lg p-6 text-center">
        <span className="text-sm text-zinc-600">
          No holdings data available
        </span>
      </div>
    );
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800/50 rounded-lg p-4 space-y-5">
      {/* ── Summary header ──────────────────────────────── */}
      <div>
        <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">
          Holdings Overlap
        </h2>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-zinc-300">
            {sharedCount > 0 ? (
              <>
                You share{" "}
                <span className="font-semibold text-zinc-100">
                  {sharedCount}
                </span>{" "}
                of {totalUnique} holdings with {ownerName}
              </>
            ) : (
              <>No common holdings with {ownerName}</>
            )}
          </span>
          <span className="text-xs text-zinc-600">
            {overlapPct.toFixed(0)}%
          </span>
        </div>
        {/* Overlap bar */}
        <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-blue-500 to-orange-500"
            style={{ width: `${Math.min(overlapPct, 100)}%` }}
          />
        </div>
      </div>

      {/* ── Shared holdings ─────────────────────────────── */}
      {shared.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-medium">
              Both Hold
            </span>
            <div className="flex items-center gap-3 text-[10px] text-zinc-600">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-blue-500" />
                {viewerName}
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-orange-500" />
                {ownerName}
              </span>
            </div>
          </div>
          <div>
            {shared.map((h) => (
              <SharedHoldingRow
                key={h.key}
                item={h}
                maxValue={maxValue}
                currency={currency}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Unique holdings ─────────────────────────────── */}
      {(viewerOnly.length > 0 || ownerOnly.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Viewer-only column */}
          <div>
            <div className="text-[10px] text-zinc-600 uppercase tracking-wider font-medium mb-1 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-blue-500" />
              Only {viewerName}
            </div>
            {viewerOnly.length > 0 ? (
              <div>
                {viewerOnly.map((h) => (
                  <UniqueHoldingRow
                    key={h.key}
                    item={h}
                    side="viewer"
                    currency={currency}
                  />
                ))}
              </div>
            ) : (
              <div className="text-sm text-zinc-700 py-2">—</div>
            )}
          </div>

          {/* Owner-only column */}
          <div>
            <div className="text-[10px] text-zinc-600 uppercase tracking-wider font-medium mb-1 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-orange-500" />
              Only {ownerName}
            </div>
            {ownerOnly.length > 0 ? (
              <div>
                {ownerOnly.map((h) => (
                  <UniqueHoldingRow
                    key={h.key}
                    item={h}
                    side="owner"
                    currency={currency}
                  />
                ))}
              </div>
            ) : (
              <div className="text-sm text-zinc-700 py-2">—</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
