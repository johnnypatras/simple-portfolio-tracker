"use client";

import { useState, Fragment } from "react";
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
  const [editingAsset, setEditingAsset] =
    useState<CryptoAssetWithPositions | null>(null);
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
    if (
      !confirm(
        `Remove ${name} from your portfolio? All positions will be deleted.`
      )
    )
      return;
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
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800/50">
                <th className="text-left text-xs font-medium text-zinc-500 uppercase tracking-wider px-4 py-2.5">
                  Asset
                </th>
                <th className="text-right text-xs font-medium text-zinc-500 uppercase tracking-wider px-4 py-2.5 w-28">
                  Price
                </th>
                <th className="text-right text-xs font-medium text-zinc-500 uppercase tracking-wider px-4 py-2.5 w-20">
                  24h
                </th>
                <th className="text-right text-xs font-medium text-zinc-500 uppercase tracking-wider px-4 py-2.5 w-32">
                  Holdings
                </th>
                <th className="text-right text-xs font-medium text-zinc-500 uppercase tracking-wider px-4 py-2.5 w-28">
                  Value
                </th>
                <th className="w-20 px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map(
                ({ asset, priceUsd, change24h, totalQty, valueUsd }) => {
                  const isExpanded = expanded.has(asset.id);
                  const changeColor =
                    change24h > 0
                      ? "text-emerald-400"
                      : change24h < 0
                        ? "text-red-400"
                        : "text-zinc-500";

                  return (
                    <Fragment key={asset.id}>
                      {/* Main row */}
                      <tr
                        className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors"
                      >
                        <td className="px-4 py-3">
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
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="text-sm text-zinc-300 tabular-nums">
                            {priceUsd > 0
                              ? priceUsd >= 1
                                ? formatCurrency(priceUsd)
                                : `$${priceUsd.toFixed(6)}`
                              : "—"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span
                            className={`text-sm tabular-nums ${changeColor}`}
                          >
                            {change24h !== 0
                              ? `${change24h > 0 ? "+" : ""}${change24h.toFixed(1)}%`
                              : "—"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="text-sm text-zinc-300 tabular-nums">
                            {totalQty > 0 ? formatNumber(totalQty, 8) : "—"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="text-sm font-medium text-zinc-200 tabular-nums">
                            {valueUsd > 0 ? formatCurrency(valueUsd) : "—"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => setEditingAsset(asset)}
                              className="p-1.5 rounded-lg text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 transition-colors"
                              title="Edit positions"
                            >
                              <Layers className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() =>
                                handleDelete(asset.id, asset.name)
                              }
                              className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                              title="Remove asset"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Expanded: wallet breakdown */}
                      {isExpanded &&
                        asset.positions.length > 0 &&
                        asset.positions.map((pos) => {
                          const posValue = pos.quantity * priceUsd;
                          return (
                            <tr
                              key={pos.id}
                              className="bg-zinc-950/50 border-b border-zinc-800/20"
                            >
                              <td className="pl-10 pr-4 py-2">
                                <span className="text-xs text-zinc-500">
                                  {pos.wallet_name}
                                </span>
                              </td>
                              <td />
                              <td />
                              <td className="px-4 py-2 text-right">
                                <span className="text-xs text-zinc-400 tabular-nums">
                                  {formatNumber(pos.quantity, 8)}
                                </span>
                              </td>
                              <td className="px-4 py-2 text-right">
                                <span className="text-xs text-zinc-400 tabular-nums">
                                  {posValue > 0
                                    ? formatCurrency(posValue)
                                    : "—"}
                                </span>
                              </td>
                              <td />
                            </tr>
                          );
                        })}

                      {isExpanded && asset.positions.length === 0 && (
                        <tr
                          key={`${asset.id}-empty`}
                          className="bg-zinc-950/50 border-b border-zinc-800/20"
                        >
                          <td colSpan={6} className="pl-10 pr-4 py-3">
                            <p className="text-xs text-zinc-600">
                              No positions — click the layers icon to add
                              quantities
                            </p>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                }
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Modals */}
      <AddCryptoModal open={addOpen} onClose={() => setAddOpen(false)} wallets={wallets} />
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
