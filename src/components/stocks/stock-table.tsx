"use client";

import { useState, useMemo, useCallback, Fragment } from "react";
import { Plus, TrendingUp, Pencil, Trash2, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { AddStockModal } from "./add-stock-modal";
import { StockPositionEditor } from "./stock-position-editor";
import { ColumnSettingsPopover } from "@/components/ui/column-settings-popover";
import { useColumnConfig } from "@/lib/hooks/use-column-config";
import { convertToBase } from "@/lib/prices/fx";
import { deleteStockAsset } from "@/lib/actions/stocks";
import type { FXRates } from "@/lib/prices/fx";
import type { RenderContext, ColumnDef } from "@/lib/column-config";
import type {
  StockAssetWithPositions,
  Broker,
  YahooStockPriceData,
} from "@/lib/types";
import {
  getStockColumns,
  buildStockRows,
  formatNumber,
  formatCurrency,
  CATEGORY_LABELS,
  CATEGORY_COLORS,
  type StockRow,
} from "./stock-columns";

// ── Breakpoint → Tailwind class mapping ──────────────────────

const HIDDEN_BELOW: Record<string, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};

// ── Component ────────────────────────────────────────────────

interface StockTableProps {
  assets: StockAssetWithPositions[];
  brokers: Broker[];
  prices: YahooStockPriceData;
  primaryCurrency: string;
  fxRates: FXRates;
}

export function StockTable({ assets, brokers, prices, primaryCurrency, fxRates }: StockTableProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<StockAssetWithPositions | null>(null);
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

  const handleEdit = useCallback((asset: StockAssetWithPositions) => {
    setEditingAsset(asset);
  }, []);

  const handleDelete = useCallback(async (id: string, name: string) => {
    if (!confirm(`Remove ${name} from your portfolio? All positions will be deleted.`)) return;
    try {
      await deleteStockAsset(id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete");
    }
  }, []);

  // Build computed rows
  const rows = useMemo(
    () => buildStockRows(assets, prices, primaryCurrency, fxRates),
    [assets, prices, primaryCurrency, fxRates]
  );

  const totalPortfolioValue = useMemo(
    () => rows.reduce((sum, r) => sum + r.valueBase, 0),
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
    () => getStockColumns({ onEdit: handleEdit, onDelete: handleDelete, isExpanded, toggleExpand }),
    [handleEdit, handleDelete, isExpanded, toggleExpand]
  );

  const {
    orderedColumns,
    configurableColumns,
    toggleColumn,
    moveColumn,
    resetToDefaults,
  } = useColumnConfig("colConfig:stocks", columns, 1);

  const ctx: RenderContext = { primaryCurrency, fxRates };

  const totalPositions = useMemo(
    () => assets.reduce((sum, a) => sum + a.positions.length, 0),
    [assets]
  );

  return (
    <div>
      {/* ── Summary header ─────────────────────────────────── */}
      <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
              Total Equities
            </p>
            <p className="text-2xl font-semibold text-zinc-100 mt-1 tabular-nums">
              {formatCurrency(totalPortfolioValue, primaryCurrency)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right text-xs text-zinc-500 space-y-0.5">
              <p>
                {assets.length} asset{assets.length !== 1 ? "s" : ""}
              </p>
              <p>
                {totalPositions} position{totalPositions !== 1 ? "s" : ""}
              </p>
            </div>
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
          </div>
        </div>
      </div>

      {/* ── Action bar ───────────────────────────────────── */}
      <div className="flex items-center justify-end mt-2 mb-3">
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
          <TrendingUp className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
          <p className="text-sm text-zinc-500">No stocks or ETFs yet</p>
          <p className="text-xs text-zinc-600 mt-1">
            Add your first stock or ETF to get started
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
                  {/* Card header — tap to expand */}
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
                        {row.valueBase > 0 ? formatCurrency(row.valueBase, primaryCurrency) : "—"}
                      </p>
                      {row.change24h !== 0 && (
                        <p className={`text-xs tabular-nums ${row.change24h >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {row.change24h >= 0 ? "+" : ""}{row.change24h.toFixed(2)}%
                        </p>
                      )}
                    </div>
                  </button>

                  {/* Expanded details */}
                  {rowExpanded && (
                    <div className="px-4 pb-3 pt-0 border-t border-zinc-800/30">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-2 pt-3 text-xs">
                        <div>
                          <span className="text-zinc-500">Price</span>
                          <p className="text-zinc-300 tabular-nums">
                            {row.pricePerShare > 0 ? formatCurrency(row.pricePerShare, row.asset.currency) : "No data"}
                          </p>
                        </div>
                        <div>
                          <span className="text-zinc-500">Shares</span>
                          <p className="text-zinc-300 tabular-nums">
                            {row.totalQty > 0 ? formatNumber(row.totalQty, 4) : "—"}
                          </p>
                        </div>
                        <div>
                          <span className="text-zinc-500">Type</span>
                          <p className={CATEGORY_COLORS[row.asset.category]}>
                            {CATEGORY_LABELS[row.asset.category]}
                          </p>
                        </div>
                        <div>
                          <span className="text-zinc-500">Value ({primaryCurrency})</span>
                          <p className="text-zinc-300 tabular-nums">
                            {row.valueBase > 0 ? formatCurrency(row.valueBase, primaryCurrency) : "—"}
                          </p>
                        </div>
                      </div>

                      {/* Broker breakdown */}
                      {row.asset.positions.length > 0 && (
                        <div className="mt-3 pt-2 border-t border-zinc-800/20 space-y-1">
                          {row.asset.positions.map((pos) => {
                            const posValueNative = pos.quantity * row.pricePerShare;
                            const posValueBase = convertToBase(posValueNative, row.asset.currency, primaryCurrency, fxRates);
                            return (
                              <div key={pos.id} className="flex justify-between text-xs">
                                <span className="text-zinc-500">{pos.broker_name}</span>
                                <span className="text-zinc-400 tabular-nums">
                                  {formatNumber(pos.quantity, 4)} · {posValueBase > 0 ? formatCurrency(posValueBase, primaryCurrency) : "—"}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Action buttons */}
                      <div className="flex gap-2 mt-3 pt-2 border-t border-zinc-800/20">
                        <button
                          onClick={() => handleEdit(row.asset)}
                          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg text-zinc-400 hover:text-blue-400 hover:bg-zinc-800 transition-colors"
                        >
                          <Pencil className="w-3 h-3" />
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
                          const posValueNative = pos.quantity * row.pricePerShare;
                          const posValueBase = convertToBase(posValueNative, row.asset.currency, primaryCurrency, fxRates);
                          return (
                            <ExpandedStockRow
                              key={pos.id}
                              brokerName={pos.broker_name}
                              quantity={formatNumber(pos.quantity, 4)}
                              value={posValueBase > 0 ? formatCurrency(posValueBase, primaryCurrency) : "—"}
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
      <AddStockModal open={addOpen} onClose={() => setAddOpen(false)} brokers={brokers} />
      {editingAsset && (
        <StockPositionEditor
          open={!!editingAsset}
          onClose={() => setEditingAsset(null)}
          asset={editingAsset}
          brokers={brokers}
        />
      )}
    </div>
  );
}

// ── Expanded sub-row ─────────────────────────────────────────
// Renders broker name under the Asset column, quantity under Shares,
// value under Value, and empty cells for everything else.

function ExpandedStockRow({
  brokerName,
  quantity,
  value,
  orderedColumns,
}: {
  brokerName: string;
  quantity: string;
  value: string;
  orderedColumns: ColumnDef<StockRow>[];
}) {
  return (
    <tr className="bg-zinc-950/50 border-b border-zinc-800/20">
      {orderedColumns.map((col) => {
        const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";

        if (col.key === "asset") {
          return (
            <td key={col.key} className="pl-10 pr-4 py-2">
              <span className="text-xs text-zinc-500">{brokerName}</span>
            </td>
          );
        }
        if (col.key === "shares") {
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
        return <td key={col.key} className={hidden} />;
      })}
    </tr>
  );
}
