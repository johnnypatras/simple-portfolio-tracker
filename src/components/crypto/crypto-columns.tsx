import { Layers, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import type { ColumnDef } from "@/lib/column-config";
import type { CryptoAssetWithPositions, CoinGeckoPriceData } from "@/lib/types";

// ── Computed row type (asset + price data) ───────────────────

export interface CryptoRow {
  id: string;
  asset: CryptoAssetWithPositions;
  priceUsd: number;
  priceInBase: number;
  change24h: number;
  totalQty: number;
  valueInBase: number;
}

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

export function buildCryptoRows(
  assets: CryptoAssetWithPositions[],
  prices: CoinGeckoPriceData,
  currencyKey: "usd" | "eur",
  changeKey: "usd_24h_change" | "eur_24h_change"
): CryptoRow[] {
  const rows = assets.map((asset) => {
    const price = prices[asset.coingecko_id];
    const priceUsd = price?.usd ?? 0;
    const priceInBase = price?.[currencyKey] ?? 0;
    const change24h = price?.[changeKey] ?? 0;
    const totalQty = asset.positions.reduce((sum, p) => sum + p.quantity, 0);
    const valueInBase = totalQty * priceInBase;

    return { id: asset.id, asset, priceUsd, priceInBase, change24h, totalQty, valueInBase };
  });

  // Sort by value descending
  rows.sort((a, b) => b.valueInBase - a.valueInBase);
  return rows;
}

// ── Column definitions ───────────────────────────────────────

export function getCryptoColumns(handlers: {
  onEdit: (asset: CryptoAssetWithPositions) => void;
  onDelete: (id: string, name: string) => void;
  isExpanded: (id: string) => boolean;
  toggleExpand: (id: string) => void;
}): ColumnDef<CryptoRow>[] {
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
            </span>
          </div>
        </button>
      ),
    },
    {
      key: "price",
      label: "Price (USD)",
      header: "Price (USD)",
      align: "right",
      width: "w-28",
      renderCell: (row) => (
        <span className="text-sm text-zinc-300 tabular-nums">
          {row.priceUsd > 0
            ? row.priceUsd >= 1
              ? formatCurrency(row.priceUsd, "USD")
              : `$${row.priceUsd.toFixed(6)}`
            : "—"}
        </span>
      ),
    },
    {
      key: "change24h",
      label: "24h Change",
      header: "24h",
      align: "right",
      width: "w-20",
      hiddenBelow: "md",
      renderCell: (row) => {
        const color =
          row.change24h > 0
            ? "text-emerald-400"
            : row.change24h < 0
              ? "text-red-400"
              : "text-zinc-500";
        return (
          <span className={`text-sm tabular-nums ${color}`}>
            {row.change24h !== 0
              ? `${row.change24h > 0 ? "+" : ""}${row.change24h.toFixed(1)}%`
              : "—"}
          </span>
        );
      },
    },
    {
      key: "holdings",
      label: "Holdings",
      header: "Holdings",
      align: "right",
      width: "w-32",
      renderCell: (row) => (
        <span className="text-sm text-zinc-300 tabular-nums">
          {row.totalQty > 0 ? formatNumber(row.totalQty, 8) : "—"}
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
          {row.valueInBase > 0
            ? formatCurrency(row.valueInBase, ctx.primaryCurrency)
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
