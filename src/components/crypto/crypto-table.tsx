"use client";

import { useState } from "react";
import {
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Layers,
  Bitcoin,
} from "lucide-react";
import { AddCryptoModal } from "./add-crypto-modal";
import { PositionEditor } from "./position-editor";
import { deleteCryptoAsset } from "@/lib/actions/crypto";
import type {
  CryptoAssetWithPositions,
  CoinGeckoPriceData,
  Wallet,
} from "@/lib/types";

interface CryptoTableProps {
  assets: CryptoAssetWithPositions[];
  prices: CoinGeckoPriceData;
  wallets: Wallet[];
}

export function CryptoTable({ assets, prices, wallets }: CryptoTableProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<CryptoAssetWithPositions | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Remove ${name} from your portfolio? All positions will be deleted.`)) return;
    try {
      await deleteCryptoAsset(id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  function formatNumber(n: number, decimals = 2): string {
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(n);
  }

  function formatCurrency(n: number): string {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(n);
  }

  // Compute totals
  const rows = assets.map((asset) => {
    const price = prices[asset.coingecko_id];
    const priceUsd = price?.usd ?? 0;
    const change24h = price?.usd_24h_change ?? 0;
    const totalQty = asset.positions.reduce((sum, p) => sum + p.quantity, 0);
    const valueUsd = totalQty * priceUsd;

    return { asset, priceUsd, change24h, totalQty, valueUsd };
  });

  // Sort by value descending
  rows.sort((a, b) => b.valueUsd - a.valueUsd);

  const totalPortfolioValue = rows.reduce((sum, r) => sum + r.valueUsd, 0);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm text-zinc-400">
            {assets.length} asset{assets.length !== 1 ? "s" : ""} ·{" "}
            {formatCurrency(totalPortfolioValue)}
          </p>
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Asset
        </button>
      </div>

      {assets.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-8 text-center">
          <Bitcoin className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
          <p className="text-sm text-zinc-500">No crypto assets yet</p>
          <p className="text-xs text-zinc-600 mt-1">
            Search and add your first cryptocurrency
          </p>
        </div>
      ) : (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-4 px-4 py-2.5 text-xs font-medium text-zinc-500 uppercase tracking-wider border-b border-zinc-800/50">
            <span>Asset</span>
            <span className="text-right w-20">Price</span>
            <span className="text-right w-20">24h</span>
            <span className="text-right w-24">Holdings</span>
            <span className="text-right w-24">Value</span>
            <span className="w-20" />
          </div>

          {/* Rows */}
          {rows.map(({ asset, priceUsd, change24h, totalQty, valueUsd }) => {
            const isExpanded = expanded.has(asset.id);
            const changeColor =
              change24h > 0
                ? "text-emerald-400"
                : change24h < 0
                  ? "text-red-400"
                  : "text-zinc-500";

            return (
              <div key={asset.id}>
                {/* Main row */}
                <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-4 px-4 py-3 items-center hover:bg-zinc-800/30 transition-colors border-b border-zinc-800/30">
                  {/* Asset info */}
                  <button
                    onClick={() => toggleExpand(asset.id)}
                    className="flex items-center gap-2 text-left min-w-0"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-zinc-200 truncate block">
                        {asset.name}
                      </span>
                      <span className="text-xs text-zinc-500 uppercase">
                        {asset.ticker}
                      </span>
                    </div>
                  </button>

                  {/* Price */}
                  <span className="text-sm text-zinc-300 text-right w-20 tabular-nums">
                    {priceUsd > 0
                      ? priceUsd >= 1
                        ? formatCurrency(priceUsd)
                        : `$${priceUsd.toFixed(6)}`
                      : "—"}
                  </span>

                  {/* 24h change */}
                  <span
                    className={`text-sm text-right w-20 tabular-nums ${changeColor}`}
                  >
                    {change24h !== 0
                      ? `${change24h > 0 ? "+" : ""}${change24h.toFixed(1)}%`
                      : "—"}
                  </span>

                  {/* Total holdings */}
                  <span className="text-sm text-zinc-300 text-right w-24 tabular-nums">
                    {totalQty > 0 ? formatNumber(totalQty, 8) : "—"}
                  </span>

                  {/* Value */}
                  <span className="text-sm font-medium text-zinc-200 text-right w-24 tabular-nums">
                    {valueUsd > 0 ? formatCurrency(valueUsd) : "—"}
                  </span>

                  {/* Actions */}
                  <div className="flex items-center justify-end gap-1 w-20">
                    <button
                      onClick={() => setEditingAsset(asset)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 transition-colors"
                      title="Edit positions"
                    >
                      <Layers className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(asset.id, asset.name)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                      title="Remove asset"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Expanded: wallet breakdown */}
                {isExpanded && asset.positions.length > 0 && (
                  <div className="bg-zinc-950/50 border-b border-zinc-800/30">
                    {asset.positions.map((pos) => {
                      const posValue = pos.quantity * priceUsd;
                      return (
                        <div
                          key={pos.id}
                          className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-4 px-4 py-2 items-center pl-10"
                        >
                          <span className="text-xs text-zinc-500">
                            {pos.wallet_name}
                          </span>
                          <span className="w-20" />
                          <span className="w-20" />
                          <span className="text-xs text-zinc-400 text-right w-24 tabular-nums">
                            {formatNumber(pos.quantity, 8)}
                          </span>
                          <span className="text-xs text-zinc-400 text-right w-24 tabular-nums">
                            {posValue > 0 ? formatCurrency(posValue) : "—"}
                          </span>
                          <span className="w-20" />
                        </div>
                      );
                    })}
                  </div>
                )}

                {isExpanded && asset.positions.length === 0 && (
                  <div className="bg-zinc-950/50 border-b border-zinc-800/30 px-10 py-3">
                    <p className="text-xs text-zinc-600">
                      No positions — click the layers icon to add quantities
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Modals */}
      <AddCryptoModal open={addOpen} onClose={() => setAddOpen(false)} />
      {editingAsset && (
        <PositionEditor
          open={!!editingAsset}
          onClose={() => setEditingAsset(null)}
          asset={editingAsset}
          wallets={wallets}
        />
      )}
    </div>
  );
}
