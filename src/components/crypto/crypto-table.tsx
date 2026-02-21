"use client";

import { useState, useMemo, useCallback, useEffect, Fragment } from "react";
import { Plus, Bitcoin, Pencil, Trash2, ChevronsDownUp, ChevronsUpDown, Layers, List, ChevronDown, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown, RotateCcw } from "lucide-react";
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
  WalletType,
} from "@/lib/types";
import {
  getCryptoColumns,
  buildCryptoRows,
  buildCryptoPositionGroups,
  buildCryptoWalletGroups,
  buildCryptoChainGroups,
  buildCryptoSubcategoryGroups,
  sortCryptoRows,
  formatQuantity,
  formatCurrency,
  ACQUISITION_COLORS,
  ACQUISITION_LABELS,
  GROUP_PALETTE,
  CRYPTO_SORT_OPTIONS,
  COLUMN_TO_SORT,
  DEFAULT_SORT_KEY,
  DEFAULT_SORT_DIR,
  type CryptoRow,
  type CryptoSortKey,
  type SortDirection,
} from "./crypto-columns";

// ── Group mode ──────────────────────────────────────────────

type CryptoGroupMode = "flat" | "source" | "wallet" | "chain" | "subcategory";

const GROUP_MODE_CYCLE: CryptoGroupMode[] = ["flat", "source", "wallet", "chain", "subcategory"];
const GROUP_MODE_LABELS: Record<CryptoGroupMode, string> = {
  flat: "Flat list",
  source: "Group by source",
  wallet: "Group by wallet",
  chain: "Group by chain",
  subcategory: "Group by type",
};

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
  const [groupMode, setGroupMode] = useState<CryptoGroupMode>("flat");
  const [sortKey, setSortKey] = useState<CryptoSortKey>(DEFAULT_SORT_KEY);
  const [sortDir, setSortDir] = useState<SortDirection>(DEFAULT_SORT_DIR);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const handleSort = useCallback((key: CryptoSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      const opt = CRYPTO_SORT_OPTIONS.find((o) => o.key === key);
      setSortKey(key);
      setSortDir(opt?.defaultDir ?? "desc");
    }
  }, [sortKey]);

  const handleResetSort = useCallback(() => {
    setSortKey(DEFAULT_SORT_KEY);
    setSortDir(DEFAULT_SORT_DIR);
  }, []);

  const isDefaultSort = sortKey === DEFAULT_SORT_KEY && sortDir === DEFAULT_SORT_DIR;

  const handleCycleSort = useCallback(() => {
    const idx = CRYPTO_SORT_OPTIONS.findIndex((o) => o.key === sortKey);
    const next = CRYPTO_SORT_OPTIONS[(idx + 1) % CRYPTO_SORT_OPTIONS.length];
    setSortKey(next.key);
    setSortDir(next.defaultDir);
  }, [sortKey]);

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

  // Build computed rows (unsorted — used for totals and grouping)
  const baseRows = useMemo(
    () => buildCryptoRows(assets, prices, currencyKey, changeKey),
    [assets, prices, currencyKey, changeKey]
  );

  // Sorted rows for flat mode rendering
  const rows = useMemo(
    () => sortCryptoRows(baseRows, sortKey, sortDir),
    [baseRows, sortKey, sortDir]
  );

  const totalPortfolioValue = useMemo(
    () => baseRows.reduce((sum, r) => sum + r.valueInBase, 0),
    [baseRows]
  );

  // Stablecoin split: exclude from summary total + 24h change weighting
  const { nonStableValue, stablecoinTotal } = useMemo(() => {
    let stable = 0;
    let nonStable = 0;
    for (const r of baseRows) {
      if (r.asset.subcategory === "Stablecoin") {
        stable += r.valueInBase;
      } else {
        nonStable += r.valueInBase;
      }
    }
    return { nonStableValue: nonStable, stablecoinTotal: stable };
  }, [baseRows]);

  const weighted24hChange = useMemo(() => {
    if (nonStableValue === 0) return 0;
    return baseRows
      .filter((r) => r.asset.subcategory !== "Stablecoin")
      .reduce((sum, r) => sum + r.valueInBase * r.change24h, 0) / nonStableValue;
  }, [baseRows, nonStableValue]);

  // Position-level groups for source mode
  const sourceGroups = useMemo(
    () => (groupMode === "source" ? buildCryptoPositionGroups(rows) : []),
    [groupMode, rows]
  );

  // Position-level groups for wallet mode
  const walletGroups = useMemo(
    () => (groupMode === "wallet" ? buildCryptoWalletGroups(rows) : []),
    [groupMode, rows]
  );

  // Asset-level groups for chain mode
  const chainGroups = useMemo(
    () => (groupMode === "chain" ? buildCryptoChainGroups(rows) : []),
    [groupMode, rows]
  );

  // Asset-level groups for subcategory mode
  const subcategoryGroups = useMemo(
    () => (groupMode === "subcategory" ? buildCryptoSubcategoryGroups(rows) : []),
    [groupMode, rows]
  );

  // Existing subcategories for combobox autocomplete
  const existingSubcategories = useMemo(() => {
    const subs = new Set<string>();
    for (const a of assets) {
      if (a.subcategory?.trim()) subs.add(a.subcategory.trim());
    }
    return [...subs].sort();
  }, [assets]);

  // Existing chains for combobox autocomplete
  const existingChains = useMemo(() => {
    const chains = new Set<string>();
    for (const a of assets) {
      if (a.chain?.trim()) chains.add(a.chain.trim());
    }
    return [...chains].sort();
  }, [assets]);

  // Sort entries within a group (reuses the same sort key/dir as flat mode)
  const sortEntries = useCallback(
    <T extends { row: CryptoRow; groupValue: number }>(entries: T[]): T[] => {
      return [...entries].sort((a, b) => {
        let av: string | number, bv: string | number;
        switch (sortKey) {
          case "value": av = a.groupValue; bv = b.groupValue; break;
          case "name": av = a.row.asset.name.toLowerCase(); bv = b.row.asset.name.toLowerCase(); break;
          case "change": av = a.row.change24h; bv = b.row.change24h; break;
          case "source": av = ""; bv = ""; break; // irrelevant inside a source group
          case "chain": av = (a.row.asset.chain ?? "").toLowerCase(); bv = (b.row.asset.chain ?? "").toLowerCase(); break;
          case "subcategory": av = (a.row.asset.subcategory ?? "").toLowerCase(); bv = (b.row.asset.subcategory ?? "").toLowerCase(); break;
          case "apy": av = a.row.weightedApy; bv = b.row.weightedApy; break;
        }
        if (av < bv) return sortDir === "asc" ? -1 : 1;
        if (av > bv) return sortDir === "asc" ? 1 : -1;
        return 0;
      });
    },
    [sortKey, sortDir]
  );

  const isGrouped = groupMode !== "flat";

  // Auto-expand everything when entering any mode (flat or grouped)
  useEffect(() => {
    if (groupMode === "flat") {
      setExpanded(new Set(rows.map((r) => r.id)));
      return;
    }
    const groupKeys =
      groupMode === "source"
        ? sourceGroups.map((g) => g.acquisitionMethod)
        : groupMode === "wallet"
          ? walletGroups.map((g) => g.walletName)
          : groupMode === "chain"
            ? chainGroups.map((g) => g.chain)
            : subcategoryGroups.map((g) => g.subcategory);
    if (groupKeys.length > 0) {
      setExpandedGroups(new Set(groupKeys));
      setExpanded(new Set(rows.map((r) => r.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupMode]);

  const allExpanded = rows.length > 0 && rows.every((r) => expanded.has(r.id));

  const allGroupsExpanded = isGrouped && (
    groupMode === "source"
      ? sourceGroups.length > 0 && sourceGroups.every((g) => expandedGroups.has(g.acquisitionMethod))
      : groupMode === "wallet"
        ? walletGroups.length > 0 && walletGroups.every((g) => expandedGroups.has(g.walletName))
        : groupMode === "chain"
          ? chainGroups.length > 0 && chainGroups.every((g) => expandedGroups.has(g.chain))
          : subcategoryGroups.length > 0 && subcategoryGroups.every((g) => expandedGroups.has(g.subcategory))
  );

  const allGroupAssetsExpanded =
    allGroupsExpanded && rows.length > 0 && rows.every((r) => expanded.has(r.id));

  const toggleExpandAll = useCallback(() => {
    if (isGrouped) {
      // Expand/collapse both levels: groups AND asset rows within them
      if (allGroupsExpanded && rows.every((r) => expanded.has(r.id))) {
        setExpandedGroups(new Set());
        setExpanded(new Set());
      } else {
        const groupKeys =
          groupMode === "source"
            ? sourceGroups.map((g) => g.acquisitionMethod)
            : groupMode === "wallet"
              ? walletGroups.map((g) => g.walletName)
              : groupMode === "chain"
                ? chainGroups.map((g) => g.chain)
                : subcategoryGroups.map((g) => g.subcategory);
        setExpandedGroups(new Set(groupKeys));
        setExpanded(new Set(rows.map((r) => r.id)));
      }
    } else {
      setExpanded((prev) => {
        if (rows.every((r) => prev.has(r.id))) return new Set();
        return new Set(rows.map((r) => r.id));
      });
    }
  }, [rows, sourceGroups, walletGroups, chainGroups, subcategoryGroups, groupMode, isGrouped, allGroupsExpanded, expanded]);

  const toggleGroupExpand = useCallback((groupKey: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      const wasOpen = next.has(groupKey);
      if (wasOpen) next.delete(groupKey);
      else next.add(groupKey);

      // Also expand/collapse all asset rows within the toggled group
      let assetIds: string[] = [];
      if (groupMode === "chain") {
        const group = chainGroups.find((g) => g.chain === groupKey);
        assetIds = group?.rows.map((r) => r.id) ?? [];
      } else if (groupMode === "subcategory") {
        const group = subcategoryGroups.find((g) => g.subcategory === groupKey);
        assetIds = group?.rows.map((r) => r.id) ?? [];
      } else {
        const entries =
          groupMode === "source"
            ? sourceGroups.find((g) => g.acquisitionMethod === groupKey)?.entries
            : walletGroups.find((g) => g.walletName === groupKey)?.entries;
        assetIds = entries?.map((e) => e.row.id) ?? [];
      }

      if (assetIds.length > 0) {
        setExpanded((prevExp) => {
          const nextExp = new Set(prevExp);
          for (const id of assetIds) {
            if (wasOpen) nextExp.delete(id);
            else nextExp.add(id);
          }
          return nextExp;
        });
      }

      return next;
    });
  }, [groupMode, sourceGroups, walletGroups, chainGroups, subcategoryGroups]);

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
  } = useColumnConfig("colConfig:crypto", columns, 3);

  const ctx: RenderContext = { primaryCurrency, fxRates: {} };

  const totalPositions = useMemo(
    () => assets.reduce((sum, a) => sum + a.positions.length, 0),
    [assets]
  );

  return (
    <div>
      {/* ── Summary header ─────────────────────────────────── */}
      <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-4 md:p-5">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-0 md:gap-4">
          {/* Info: total + stats */}
          <div className="flex items-center justify-between md:justify-start md:gap-6 flex-1 min-w-0">
            <div>
              <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                Total Crypto
              </p>
              <p className="text-2xl font-semibold text-zinc-100 mt-1 tabular-nums">
                {formatCurrency(nonStableValue, primaryCurrency)}
                {weighted24hChange !== 0 && (
                  <span className={`text-sm font-medium ml-2 ${weighted24hChange >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {weighted24hChange >= 0 ? "+" : ""}{weighted24hChange.toFixed(2)}%
                  </span>
                )}
              </p>
              {stablecoinTotal > 0 && (
                <p className="text-xs tabular-nums mt-0.5 text-zinc-500">
                  excl. {formatCurrency(stablecoinTotal, primaryCurrency)} stablecoins
                </p>
              )}
            </div>
            <div className="text-right md:text-left text-xs text-zinc-500 space-y-0.5">
              <p>
                {assets.length} asset{assets.length !== 1 ? "s" : ""}
              </p>
              <p>
                {totalPositions} position{totalPositions !== 1 ? "s" : ""}
              </p>
            </div>
          </div>
          {/* Toolbar: action buttons */}
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-zinc-800/30 md:mt-0 md:pt-0 md:border-t-0">
            {assets.length > 0 && (
              <>
                <button
                  onClick={() => {
                    const idx = GROUP_MODE_CYCLE.indexOf(groupMode);
                    const next = GROUP_MODE_CYCLE[(idx + 1) % GROUP_MODE_CYCLE.length];
                    setGroupMode(next);
                    setExpandedGroups(new Set());
                  }}
                  className={`p-1.5 rounded-lg transition-colors min-w-[4.5rem] flex items-center justify-center gap-1 ${
                    isGrouped
                      ? "text-blue-400 bg-blue-500/10 hover:bg-blue-500/20"
                      : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                  }`}
                  title={GROUP_MODE_LABELS[GROUP_MODE_CYCLE[(GROUP_MODE_CYCLE.indexOf(groupMode) + 1) % GROUP_MODE_CYCLE.length]]}
                >
                  {isGrouped ? (
                    <List className="w-4 h-4 shrink-0" />
                  ) : (
                    <Layers className="w-4 h-4 shrink-0" />
                  )}
                  {isGrouped && (
                    <span className="text-[10px] font-medium">
                      {groupMode === "source" ? "Source" : groupMode === "wallet" ? "Wallet" : groupMode === "chain" ? "Chain" : "Type"}
                    </span>
                  )}
                </button>
                {/* Mobile sort cycle (no column headers on mobile) */}
                {assets.length > 1 && (
                  <button
                    onClick={handleCycleSort}
                    className="md:hidden p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                    title={`Sort: ${CRYPTO_SORT_OPTIONS.find((o) => o.key === sortKey)?.label}`}
                  >
                    <div className="flex items-center gap-1">
                      <ArrowUpDown className="w-3.5 h-3.5" />
                      <span className="text-[10px] font-medium">
                        {CRYPTO_SORT_OPTIONS.find((o) => o.key === sortKey)?.label}
                      </span>
                      {sortDir === "desc" ? (
                        <ArrowDown className="w-3 h-3" />
                      ) : (
                        <ArrowUp className="w-3 h-3" />
                      )}
                    </div>
                  </button>
                )}
                {/* Reset sort (all sizes) */}
                {!isDefaultSort && (
                  <button
                    onClick={handleResetSort}
                    className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800 transition-colors"
                    title="Reset sort"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={toggleExpandAll}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                  title={
                    isGrouped
                      ? allGroupAssetsExpanded ? "Collapse all" : "Expand all"
                      : allExpanded ? "Collapse all" : "Expand all"
                  }
                >
                  {(isGrouped ? allGroupAssetsExpanded : allExpanded) ? (
                    <ChevronsDownUp className="w-4 h-4" />
                  ) : (
                    <ChevronsUpDown className="w-4 h-4" />
                  )}
                </button>
              </>
            )}
            <ColumnSettingsPopover
              columns={configurableColumns}
              onToggle={toggleColumn}
              onMove={moveColumn}
              onReset={resetToDefaults}
            />
            {/* Mobile: + Add Asset in toolbar */}
            <button
              onClick={() => setAddOpen(true)}
              className="ml-auto md:hidden flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add
            </button>
          </div>
        </div>
      </div>

      {/* ── Action bar (desktop) ─────────────────────────── */}
      <div className="hidden md:flex items-center justify-end mt-2 mb-3">
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
        <>
          {/* ── Mobile card layout ── */}
          <div className="space-y-2 md:hidden">
            {groupMode === "source"
              ? sourceGroups.map((group) => {
                  const isGroupOpen = expandedGroups.has(group.acquisitionMethod);
                  return (
                    <div key={`mgroup:${group.acquisitionMethod}`}>
                      <button
                        onClick={() => toggleGroupExpand(group.acquisitionMethod)}
                        className="w-full flex items-center gap-2 px-3 py-2 mb-1 rounded-lg bg-zinc-800/40 border-l-2 border-l-blue-500/40"
                      >
                        {isGroupOpen ? (
                          <ChevronDown className="w-3 h-3 text-zinc-500" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-zinc-500" />
                        )}
                        <span
                          className={`text-sm font-semibold uppercase tracking-wider ${
                            ACQUISITION_COLORS[group.acquisitionMethod] ?? "text-zinc-400"
                          }`}
                        >
                          {group.label}
                        </span>
                        <span className="text-[11px] text-zinc-600">
                          ({group.entryCount})
                        </span>
                        <span className="ml-auto text-xs font-medium text-zinc-400 tabular-nums">
                          {formatCurrency(group.totalValue, primaryCurrency)}
                        </span>
                      </button>

                      {isGroupOpen && (
                        <div className="space-y-2 ml-6">
                          {sortEntries(group.entries).map((entry) => (
                            <MobileCryptoCard
                              key={`${group.acquisitionMethod}:${entry.row.id}`}
                              row={entry.row}
                              expanded={expanded.has(entry.row.asset.id)}
                              toggleExpand={toggleExpand}
                              handleEdit={handleEdit}
                              handleDelete={handleDelete}
                              primaryCurrency={primaryCurrency}
                              overrideQty={entry.groupQty}
                              overrideValue={entry.groupValue}
                              groupPositions={entry.positions}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              : groupMode === "wallet"
                ? walletGroups.map((group, gi) => {
                    const isGroupOpen = expandedGroups.has(group.walletName);
                    const wtInfo = WALLET_TYPE_LABELS[group.walletType];
                    const groupColor = GROUP_PALETTE[gi % GROUP_PALETTE.length];
                    return (
                      <div key={`mwgroup:${group.walletName}`}>
                        <button
                          onClick={() => toggleGroupExpand(group.walletName)}
                          className="w-full flex items-center gap-2 px-3 py-2 mb-1 rounded-lg bg-zinc-800/40 border-l-2 border-l-blue-500/40"
                        >
                          {isGroupOpen ? (
                            <ChevronDown className="w-3 h-3 text-zinc-500" />
                          ) : (
                            <ChevronRight className="w-3 h-3 text-zinc-500" />
                          )}
                          <span className={`text-sm font-semibold uppercase tracking-wider ${groupColor}`}>
                            {group.walletName}
                          </span>
                          {wtInfo && (
                            <span className={`text-[10px] font-medium ${wtInfo.color}`}>
                              {wtInfo.label}
                            </span>
                          )}
                          <span className="text-[11px] text-zinc-600">
                            ({group.entryCount})
                          </span>
                          <span className="ml-auto text-xs font-medium text-zinc-400 tabular-nums">
                            {formatCurrency(group.totalValue, primaryCurrency)}
                          </span>
                        </button>

                        {isGroupOpen && (
                          <div className="space-y-2 ml-6">
                            {sortEntries(group.entries).map((entry) => (
                              <MobileCryptoCard
                                key={`${group.walletName}:${entry.row.id}`}
                                row={entry.row}
                                expanded={expanded.has(entry.row.asset.id)}
                                toggleExpand={toggleExpand}
                                handleEdit={handleEdit}
                                handleDelete={handleDelete}
                                primaryCurrency={primaryCurrency}
                                overrideQty={entry.groupQty}
                                overrideValue={entry.groupValue}
                                groupPositions={entry.positions}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                : groupMode === "chain"
                  ? chainGroups.map((group, gi) => {
                      const isGroupOpen = expandedGroups.has(group.chain);
                      const groupColor = GROUP_PALETTE[gi % GROUP_PALETTE.length];
                      return (
                        <div key={`mchgroup:${group.chain}`}>
                          <button
                            onClick={() => toggleGroupExpand(group.chain)}
                            className="w-full flex items-center gap-2 px-3 py-2 mb-1 rounded-lg bg-zinc-800/40 border-l-2 border-l-blue-500/40"
                          >
                            {isGroupOpen ? (
                              <ChevronDown className="w-3 h-3 text-zinc-500" />
                            ) : (
                              <ChevronRight className="w-3 h-3 text-zinc-500" />
                            )}
                            <span className={`text-sm font-semibold tracking-wider ${groupColor}`}>
                              {group.label}
                            </span>
                            <span className="text-[11px] text-zinc-600">
                              ({group.entryCount})
                            </span>
                            <span className="ml-auto text-xs font-medium text-zinc-400 tabular-nums">
                              {formatCurrency(group.totalValue, primaryCurrency)}
                            </span>
                          </button>

                          {isGroupOpen && (
                            <div className="space-y-2 ml-6">
                              {group.rows.map((row) => (
                                <MobileCryptoCard
                                  key={`${group.chain}:${row.id}`}
                                  row={row}
                                  expanded={expanded.has(row.asset.id)}
                                  toggleExpand={toggleExpand}
                                  handleEdit={handleEdit}
                                  handleDelete={handleDelete}
                                  primaryCurrency={primaryCurrency}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })
                  : groupMode === "subcategory"
                    ? subcategoryGroups.map((group, gi) => {
                        const isGroupOpen = expandedGroups.has(group.subcategory);
                        const groupColor = GROUP_PALETTE[gi % GROUP_PALETTE.length];
                        return (
                          <div key={`mscgroup:${group.subcategory}`}>
                            <button
                              onClick={() => toggleGroupExpand(group.subcategory)}
                              className="w-full flex items-center gap-2 px-3 py-2 mb-1 rounded-lg bg-zinc-800/40 border-l-2 border-l-blue-500/40"
                            >
                              {isGroupOpen ? (
                                <ChevronDown className="w-3 h-3 text-zinc-500" />
                              ) : (
                                <ChevronRight className="w-3 h-3 text-zinc-500" />
                              )}
                              <span className={`text-sm font-semibold tracking-wider ${groupColor}`}>
                                {group.label}
                              </span>
                              <span className="text-[11px] text-zinc-600">
                                ({group.entryCount})
                              </span>
                              <span className="ml-auto text-xs font-medium text-zinc-400 tabular-nums">
                                {formatCurrency(group.totalValue, primaryCurrency)}
                              </span>
                            </button>

                            {isGroupOpen && (
                              <div className="space-y-2 ml-6">
                                {group.rows.map((row) => (
                                  <MobileCryptoCard
                                    key={`${group.subcategory}:${row.id}`}
                                    row={row}
                                    expanded={expanded.has(row.asset.id)}
                                    toggleExpand={toggleExpand}
                                    handleEdit={handleEdit}
                                    handleDelete={handleDelete}
                                    primaryCurrency={primaryCurrency}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })
                    : rows.map((row) => (
                      <MobileCryptoCard
                        key={row.id}
                        row={row}
                        expanded={expanded.has(row.asset.id)}
                        toggleExpand={toggleExpand}
                        handleEdit={handleEdit}
                        handleDelete={handleDelete}
                        primaryCurrency={primaryCurrency}
                      />
                    ))}
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
                    const colSortKey = COLUMN_TO_SORT[col.key];
                    const isSortable = !!colSortKey;
                    const isActiveSort = colSortKey === sortKey;
                    return (
                      <th
                        key={col.key}
                        className={`px-4 py-2.5 text-xs font-medium text-zinc-500 uppercase tracking-wider ${align} ${hidden} ${width} ${
                          isSortable ? "cursor-pointer select-none hover:text-zinc-300 transition-colors" : ""
                        }`}
                        onClick={isSortable ? () => handleSort(colSortKey) : undefined}
                      >
                        <span className={`inline-flex items-center gap-1 ${align === "text-right" ? "justify-end" : ""}`}>
                          {col.renderHeader ? col.renderHeader(ctx) : col.header}
                          {isSortable && (
                            isActiveSort
                              ? sortDir === "desc"
                                ? <ArrowDown className="w-3 h-3 text-zinc-400" />
                                : <ArrowUp className="w-3 h-3 text-zinc-400" />
                              : <ArrowUpDown className="w-3 h-3 text-zinc-700" />
                          )}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {groupMode === "source"
                  ? sourceGroups.map((group) => {
                      const isGroupOpen = expandedGroups.has(group.acquisitionMethod);
                      return (
                        <Fragment key={`group:${group.acquisitionMethod}`}>
                          <tr
                            className="border-b border-zinc-800/30 border-l-2 border-l-blue-500/40 bg-zinc-900/80 cursor-pointer hover:bg-zinc-800/40 transition-colors"
                            onClick={() => toggleGroupExpand(group.acquisitionMethod)}
                          >
                            <td colSpan={orderedColumns.length - 1} className="px-4 py-2.5">
                              <div className="flex items-center gap-2">
                                {isGroupOpen ? (
                                  <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
                                ) : (
                                  <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />
                                )}
                                <span
                                  className={`text-sm font-semibold uppercase tracking-wider ${
                                    ACQUISITION_COLORS[group.acquisitionMethod] ?? "text-zinc-400"
                                  }`}
                                >
                                  {group.label}
                                </span>
                                <span className="text-[11px] text-zinc-600">
                                  {group.entryCount} asset{group.entryCount !== 1 ? "s" : ""}
                                </span>
                                <span className="ml-auto text-xs font-medium text-zinc-400 tabular-nums">
                                  {formatCurrency(group.totalValue, primaryCurrency)}
                                </span>
                              </div>
                            </td>
                            <td />
                          </tr>

                          {isGroupOpen &&
                            group.entries.map((entry) => (
                              <GroupedCryptoEntryRows
                                key={`${group.acquisitionMethod}:${entry.row.id}`}
                                entry={entry}
                                expanded={expanded}
                                orderedColumns={orderedColumns}
                                ctx={ctx}
                                primaryCurrency={primaryCurrency}
                              />
                            ))}
                        </Fragment>
                      );
                    })
                  : groupMode === "wallet"
                    ? walletGroups.map((group, gi) => {
                        const isGroupOpen = expandedGroups.has(group.walletName);
                        const wtInfo = WALLET_TYPE_LABELS[group.walletType];
                        const groupColor = GROUP_PALETTE[gi % GROUP_PALETTE.length];
                        return (
                          <Fragment key={`wgroup:${group.walletName}`}>
                            <tr
                              className="border-b border-zinc-800/30 border-l-2 border-l-blue-500/40 bg-zinc-900/80 cursor-pointer hover:bg-zinc-800/40 transition-colors"
                              onClick={() => toggleGroupExpand(group.walletName)}
                            >
                              <td colSpan={orderedColumns.length - 1} className="px-4 py-2.5">
                                <div className="flex items-center gap-2">
                                  {isGroupOpen ? (
                                    <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
                                  ) : (
                                    <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />
                                  )}
                                  <span className={`text-sm font-semibold uppercase tracking-wider ${groupColor}`}>
                                    {group.walletName}
                                  </span>
                                  {wtInfo && (
                                    <span className={`text-[10px] font-medium ${wtInfo.color}`}>
                                      {wtInfo.label}
                                    </span>
                                  )}
                                  <span className="text-[11px] text-zinc-600">
                                    {group.entryCount} asset{group.entryCount !== 1 ? "s" : ""}
                                  </span>
                                  <span className="ml-auto text-xs font-medium text-zinc-400 tabular-nums">
                                    {formatCurrency(group.totalValue, primaryCurrency)}
                                  </span>
                                </div>
                              </td>
                              <td />
                            </tr>

                            {isGroupOpen &&
                              group.entries.map((entry) => (
                                <GroupedCryptoEntryRows
                                  key={`${group.walletName}:${entry.row.id}`}
                                  entry={entry}
                                  expanded={expanded}
                                  orderedColumns={orderedColumns}
                                  ctx={ctx}
                                  primaryCurrency={primaryCurrency}
                                />
                              ))}
                          </Fragment>
                        );
                      })
                    : groupMode === "chain"
                      ? chainGroups.map((group, gi) => {
                          const isGroupOpen = expandedGroups.has(group.chain);
                          const groupColor = GROUP_PALETTE[gi % GROUP_PALETTE.length];
                          return (
                            <Fragment key={`chgroup:${group.chain}`}>
                              <tr
                                className="border-b border-zinc-800/30 border-l-2 border-l-blue-500/40 bg-zinc-900/80 cursor-pointer hover:bg-zinc-800/40 transition-colors"
                                onClick={() => toggleGroupExpand(group.chain)}
                              >
                                <td colSpan={orderedColumns.length - 1} className="px-4 py-2.5">
                                  <div className="flex items-center gap-2">
                                    {isGroupOpen ? (
                                      <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
                                    ) : (
                                      <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />
                                    )}
                                    <span className={`text-sm font-semibold tracking-wider ${groupColor}`}>
                                      {group.label}
                                    </span>
                                    <span className="text-[11px] text-zinc-600">
                                      {group.entryCount} asset{group.entryCount !== 1 ? "s" : ""}
                                    </span>
                                    <span className="ml-auto text-xs font-medium text-zinc-400 tabular-nums">
                                      {formatCurrency(group.totalValue, primaryCurrency)}
                                    </span>
                                  </div>
                                </td>
                                <td />
                              </tr>

                              {isGroupOpen &&
                                group.rows.map((row) => {
                                  const rowExpanded = expanded.has(row.asset.id);
                                  return (
                                    <Fragment key={`${group.chain}:${row.id}`}>
                                      <tr className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors">
                                        {orderedColumns.map((col, ci) => {
                                          const align = col.align === "right" ? "text-right" : "text-left";
                                          const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";
                                          const pl = ci === 0 ? "pl-12 pr-4" : "px-4";
                                          return (
                                            <td key={col.key} className={`${pl} py-3 ${align} ${hidden}`}>
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
                                              walletType={pos.wallet_type}
                                              quantity={formatQuantity(pos.quantity, 8)}
                                              value={posValue > 0 ? formatCurrency(posValue, primaryCurrency) : "—"}
                                              acquisitionMethod={pos.acquisition_method ?? "bought"}
                                              orderedColumns={orderedColumns}
                                              grouped
                                            />
                                          );
                                        })}

                                      {rowExpanded && row.asset.positions.length === 0 && (
                                        <tr className="bg-zinc-950/50 border-b border-zinc-800/20">
                                          <td colSpan={orderedColumns.length} className="pl-16 pr-4 py-3">
                                            <p className="text-xs text-zinc-600">
                                              No positions — click edit to add quantities
                                            </p>
                                          </td>
                                        </tr>
                                      )}
                                    </Fragment>
                                  );
                                })}
                            </Fragment>
                          );
                        })
                      : groupMode === "subcategory"
                        ? subcategoryGroups.map((group, gi) => {
                            const isGroupOpen = expandedGroups.has(group.subcategory);
                            const groupColor = GROUP_PALETTE[gi % GROUP_PALETTE.length];
                            return (
                              <Fragment key={`scgroup:${group.subcategory}`}>
                                <tr
                                className="border-b border-zinc-800/30 border-l-2 border-l-blue-500/40 bg-zinc-900/80 cursor-pointer hover:bg-zinc-800/40 transition-colors"
                                onClick={() => toggleGroupExpand(group.subcategory)}
                              >
                                <td colSpan={orderedColumns.length - 1} className="px-4 py-2.5">
                                  <div className="flex items-center gap-2">
                                    {isGroupOpen ? (
                                      <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
                                    ) : (
                                      <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />
                                    )}
                                    <span className={`text-sm font-semibold tracking-wider ${groupColor}`}>
                                      {group.label}
                                    </span>
                                    <span className="text-[11px] text-zinc-600">
                                      {group.entryCount} asset{group.entryCount !== 1 ? "s" : ""}
                                    </span>
                                    <span className="ml-auto text-xs font-medium text-zinc-400 tabular-nums">
                                      {formatCurrency(group.totalValue, primaryCurrency)}
                                    </span>
                                  </div>
                                </td>
                                <td />
                              </tr>

                              {isGroupOpen &&
                                group.rows.map((row) => {
                                  const rowExpanded = expanded.has(row.asset.id);
                                  return (
                                    <Fragment key={`${group.subcategory}:${row.id}`}>
                                      <tr className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors">
                                        {orderedColumns.map((col, ci) => {
                                          const align = col.align === "right" ? "text-right" : "text-left";
                                          const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";
                                          const pl = ci === 0 ? "pl-12 pr-4" : "px-4";
                                          return (
                                            <td key={col.key} className={`${pl} py-3 ${align} ${hidden}`}>
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
                                              walletType={pos.wallet_type}
                                              quantity={formatQuantity(pos.quantity, 8)}
                                              value={posValue > 0 ? formatCurrency(posValue, primaryCurrency) : "—"}
                                              acquisitionMethod={pos.acquisition_method ?? "bought"}
                                              orderedColumns={orderedColumns}
                                              grouped
                                            />
                                          );
                                        })}

                                      {rowExpanded && row.asset.positions.length === 0 && (
                                        <tr className="bg-zinc-950/50 border-b border-zinc-800/20">
                                          <td colSpan={orderedColumns.length} className="pl-16 pr-4 py-3">
                                            <p className="text-xs text-zinc-600">
                                              No positions — click edit to add quantities
                                            </p>
                                          </td>
                                        </tr>
                                      )}
                                    </Fragment>
                                  );
                                })}
                            </Fragment>
                          );
                        })
                      : rows.map((row) => {
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
                                      walletType={pos.wallet_type}
                                      quantity={formatQuantity(pos.quantity, 8)}
                                      value={posValue > 0 ? formatCurrency(posValue, primaryCurrency) : "—"}
                                      acquisitionMethod={pos.acquisition_method ?? "bought"}
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
      <AddCryptoModal open={addOpen} onClose={() => setAddOpen(false)} wallets={wallets} existingSubcategories={existingSubcategories} existingChains={existingChains} />
      {editingAsset && (
        <PositionEditor
          open={!!editingAsset}
          onClose={() => setEditingAsset(null)}
          asset={editingAsset}
          wallets={wallets}
          existingSubcategories={existingSubcategories}
          existingChains={existingChains}
        />
      )}
    </div>
  );
}

// ── Grouped entry rows (shared by source + wallet modes) ─────
// Renders one entry (asset within a group) with per-group qty/value overrides.

function GroupedCryptoEntryRows({
  entry,
  expanded,
  orderedColumns,
  ctx,
  primaryCurrency,
}: {
  entry: { row: CryptoRow; positions: CryptoAssetWithPositions["positions"]; groupQty: number; groupValue: number };
  expanded: Set<string>;
  orderedColumns: ColumnDef<CryptoRow>[];
  ctx: RenderContext;
  primaryCurrency: string;
}) {
  const { row } = entry;
  const rowExpanded = expanded.has(row.asset.id);

  return (
    <Fragment>
      <tr className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors">
        {orderedColumns.map((col, ci) => {
          const align = col.align === "right" ? "text-right" : "text-left";
          const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";
          const pl = ci === 0 ? "pl-12 pr-4" : "px-4";
          // Override holdings/value/source for per-group values
          if (col.key === "holdings") {
            return (
              <td key={col.key} className={`${pl} py-3 text-right ${hidden}`}>
                <span className="text-xs text-zinc-500 tabular-nums">
                  {entry.groupQty > 0 ? formatQuantity(entry.groupQty, 8) : "—"}
                </span>
              </td>
            );
          }
          if (col.key === "value") {
            return (
              <td key={col.key} className={`${pl} py-3 text-right ${hidden}`}>
                <span className="text-sm font-medium text-zinc-200 tabular-nums">
                  {entry.groupValue > 0 ? formatCurrency(entry.groupValue, primaryCurrency) : "—"}
                </span>
              </td>
            );
          }
          if (col.key === "source") {
            return (
              <td key={col.key} className={`${pl} py-3 text-left ${hidden}`}>
                <span className="text-xs text-zinc-600">—</span>
              </td>
            );
          }
          return (
            <td key={col.key} className={`${pl} py-3 ${align} ${hidden}`}>
              {col.renderCell(row, ctx)}
            </td>
          );
        })}
      </tr>

      {rowExpanded && entry.positions.length > 0 &&
        entry.positions.map((pos) => {
          const posValue = pos.quantity * row.priceInBase;
          return (
            <ExpandedCryptoRow
              key={pos.id}
              walletName={pos.wallet_name}
              walletType={pos.wallet_type}
              quantity={formatQuantity(pos.quantity, 8)}
              value={posValue > 0 ? formatCurrency(posValue, primaryCurrency) : "—"}
              acquisitionMethod={pos.acquisition_method ?? "bought"}
              orderedColumns={orderedColumns}
              grouped
            />
          );
        })}

      {rowExpanded && entry.positions.length === 0 && (
        <tr className="bg-zinc-950/50 border-b border-zinc-800/20">
          <td colSpan={orderedColumns.length} className="pl-16 pr-4 py-3">
            <p className="text-xs text-zinc-600">
              No positions — click edit to add quantities
            </p>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// ── Expanded sub-row ─────────────────────────────────────────
// Renders wallet name under the Asset column, quantity under Holdings,
// value under Value, and empty cells for everything else.

const WALLET_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  custodial: { label: "Exchange", color: "text-sky-400" },
  non_custodial: { label: "Self-custody", color: "text-violet-400" },
};

function ExpandedCryptoRow({
  walletName,
  walletType,
  quantity,
  value,
  acquisitionMethod,
  orderedColumns,
  grouped,
}: {
  walletName: string;
  walletType?: WalletType;
  quantity: string;
  value: string;
  acquisitionMethod: string;
  orderedColumns: ColumnDef<CryptoRow>[];
  grouped?: boolean;
}) {
  const wtInfo = walletType ? WALLET_TYPE_LABELS[walletType] : null;
  const assetPl = grouped ? "pl-16" : "pl-10";

  return (
    <tr className="bg-zinc-950/50 border-b border-zinc-800/20">
      {orderedColumns.map((col) => {
        const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";

        if (col.key === "asset") {
          return (
            <td key={col.key} className={`${assetPl} pr-4 py-2`}>
              <span className="text-xs text-zinc-500">{walletName}</span>
              {wtInfo && (
                <span className={`ml-1.5 text-[10px] font-medium ${wtInfo.color}`}>
                  {wtInfo.label}
                </span>
              )}
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
        if (col.key === "source") {
          return (
            <td key={col.key} className={`px-4 py-2 text-left ${hidden}`}>
              <span className={`text-xs font-medium ${ACQUISITION_COLORS[acquisitionMethod] ?? "text-zinc-400"}`}>
                {ACQUISITION_LABELS[acquisitionMethod] ?? acquisitionMethod}
              </span>
            </td>
          );
        }
        // Empty cell for all other columns
        return <td key={col.key} className={hidden} />;
      })}
    </tr>
  );
}

// ── Mobile card component ───────────────────────────────────

function MobileCryptoCard({
  row,
  expanded: rowExpanded,
  toggleExpand,
  handleEdit,
  handleDelete,
  primaryCurrency,
  overrideQty,
  overrideValue,
  groupPositions,
}: {
  row: CryptoRow;
  expanded: boolean;
  toggleExpand: (id: string) => void;
  handleEdit: (asset: CryptoAssetWithPositions) => void;
  handleDelete: (id: string, name: string) => void;
  primaryCurrency: string;
  overrideQty?: number;
  overrideValue?: number;
  groupPositions?: CryptoAssetWithPositions["positions"];
}) {
  const displayQty = overrideQty ?? row.totalQty;
  const displayValue = overrideValue ?? row.valueInBase;
  const displayPositions = groupPositions ?? row.asset.positions;

  return (
    <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
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
            {displayValue > 0 ? formatCurrency(displayValue, primaryCurrency) : "—"}
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
                {displayQty > 0 ? formatQuantity(displayQty, 8) : "—"}
              </p>
            </div>
            {(row.asset.chain?.trim() || row.asset.subcategory?.trim() || row.weightedApy > 0) && (
              <>
                {row.asset.chain?.trim() && (
                  <div>
                    <span className="text-zinc-500">Chain</span>
                    <p className="text-zinc-400">{row.asset.chain}</p>
                  </div>
                )}
                {row.asset.subcategory?.trim() && (
                  <div>
                    <span className="text-zinc-500">Type</span>
                    <p className="text-zinc-400">{row.asset.subcategory}</p>
                  </div>
                )}
                {row.weightedApy > 0 && (
                  <div>
                    <span className="text-zinc-500">APY</span>
                    <p className="text-emerald-400 font-medium">
                      {row.weightedApy.toFixed(row.weightedApy % 1 === 0 ? 0 : 2)}%
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          {displayPositions.length > 0 && (
            <div className="mt-3 pt-2 border-t border-zinc-800/20 space-y-1">
              {displayPositions.map((pos) => {
                const posValue = pos.quantity * row.priceInBase;
                const method = pos.acquisition_method ?? "bought";
                const wtInfo = WALLET_TYPE_LABELS[pos.wallet_type];
                return (
                  <div key={pos.id} className="flex justify-between text-xs">
                    <span className="text-zinc-500">
                      {pos.wallet_name}
                      {wtInfo && (
                        <span className={`ml-1 text-[10px] font-medium ${wtInfo.color}`}>
                          {wtInfo.label}
                        </span>
                      )}
                    </span>
                    <span className="text-zinc-400 tabular-nums">
                      {formatQuantity(pos.quantity, 8)} · {posValue > 0 ? formatCurrency(posValue, primaryCurrency) : "—"}
                      {" · "}
                      <span className={ACQUISITION_COLORS[method] ?? "text-zinc-400"}>
                        {ACQUISITION_LABELS[method] ?? method}
                      </span>
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
}
