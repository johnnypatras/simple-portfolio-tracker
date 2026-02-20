import { Pencil, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { convertToBase } from "@/lib/prices/fx";
import type { FXRates } from "@/lib/prices/fx";
import type { ColumnDef } from "@/lib/column-config";
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

// ── Rotating palette for dynamic groups (brokers) ───────────

export const GROUP_PALETTE = [
  "text-blue-400",
  "text-purple-400",
  "text-amber-400",
  "text-emerald-400",
  "text-sky-400",
  "text-rose-400",
  "text-teal-400",
  "text-orange-400",
];

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

// ── Group type for group-by-category mode ────────────────────

export interface StockGroup {
  category: AssetCategory;
  label: string;
  color: string;
  rows: StockRow[];
  totalValue: number;
  assetCount: number;
}

export function buildStockGroupRows(rows: StockRow[]): StockGroup[] {
  const groupMap = new Map<AssetCategory, StockRow[]>();

  for (const row of rows) {
    const cat = row.asset.category;
    const existing = groupMap.get(cat) ?? [];
    existing.push(row);
    groupMap.set(cat, existing);
  }

  const groups: StockGroup[] = [];
  for (const [cat, groupRows] of groupMap) {
    const totalValue = groupRows.reduce((sum, r) => sum + r.valueBase, 0);
    groups.push({
      category: cat,
      label: CATEGORY_LABELS[cat],
      color: CATEGORY_COLORS[cat],
      rows: groupRows.sort((a, b) => b.valueBase - a.valueBase),
      totalValue,
      assetCount: groupRows.length,
    });
  }

  // Sort groups by total value descending
  groups.sort((a, b) => b.totalValue - a.totalValue);
  return groups;
}

// ── Position-level group for group-by-broker mode ────────────

/** One asset's positions at a specific broker within a group */
export interface StockBrokerEntry {
  row: StockRow;
  positions: StockAssetWithPositions["positions"];
  groupQty: number;
  groupValue: number;
}

/** A group of entries for one broker */
export interface StockBrokerGroup {
  brokerName: string;
  entries: StockBrokerEntry[];
  totalValue: number;
  entryCount: number;
}

/**
 * Build position-level groups by broker: each asset's positions are split by broker_name,
 * so an asset with positions at two brokers appears in both broker groups.
 */
export function buildStockBrokerGroups(rows: StockRow[]): StockBrokerGroup[] {
  const groupMap = new Map<string, StockBrokerEntry[]>();

  for (const row of rows) {
    // Split this asset's positions by broker
    const byBroker = new Map<string, StockAssetWithPositions["positions"]>();
    for (const pos of row.asset.positions) {
      const broker = pos.broker_name ?? "Unknown";
      const arr = byBroker.get(broker) ?? [];
      arr.push(pos);
      byBroker.set(broker, arr);
    }

    // Create one entry per (asset, broker) pair
    for (const [broker, positions] of byBroker) {
      const groupQty = positions.reduce((sum, p) => sum + p.quantity, 0);
      // Value proportional to the asset's total base value
      const groupValue = row.totalQty > 0
        ? row.valueBase * (groupQty / row.totalQty)
        : 0;

      const entry: StockBrokerEntry = { row, positions, groupQty, groupValue };
      const existing = groupMap.get(broker) ?? [];
      existing.push(entry);
      groupMap.set(broker, existing);
    }
  }

  const groups: StockBrokerGroup[] = [];
  for (const [brokerName, entries] of groupMap) {
    const totalValue = entries.reduce((sum, e) => sum + e.groupValue, 0);
    groups.push({
      brokerName,
      entries: entries.sort((a, b) => b.groupValue - a.groupValue),
      totalValue,
      entryCount: entries.length,
    });
  }

  groups.sort((a, b) => b.totalValue - a.totalValue);
  return groups;
}

// ── Ticker group for multi-exchange listings ─────────────────

/** Group of assets sharing the same display ticker (e.g. VWCE.DE + VWCE.AS) */
export interface TickerGroup {
  ticker: string;
  name: string;
  category: AssetCategory;
  rows: StockRow[];
  totalValueBase: number;
  weightedChange24h: number;
}

/**
 * Groups stock rows by display ticker. Tickers with 2+ assets become
 * TickerGroups; single-variant tickers remain as plain StockRows.
 */
export function buildTickerGroups(
  rows: StockRow[]
): { groups: TickerGroup[]; singles: StockRow[] } {
  const tickerMap = new Map<string, StockRow[]>();

  for (const row of rows) {
    const t = row.asset.ticker;
    const arr = tickerMap.get(t) ?? [];
    arr.push(row);
    tickerMap.set(t, arr);
  }

  const groups: TickerGroup[] = [];
  const singles: StockRow[] = [];

  for (const [ticker, tickerRows] of tickerMap) {
    if (tickerRows.length < 2) {
      singles.push(tickerRows[0]);
      continue;
    }

    // Sort variants by value descending
    tickerRows.sort((a, b) => b.valueBase - a.valueBase);

    const totalValueBase = tickerRows.reduce((sum, r) => sum + r.valueBase, 0);
    const weightedChange24h =
      totalValueBase > 0
        ? tickerRows.reduce((sum, r) => sum + r.valueBase * r.change24h, 0) /
          totalValueBase
        : 0;

    // Use largest variant as representative
    const primary = tickerRows[0];

    groups.push({
      ticker,
      name: primary.asset.name,
      category: primary.asset.category,
      rows: tickerRows,
      totalValueBase,
      weightedChange24h,
    });
  }

  // Sort groups by total value descending
  groups.sort((a, b) => b.totalValueBase - a.totalValueBase);
  return { groups, singles };
}

// ── Sorting ───────────────────────────────────────────────────

export type SortKey = "value" | "name" | "type" | "change" | "currency";
export type SortDirection = "asc" | "desc";

export const DEFAULT_SORT_KEY: SortKey = "value";
export const DEFAULT_SORT_DIR: SortDirection = "desc";

export const SORT_OPTIONS: { key: SortKey; label: string; defaultDir: SortDirection }[] = [
  { key: "value", label: "Value", defaultDir: "desc" },
  { key: "name", label: "Name", defaultDir: "asc" },
  { key: "type", label: "Type", defaultDir: "asc" },
  { key: "change", label: "24h %", defaultDir: "desc" },
  { key: "currency", label: "Currency", defaultDir: "asc" },
];

/** Maps column keys to sort keys (for clickable desktop headers) */
export const COLUMN_TO_SORT: Record<string, SortKey | undefined> = {
  asset: "name",
  type: "type",
  currency: "currency",
  price: "change",
  value: "value",
};

/** Union type for flat-mode items (single row or ticker group) */
export type FlatItem =
  | { kind: "single"; row: StockRow; value: number }
  | { kind: "ticker-group"; group: TickerGroup; value: number };

/** Extract a comparable sort value from a FlatItem */
function flatItemSortVal(item: FlatItem, key: SortKey): string | number {
  if (item.kind === "single") {
    const { row } = item;
    switch (key) {
      case "value": return row.valueBase;
      case "name": return row.asset.name.toLowerCase();
      case "type": return CATEGORY_LABELS[row.asset.category];
      case "change": return row.change24h;
      case "currency": return row.asset.currency;
    }
  } else {
    const { group } = item;
    switch (key) {
      case "value": return group.totalValueBase;
      case "name": return group.name.toLowerCase();
      case "type": return CATEGORY_LABELS[group.category];
      case "change": return group.weightedChange24h;
      case "currency": return group.rows[0]?.asset.currency ?? "";
    }
  }
}

/** Sort flat-mode items by the given key and direction */
export function sortFlatItems(
  items: FlatItem[],
  key: SortKey,
  dir: SortDirection
): FlatItem[] {
  return [...items].sort((a, b) => {
    const av = flatItemSortVal(a, key);
    const bv = flatItemSortVal(b, key);
    if (av < bv) return dir === "asc" ? -1 : 1;
    if (av > bv) return dir === "asc" ? 1 : -1;
    return 0;
  });
}

/** Sort StockRows by key (used within groups) */
export function sortRows(
  rows: StockRow[],
  key: SortKey,
  dir: SortDirection
): StockRow[] {
  return [...rows].sort((a, b) => {
    let av: string | number, bv: string | number;
    switch (key) {
      case "value": av = a.valueBase; bv = b.valueBase; break;
      case "name": av = a.asset.name.toLowerCase(); bv = b.asset.name.toLowerCase(); break;
      case "type": av = CATEGORY_LABELS[a.asset.category]; bv = CATEGORY_LABELS[b.asset.category]; break;
      case "change": av = a.change24h; bv = b.change24h; break;
      case "currency": av = a.asset.currency; bv = b.asset.currency; break;
    }
    if (av < bv) return dir === "asc" ? -1 : 1;
    if (av > bv) return dir === "asc" ? 1 : -1;
    return 0;
  });
}

// ── Currency group for group-by-currency mode ─────────────────

/** Currency color map — covers common currencies, falls back to zinc */
export const CURRENCY_COLORS: Record<string, string> = {
  EUR: "text-blue-400",
  USD: "text-emerald-400",
  GBP: "text-amber-400",
  CHF: "text-red-400",
  JPY: "text-rose-400",
  CAD: "text-orange-400",
  AUD: "text-teal-400",
  SEK: "text-sky-400",
  NOK: "text-indigo-400",
  DKK: "text-violet-400",
};

export function getCurrencyColor(currency: string): string {
  return CURRENCY_COLORS[currency] ?? "text-zinc-400";
}

export interface StockCurrencyGroup {
  currency: string;
  rows: StockRow[];
  totalValue: number;
  assetCount: number;
}

/**
 * Groups stock rows by their native currency. Each listing is treated
 * individually (no ticker grouping), so VWCE.DE (EUR) and VWCE (USD)
 * end up in separate currency groups.
 */
export function buildStockCurrencyGroups(rows: StockRow[]): StockCurrencyGroup[] {
  const groupMap = new Map<string, StockRow[]>();

  for (const row of rows) {
    const cur = row.asset.currency;
    const existing = groupMap.get(cur) ?? [];
    existing.push(row);
    groupMap.set(cur, existing);
  }

  const groups: StockCurrencyGroup[] = [];
  for (const [currency, groupRows] of groupMap) {
    const totalValue = groupRows.reduce((sum, r) => sum + r.valueBase, 0);
    groups.push({
      currency,
      rows: groupRows.sort((a, b) => b.valueBase - a.valueBase),
      totalValue,
      assetCount: groupRows.length,
    });
  }

  groups.sort((a, b) => b.totalValue - a.totalValue);
  return groups;
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
      key: "currency",
      label: "Currency",
      header: "Currency",
      align: "left",
      width: "w-16",
      hiddenBelow: "sm",
      renderCell: (row) => (
        <span className="text-xs text-zinc-400">
          {row.asset.currency}
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
            <Pencil className="w-3.5 h-3.5" />
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
