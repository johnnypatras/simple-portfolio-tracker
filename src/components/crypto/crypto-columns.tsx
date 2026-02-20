import { Pencil, Trash2, ChevronDown, ChevronRight } from "lucide-react";
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

// ── Acquisition type display maps ───────────────────────────

export const ACQUISITION_LABELS: Record<string, string> = {
  bought: "Bought",
  mined: "Mined",
  staked: "Staked",
  airdrop: "Airdrop",
  other: "Other",
};

export const ACQUISITION_COLORS: Record<string, string> = {
  bought: "text-blue-400",
  mined: "text-amber-400",
  staked: "text-purple-400",
  airdrop: "text-emerald-400",
  other: "text-zinc-400",
};

// ── Rotating palette for dynamic groups (wallets, brokers) ──

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

// ── Position-level group types for group-by-source mode ─────

/** One asset's positions sharing the same acquisition method within a group */
export interface PositionGroupEntry {
  row: CryptoRow;
  positions: CryptoAssetWithPositions["positions"];
  groupQty: number;
  groupValue: number;
}

/** A group of entries for one acquisition method */
export interface CryptoPositionGroup {
  acquisitionMethod: string;
  label: string;
  entries: PositionGroupEntry[];
  totalValue: number;
  entryCount: number;
}

/** Get the dominant acquisition method for an asset's positions (used by source column in flat mode) */
function getDominantMethod(positions: { acquisition_method?: string }[]): string {
  const methods = positions.map((p) => p.acquisition_method ?? "bought");
  const unique = [...new Set(methods)];
  if (unique.length === 0) return "bought";
  if (unique.length === 1) return unique[0];
  return "mixed";
}

/**
 * Build position-level groups: each asset's positions are split by acquisition_method,
 * so an asset with bought + mined positions appears in both the "Bought" and "Mined" groups.
 */
export function buildCryptoPositionGroups(rows: CryptoRow[]): CryptoPositionGroup[] {
  const groupMap = new Map<string, PositionGroupEntry[]>();

  for (const row of rows) {
    // Split this asset's positions by method
    const byMethod = new Map<string, CryptoAssetWithPositions["positions"]>();
    for (const pos of row.asset.positions) {
      const method = pos.acquisition_method ?? "bought";
      const arr = byMethod.get(method) ?? [];
      arr.push(pos);
      byMethod.set(method, arr);
    }

    // Create one entry per (asset, method) pair
    for (const [method, positions] of byMethod) {
      const groupQty = positions.reduce((sum, p) => sum + p.quantity, 0);
      const groupValue = groupQty * row.priceInBase;

      const entry: PositionGroupEntry = { row, positions, groupQty, groupValue };
      const existing = groupMap.get(method) ?? [];
      existing.push(entry);
      groupMap.set(method, existing);
    }
  }

  const groups: CryptoPositionGroup[] = [];
  for (const [method, entries] of groupMap) {
    const totalValue = entries.reduce((sum, e) => sum + e.groupValue, 0);
    groups.push({
      acquisitionMethod: method,
      label: ACQUISITION_LABELS[method] ?? method,
      entries: entries.sort((a, b) => b.groupValue - a.groupValue),
      totalValue,
      entryCount: entries.length,
    });
  }

  groups.sort((a, b) => b.totalValue - a.totalValue);
  return groups;
}

// ── Position-level group types for group-by-wallet mode ─────

/** One asset's positions at a specific wallet within a group */
export interface WalletGroupEntry {
  row: CryptoRow;
  positions: CryptoAssetWithPositions["positions"];
  groupQty: number;
  groupValue: number;
}

/** A group of entries for one wallet */
export interface CryptoWalletGroup {
  walletName: string;
  walletType: string;  // "custodial" | "non_custodial" (or mixed → "mixed")
  entries: WalletGroupEntry[];
  totalValue: number;
  entryCount: number;
}

/**
 * Build position-level groups by wallet: each asset's positions are split by wallet_name,
 * so an asset with positions in multiple wallets appears in multiple wallet groups.
 */
export function buildCryptoWalletGroups(rows: CryptoRow[]): CryptoWalletGroup[] {
  const groupMap = new Map<string, WalletGroupEntry[]>();
  const walletTypeMap = new Map<string, Set<string>>();

  for (const row of rows) {
    // Split this asset's positions by wallet
    const byWallet = new Map<string, CryptoAssetWithPositions["positions"]>();
    for (const pos of row.asset.positions) {
      const wallet = pos.wallet_name ?? "Unknown";
      const arr = byWallet.get(wallet) ?? [];
      arr.push(pos);
      byWallet.set(wallet, arr);

      // Track wallet types for the group
      const types = walletTypeMap.get(wallet) ?? new Set();
      types.add(pos.wallet_type ?? "custodial");
      walletTypeMap.set(wallet, types);
    }

    // Create one entry per (asset, wallet) pair
    for (const [wallet, positions] of byWallet) {
      const groupQty = positions.reduce((sum, p) => sum + p.quantity, 0);
      const groupValue = groupQty * row.priceInBase;

      const entry: WalletGroupEntry = { row, positions, groupQty, groupValue };
      const existing = groupMap.get(wallet) ?? [];
      existing.push(entry);
      groupMap.set(wallet, existing);
    }
  }

  const groups: CryptoWalletGroup[] = [];
  for (const [walletName, entries] of groupMap) {
    const totalValue = entries.reduce((sum, e) => sum + e.groupValue, 0);
    const types = walletTypeMap.get(walletName);
    const walletType = types && types.size === 1 ? [...types][0] : "mixed";

    groups.push({
      walletName,
      walletType,
      entries: entries.sort((a, b) => b.groupValue - a.groupValue),
      totalValue,
      entryCount: entries.length,
    });
  }

  groups.sort((a, b) => b.totalValue - a.totalValue);
  return groups;
}

// ── Position-level group types for group-by-subcategory mode ─

/** A group of crypto assets sharing the same subcategory */
export interface CryptoSubcategoryGroup {
  subcategory: string;
  label: string;
  rows: CryptoRow[];
  totalValue: number;
  entryCount: number;
}

/**
 * Build asset-level groups by subcategory. Each asset belongs to exactly one group.
 * Assets without a subcategory go into "Uncategorized".
 */
export function buildCryptoSubcategoryGroups(rows: CryptoRow[]): CryptoSubcategoryGroup[] {
  const groupMap = new Map<string, CryptoRow[]>();

  for (const row of rows) {
    const key = row.asset.subcategory?.trim() || "__uncategorized__";
    const arr = groupMap.get(key) ?? [];
    arr.push(row);
    groupMap.set(key, arr);
  }

  const groups: CryptoSubcategoryGroup[] = [];
  for (const [key, groupRows] of groupMap) {
    const totalValue = groupRows.reduce((sum, r) => sum + r.valueInBase, 0);
    groups.push({
      subcategory: key,
      label: key === "__uncategorized__" ? "Uncategorized" : key,
      rows: groupRows.sort((a, b) => b.valueInBase - a.valueInBase),
      totalValue,
      entryCount: groupRows.length,
    });
  }

  groups.sort((a, b) => b.totalValue - a.totalValue);
  return groups;
}

// ── Formatters ───────────────────────────────────────────────

export function formatNumber(n: number, decimals = 2): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

/** Format quantities (holdings) — strips trailing zeros while keeping up to maxDecimals precision */
export function formatQuantity(n: number, maxDecimals: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: maxDecimals,
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

// ── Sorting ───────────────────────────────────────────────────

export type CryptoSortKey = "value" | "name" | "change" | "source";
export type SortDirection = "asc" | "desc";

export const DEFAULT_SORT_KEY: CryptoSortKey = "value";
export const DEFAULT_SORT_DIR: SortDirection = "desc";

export const CRYPTO_SORT_OPTIONS: { key: CryptoSortKey; label: string; defaultDir: SortDirection }[] = [
  { key: "value", label: "Value", defaultDir: "desc" },
  { key: "name", label: "Name", defaultDir: "asc" },
  { key: "change", label: "24h %", defaultDir: "desc" },
  { key: "source", label: "Source", defaultDir: "asc" },
];

/** Maps column keys to sort keys (for clickable desktop headers) */
export const COLUMN_TO_SORT: Record<string, CryptoSortKey | undefined> = {
  asset: "name",
  change24h: "change",
  value: "value",
  source: "source",
};

/** Sort crypto rows by key and direction */
export function sortCryptoRows(
  rows: CryptoRow[],
  key: CryptoSortKey,
  dir: SortDirection
): CryptoRow[] {
  return [...rows].sort((a, b) => {
    let av: string | number, bv: string | number;
    switch (key) {
      case "value": av = a.valueInBase; bv = b.valueInBase; break;
      case "name": av = a.asset.name.toLowerCase(); bv = b.asset.name.toLowerCase(); break;
      case "change": av = a.change24h; bv = b.change24h; break;
      case "source": {
        av = getDominantMethod(a.asset.positions);
        bv = getDominantMethod(b.asset.positions);
        break;
      }
    }
    if (av < bv) return dir === "asc" ? -1 : 1;
    if (av > bv) return dir === "asc" ? 1 : -1;
    return 0;
  });
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
      label: "Price",
      header: "Price",
      align: "right",
      width: "w-32",
      renderCell: (row, ctx) => {
        const showBase = ctx.primaryCurrency.toUpperCase() !== "USD";
        return (
          <div className="tabular-nums">
            <span className="text-sm text-zinc-300">
              {row.priceUsd > 0
                ? row.priceUsd >= 1
                  ? formatCurrency(row.priceUsd, "USD")
                  : `$${row.priceUsd.toFixed(6)}`
                : "—"}
            </span>
            {showBase && row.priceInBase > 0 && (
              <span className="block text-xs text-zinc-500">
                {row.priceInBase >= 1
                  ? formatCurrency(row.priceInBase, ctx.primaryCurrency)
                  : `${row.priceInBase.toFixed(6)}`}
              </span>
            )}
          </div>
        );
      },
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
        <span className="text-xs text-zinc-500 tabular-nums">
          {row.totalQty > 0 ? formatQuantity(row.totalQty, 8) : "—"}
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
      key: "source",
      label: "Source",
      header: "Source",
      align: "left",
      width: "w-24",
      hiddenBelow: "md",
      renderCell: (row) => {
        const method = getDominantMethod(row.asset.positions);
        if (row.asset.positions.length === 0) {
          return <span className="text-xs text-zinc-600">—</span>;
        }
        return (
          <span
            className={`text-xs font-medium ${ACQUISITION_COLORS[method] ?? "text-zinc-400"}`}
          >
            {ACQUISITION_LABELS[method] ?? method}
          </span>
        );
      },
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
