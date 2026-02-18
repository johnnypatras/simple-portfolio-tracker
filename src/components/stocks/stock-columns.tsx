import { Layers, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { convertToBase } from "@/lib/prices/fx";
import type { FXRates } from "@/lib/prices/fx";
import type { ColumnDef, RenderContext } from "@/lib/column-config";
import type {
  StockAssetWithPositions,
  AssetCategory,
  YahooStockPriceData,
} from "@/lib/types";

// ── Computed row type (asset + price data) ───────────────────

export interface StockRow {
  id: string;
  asset: StockAssetWithPositions;
  pricePerShare: number;
  change24h: number;
  totalQty: number;
  valueNative: number;
  valueBase: number;
}

// ── Category display maps ────────────────────────────────────

export const CATEGORY_LABELS: Record<AssetCategory, string> = {
  stock: "Stock",
  etf_ucits: "ETF UCITS",
  etf_non_ucits: "ETF",
  bond: "Bond",
  other: "Other",
};

export const CATEGORY_COLORS: Record<AssetCategory, string> = {
  stock: "text-blue-400",
  etf_ucits: "text-purple-400",
  etf_non_ucits: "text-emerald-400",
  bond: "text-amber-400",
  other: "text-zinc-400",
};

// ── Formatters ───────────────────────────────────────────────

export function formatNumber(n: number, decimals = 2): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

export function formatCurrency(n: number, cur: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: cur,
    minimumFractionDigits: 2,
  }).format(n);
}

// ── Build rows from assets + prices ──────────────────────────

export function buildStockRows(
  assets: StockAssetWithPositions[],
  prices: YahooStockPriceData,
  primaryCurrency: string,
  fxRates: FXRates
): StockRow[] {
  const rows = assets.map((asset) => {
    const key = asset.yahoo_ticker || asset.ticker;
    const priceData = prices[key] ?? null;
    const pricePerShare = priceData?.price ?? 0;
    const change24h = priceData?.change24h ?? 0;
    const totalQty = asset.positions.reduce((sum, p) => sum + p.quantity, 0);
    const valueNative = totalQty * pricePerShare;
    const valueBase = convertToBase(valueNative, asset.currency, primaryCurrency, fxRates);

    return { id: asset.id, asset, pricePerShare, change24h, totalQty, valueNative, valueBase };
  });

  // Sort by converted value descending
  rows.sort((a, b) => b.valueBase - a.valueBase);
  return rows;
}

// ── Column definitions ───────────────────────────────────────

export function getStockColumns(handlers: {
  onEdit: (asset: StockAssetWithPositions) => void;
  onDelete: (id: string, name: string) => void;
  isExpanded: (id: string) => boolean;
  toggleExpand: (id: string) => void;
}): ColumnDef<StockRow>[] {
  return [
    {
      key: "asset",
      label: "Asset",
      header: "Asset",
      pinned: "left",
      align: "left",
      renderCell: (row) => (
        <button
          onClick={() => handlers.toggleExpand(row.asset.id)}
          className="flex items-center gap-2 text-left min-w-0"
        >
          {handlers.isExpanded(row.asset.id) ? (
            <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
          )}
          <div className="min-w-0">
            <span className="text-sm font-medium text-zinc-200 truncate block">
              {row.asset.name}
            </span>
            <span className="text-xs text-zinc-500 uppercase">
              {row.asset.ticker}
              {row.asset.isin && (
                <span className="text-zinc-600 ml-1.5 normal-case">
                  {row.asset.isin}
                </span>
              )}
            </span>
          </div>
        </button>
      ),
    },
    {
      key: "type",
      label: "Type",
      header: "Type",
      align: "left",
      width: "w-24",
      hiddenBelow: "md",
      renderCell: (row) => (
        <span className={`text-xs font-medium ${CATEGORY_COLORS[row.asset.category]}`}>
          {CATEGORY_LABELS[row.asset.category]}
        </span>
      ),
    },
    {
      key: "price",
      label: "Price",
      header: "Price",
      align: "right",
      width: "w-32",
      renderCell: (row) =>
        row.pricePerShare > 0 ? (
          <div>
            <span className="text-sm tabular-nums text-zinc-300">
              {formatCurrency(row.pricePerShare, row.asset.currency)}
            </span>
            <span
              className={`block text-xs tabular-nums ${
                row.change24h >= 0 ? "text-emerald-400" : "text-red-400"
              }`}
            >
              {row.change24h >= 0 ? "+" : ""}
              {row.change24h.toFixed(2)}%
            </span>
          </div>
        ) : (
          <span className="text-xs text-zinc-600">No data</span>
        ),
    },
    {
      key: "shares",
      label: "Shares",
      header: "Shares",
      align: "right",
      width: "w-24",
      renderCell: (row) => (
        <span className="text-sm text-zinc-300 tabular-nums">
          {row.totalQty > 0 ? formatNumber(row.totalQty, 4) : "—"}
        </span>
      ),
    },
    {
      key: "value",
      label: "Value",
      header: "Value",
      align: "right",
      width: "w-28",
      renderHeader: (ctx) =>
        `Value (${ctx.primaryCurrency})`,
      renderCell: (row, ctx) => (
        <span className="text-sm font-medium text-zinc-200 tabular-nums">
          {row.valueBase > 0
            ? formatCurrency(row.valueBase, ctx.primaryCurrency)
            : "—"}
        </span>
      ),
    },
    {
      key: "actions",
      label: "Actions",
      header: "",
      pinned: "right",
      align: "right",
      width: "w-20",
      renderCell: (row) => (
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={() => handlers.onEdit(row.asset)}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 transition-colors"
            title="Edit positions"
          >
            <Layers className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => handlers.onDelete(row.asset.id, row.asset.name)}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
            title="Remove asset"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ),
    },
  ];
}
