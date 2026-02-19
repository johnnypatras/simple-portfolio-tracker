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
