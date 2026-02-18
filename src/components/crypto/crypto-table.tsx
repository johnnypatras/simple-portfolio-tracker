"use client";

import { useState, useMemo, useCallback, Fragment } from "react";
import { Plus, Bitcoin } from "lucide-react";
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
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
          <table className="w-full">
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
                    {/* Main row */}
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

                    {/* Expanded: wallet breakdown */}
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

                    {/* Expanded: empty positions */}
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
