"use client";

import { useState, useMemo, useCallback, Fragment } from "react";
import { Plus, Bitcoin, Layers, Trash2, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { AddCryptoModal } from "./add-crypto-modal";
import { PositionEditor } from "./position-editor";
import { ColumnSettingsPopover } from "@/components/ui/column-settings-popover";
import { useColumnConfig } from "@/lib/hooks/use-column-config";
import { deleteCryptoAsset } from "@/lib/actions/crypto";
import type { RenderContext, ColumnDef } from "@/lib/column-config";
import type {
  CryptoAssetWithPositions,
  CoinGeckoPriceData,
  Wallet,
} from "@/lib/types";
import {
  getCryptoColumns,
  buildCryptoRows,
  formatNumber,
  formatCurrency,
  type CryptoRow,
} from "./crypto-columns";

// ── Breakpoint → Tailwind class mapping ──────────────────────

const HIDDEN_BELOW: Record<string, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};

// ── Component ────────────────────────────────────────────────

interface CryptoTableProps {
  assets: CryptoAssetWithPositions[];
  prices: CoinGeckoPriceData;
  wallets: Wallet[];
  primaryCurrency: string;
}

export function CryptoTable({ assets, prices, wallets, primaryCurrency }: CryptoTableProps) {
  const currencyKey = primaryCurrency.toLowerCase() as "usd" | "eur";
  const changeKey = `${currencyKey}_24h_change` as "usd_24h_change" | "eur_24h_change";

  const [addOpen, setAddOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<CryptoAssetWithPositions | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const isExpanded = useCallback((id: string) => expanded.has(id), [expanded]);

  const handleEdit = useCallback((asset: CryptoAssetWithPositions) => {
    setEditingAsset(asset);
  }, []);

  const handleDelete = useCallback(async (id: string, name: string) => {
    if (!confirm(`Remove ${name} from your portfolio? All positions will be deleted.`)) return;
    try {
      await deleteCryptoAsset(id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete");
    }
  }, []);

  // Build computed rows
  const rows = useMemo(
    () => buildCryptoRows(assets, prices, currencyKey, changeKey),
    [assets, prices, currencyKey, changeKey]
  );

  const totalPortfolioValue = useMemo(
    () => rows.reduce((sum, r) => sum + r.valueInBase, 0),
    [rows]
  );

  const allExpanded = rows.length > 0 && rows.every((r) => expanded.has(r.id));

  const toggleExpandAll = useCallback(() => {
    setExpanded((prev) => {
      if (rows.every((r) => prev.has(r.id))) return new Set();
      return new Set(rows.map((r) => r.id));
    });
  }, [rows]);

  // Column definitions (stable via useMemo)
  const columns = useMemo(
    () => getCryptoColumns({ onEdit: handleEdit, onDelete: handleDelete, isExpanded, toggleExpand }),
    [handleEdit, handleDelete, isExpanded, toggleExpand]
  );

  const {
    orderedColumns,
    configurableColumns,
    toggleColumn,
    moveColumn,
    resetToDefaults,
  } = useColumnConfig("colConfig:crypto", columns, 1);

  const ctx: RenderContext = { primaryCurrency, fxRates: {} };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm text-zinc-400">
            {assets.length} asset{assets.length !== 1 ? "s" : ""} ·{" "}
            {formatCurrency(totalPortfolioValue, primaryCurrency)}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {assets.length > 0 && (
            <button
              onClick={toggleExpandAll}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
              title={allExpanded ? "Collapse all" : "Expand all"}
            >
              {allExpanded ? (
                <ChevronsDownUp className="w-4 h-4" />
              ) : (
                <ChevronsUpDown className="w-4 h-4" />
              )}
            </button>
          )}
          <ColumnSettingsPopover
            columns={configurableColumns}
            onToggle={toggleColumn}
            onMove={moveColumn}
            onReset={resetToDefaults}
          />
          <button
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Asset
          </button>
        </div>
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
        <>
          {/* ── Mobile card layout ── */}
          <div className="space-y-2 md:hidden">
            {rows.map((row) => {
              const rowExpanded = expanded.has(row.asset.id);
              return (
                <div key={row.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
                  <button
                    onClick={() => toggleExpand(row.asset.id)}
                    className="w-full px-4 py-3 flex items-center justify-between overflow-hidden"
                  >
                    <div className="text-left min-w-0">
                      <p className="text-sm font-medium text-zinc-200 truncate">
                        {row.asset.name}
                      </p>
                      <p className="text-xs text-zinc-500 uppercase">{row.asset.ticker}</p>
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      <p className="text-sm font-medium text-zinc-200 tabular-nums">
                        {row.valueInBase > 0 ? formatCurrency(row.valueInBase, primaryCurrency) : "—"}
                      </p>
                      {row.change24h !== 0 && (
                        <p className={`text-xs tabular-nums ${row.change24h >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {row.change24h >= 0 ? "+" : ""}{row.change24h.toFixed(2)}%
                        </p>
                      )}
                    </div>
                  </button>

                  {rowExpanded && (
                    <div className="px-4 pb-3 pt-0 border-t border-zinc-800/30">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-2 pt-3 text-xs">
                        <div>
                          <span className="text-zinc-500">Price (USD)</span>
                          <p className="text-zinc-300 tabular-nums">
                            {row.priceUsd > 0 ? formatCurrency(row.priceUsd, "USD") : "No data"}
                          </p>
                          {primaryCurrency.toUpperCase() !== "USD" && row.priceInBase > 0 && (
                            <p className="text-zinc-500 tabular-nums mt-0.5">
                              {formatCurrency(row.priceInBase, primaryCurrency)}
                            </p>
                          )}
                        </div>
                        <div>
                          <span className="text-zinc-500">Holdings</span>
                          <p className="text-zinc-300 tabular-nums">
                            {row.totalQty > 0 ? formatNumber(row.totalQty, 8) : "—"}
                          </p>
                        </div>
                      </div>

                      {row.asset.positions.length > 0 && (
                        <div className="mt-3 pt-2 border-t border-zinc-800/20 space-y-1">
                          {row.asset.positions.map((pos) => {
                            const posValue = pos.quantity * row.priceInBase;
                            return (
                              <div key={pos.id} className="flex justify-between text-xs">
                                <span className="text-zinc-500">{pos.wallet_name}</span>
                                <span className="text-zinc-400 tabular-nums">
                                  {formatNumber(pos.quantity, 8)} · {posValue > 0 ? formatCurrency(posValue, primaryCurrency) : "—"}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <div className="flex gap-2 mt-3 pt-2 border-t border-zinc-800/20">
                        <button
                          onClick={() => handleEdit(row.asset)}
                          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg text-zinc-400 hover:text-blue-400 hover:bg-zinc-800 transition-colors"
                        >
                          <Layers className="w-3 h-3" />
                          Edit positions
                        </button>
                        <button
                          onClick={() => handleDelete(row.asset.id, row.asset.name)}
                          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                        >
                          <Trash2 className="w-3 h-3" />
                          Remove
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── Desktop table layout ── */}
          <div className="hidden md:block bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-x-auto">
            <table className="w-full min-w-[600px]">
              <thead>
                <tr className="border-b border-zinc-800/50">
                  {orderedColumns.map((col) => {
                    const align = col.align === "right" ? "text-right" : "text-left";
                    const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";
                    const width = col.width ?? "";
                    return (
                      <th
                        key={col.key}
                        className={`px-4 py-2.5 text-xs font-medium text-zinc-500 uppercase tracking-wider ${align} ${hidden} ${width}`}
                      >
                        {col.renderHeader ? col.renderHeader(ctx) : col.header}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const rowExpanded = expanded.has(row.asset.id);
                  return (
                    <Fragment key={row.id}>
                      <tr className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors">
                        {orderedColumns.map((col) => {
                          const align = col.align === "right" ? "text-right" : "text-left";
                          const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";
                          return (
                            <td key={col.key} className={`px-4 py-3 ${align} ${hidden}`}>
                              {col.renderCell(row, ctx)}
                            </td>
                          );
                        })}
                      </tr>

                      {rowExpanded && row.asset.positions.length > 0 &&
                        row.asset.positions.map((pos) => {
                          const posValue = pos.quantity * row.priceInBase;
                          return (
                            <ExpandedCryptoRow
                              key={pos.id}
                              walletName={pos.wallet_name}
                              quantity={formatNumber(pos.quantity, 8)}
                              value={posValue > 0 ? formatCurrency(posValue, primaryCurrency) : "—"}
                              orderedColumns={orderedColumns}
                            />
                          );
                        })}

                      {rowExpanded && row.asset.positions.length === 0 && (
                        <tr className="bg-zinc-950/50 border-b border-zinc-800/20">
                          <td colSpan={orderedColumns.length} className="pl-10 pr-4 py-3">
                            <p className="text-xs text-zinc-600">
                              No positions — click the layers icon to add quantities
                            </p>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
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

// ── Expanded sub-row ─────────────────────────────────────────
// Renders wallet name under the Asset column, quantity under Holdings,
// value under Value, and empty cells for everything else.

function ExpandedCryptoRow({
  walletName,
  quantity,
  value,
  orderedColumns,
}: {
  walletName: string;
  quantity: string;
  value: string;
  orderedColumns: ColumnDef<CryptoRow>[];
}) {
  return (
    <tr className="bg-zinc-950/50 border-b border-zinc-800/20">
      {orderedColumns.map((col) => {
        const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";

        if (col.key === "asset") {
          return (
            <td key={col.key} className="pl-10 pr-4 py-2">
              <span className="text-xs text-zinc-500">{walletName}</span>
            </td>
          );
        }
        if (col.key === "holdings") {
          return (
            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
              <span className="text-xs text-zinc-400 tabular-nums">{quantity}</span>
            </td>
          );
        }
        if (col.key === "value") {
          return (
            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
              <span className="text-xs text-zinc-400 tabular-nums">{value}</span>
            </td>
          );
        }
        // Empty cell for all other columns
        return <td key={col.key} className={hidden} />;
      })}
    </tr>
  );
}
