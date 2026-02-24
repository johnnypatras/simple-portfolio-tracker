"use client";

import { useState, useMemo, useCallback, Fragment } from "react";
import { Plus, TrendingUp, Pencil, Trash2, ChevronsDownUp, ChevronsUpDown, Layers, List, ChevronDown, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown, RotateCcw } from "lucide-react";
import { AddStockModal } from "./add-stock-modal";
import { StockPositionEditor } from "./stock-position-editor";
import { ColumnSettingsPopover } from "@/components/ui/column-settings-popover";
import { useColumnConfig } from "@/lib/hooks/use-column-config";
import { convertToBase } from "@/lib/prices/fx";
import { toast } from "sonner";
import { deleteStockAsset } from "@/lib/actions/stocks";
import type { FXRates } from "@/lib/prices/fx";
import type { RenderContext, ColumnDef } from "@/lib/column-config";
import { HIDDEN_BELOW } from "@/lib/constants";
import type {
  StockAssetWithPositions,
  Broker,
  YahooStockPriceData,
} from "@/lib/types";
import {
  getStockColumns,
  buildStockRows,
  buildStockGroupRows,
  buildStockBrokerGroups,
  buildStockCurrencyGroups,
  buildStockSubcategoryGroups,
  buildTickerGroups,
  sortFlatItems,
  sortRows,
  formatQuantity,
  formatCurrency,
  getCurrencyColor,
  TYPE_LABELS,
  TYPE_COLORS,
  GROUP_PALETTE,
  SORT_OPTIONS,
  COLUMN_TO_SORT,
  DEFAULT_SORT_KEY,
  DEFAULT_SORT_DIR,
  type StockRow,
  type TickerGroup,
  type FlatItem,
  type SortKey,
  type SortDirection,
} from "./stock-columns";

// ── Group mode ──────────────────────────────────────────────

type StockGroupMode = "flat" | "type" | "broker" | "currency" | "subcategory";

const GROUP_MODE_CYCLE: StockGroupMode[] = ["flat", "type", "broker", "currency", "subcategory"];
const GROUP_MODE_LABELS: Record<StockGroupMode, string> = {
  flat: "Flat list",
  type: "Group by type",
  broker: "Group by broker",
  currency: "Group by currency",
  subcategory: "Group by subtype",
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
  const [groupMode, setGroupMode] = useState<StockGroupMode>("flat");
  const [sortKey, setSortKey] = useState<SortKey>("value");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedTickerGroups, setExpandedTickerGroups] = useState<Set<string>>(new Set());

  const handleSort = useCallback((key: SortKey) => {
    if (sortKey === key) {
      // Same key — toggle direction
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      // New key — apply its default direction
      const opt = SORT_OPTIONS.find((o) => o.key === key);
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
    const idx = SORT_OPTIONS.findIndex((o) => o.key === sortKey);
    const next = SORT_OPTIONS[(idx + 1) % SORT_OPTIONS.length];
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

  const handleEdit = useCallback((asset: StockAssetWithPositions) => {
    setEditingAsset(asset);
  }, []);

  const handleDelete = useCallback(async (id: string, name: string) => {
    if (!confirm(`Remove ${name} from your portfolio? All positions will be deleted.`)) return;
    try {
      await deleteStockAsset(id);
      toast.success(`${name} removed`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
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

  const weighted24hChange = useMemo(() => {
    if (totalPortfolioValue === 0) return 0;
    return rows.reduce((sum, r) => sum + r.valueBase * r.change24h, 0) / totalPortfolioValue;
  }, [rows, totalPortfolioValue]);

  // Grouped rows for group-by-type mode
  const typeGroups = useMemo(
    () => (groupMode === "type" ? buildStockGroupRows(rows) : []),
    [groupMode, rows]
  );

  // Grouped rows for group-by-broker mode
  const brokerGroups = useMemo(
    () => (groupMode === "broker" ? buildStockBrokerGroups(rows) : []),
    [groupMode, rows]
  );

  // Grouped rows for group-by-currency mode
  const currencyGroups = useMemo(
    () => (groupMode === "currency" ? buildStockCurrencyGroups(rows) : []),
    [groupMode, rows]
  );

  // Grouped rows for group-by-subcategory mode
  const subcategoryGroups = useMemo(
    () => (groupMode === "subcategory" ? buildStockSubcategoryGroups(rows) : []),
    [groupMode, rows]
  );

  // Existing subcategories for autocomplete in add/edit modals
  const existingSubcategories = useMemo(() => {
    const subs = new Set<string>();
    for (const a of assets) {
      if (a.subcategory) subs.add(a.subcategory);
    }
    return [...subs].sort();
  }, [assets]);

  // Existing tags for autocomplete in add/edit modals
  const existingTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const a of assets) {
      for (const t of a.tags ?? []) tagSet.add(t);
    }
    return [...tagSet].sort();
  }, [assets]);

  const isGrouped = groupMode !== "flat";


  // Check if all ticker groups are expanded (relevant for flat + type modes)
  const allTickerGroupsExpanded = useMemo(() => {
    if (groupMode === "broker" || groupMode === "currency" || groupMode === "subcategory") return true;
    const tickers = new Set<string>();
    for (const r of rows) tickers.add(r.asset.ticker);
    return [...tickers].every((t) => expandedTickerGroups.has(t));
  }, [rows, expandedTickerGroups, groupMode]);

  const allExpanded = rows.length > 0 && rows.every((r) => expanded.has(r.id)) && allTickerGroupsExpanded;

  const allGroupsExpanded = isGrouped && (
    groupMode === "type"
      ? typeGroups.length > 0 && typeGroups.every((g) => expandedGroups.has(g.category))
      : groupMode === "broker"
      ? brokerGroups.length > 0 && brokerGroups.every((g) => expandedGroups.has(g.brokerName))
      : groupMode === "currency"
      ? currencyGroups.length > 0 && currencyGroups.every((g) => expandedGroups.has(g.currency))
      : subcategoryGroups.length > 0 && subcategoryGroups.every((g) => expandedGroups.has(g.subcategory))
  );

  const allGroupAssetsExpanded =
    allGroupsExpanded && rows.length > 0 && rows.every((r) => expanded.has(r.id)) && allTickerGroupsExpanded;

  const toggleExpandAll = useCallback(() => {
    const allTickerKeys = new Set<string>();
    for (const r of rows) allTickerKeys.add(r.asset.ticker);

    if (isGrouped) {
      if (allGroupsExpanded && rows.every((r) => expanded.has(r.id)) && allTickerGroupsExpanded) {
        setExpandedGroups(new Set());
        setExpanded(new Set());
        setExpandedTickerGroups(new Set());
      } else {
        const groupKeys = groupMode === "type"
          ? typeGroups.map((g) => g.category)
          : groupMode === "broker"
          ? brokerGroups.map((g) => g.brokerName)
          : groupMode === "currency"
          ? currencyGroups.map((g) => g.currency)
          : subcategoryGroups.map((g) => g.subcategory);
        setExpandedGroups(new Set(groupKeys));
        setExpanded(new Set(rows.map((r) => r.id)));
        if (groupMode === "type") setExpandedTickerGroups(allTickerKeys);
      }
    } else {
      const isFullyExpanded = rows.every((r) => expanded.has(r.id)) && allTickerGroupsExpanded;
      if (isFullyExpanded) {
        setExpanded(new Set());
        setExpandedTickerGroups(new Set());
      } else {
        setExpanded(new Set(rows.map((r) => r.id)));
        setExpandedTickerGroups(allTickerKeys);
      }
    }
  }, [rows, typeGroups, brokerGroups, currencyGroups, subcategoryGroups, groupMode, isGrouped, allGroupsExpanded, expanded, allTickerGroupsExpanded]);

  const toggleGroupExpand = useCallback((groupKey: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }, []);

  const toggleTickerGroupExpand = useCallback((ticker: string) => {
    setExpandedTickerGroups((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
  }, []);

  /** Expand / collapse all direct-child assets inside a single group.
   *  When `tickers` is provided, also toggle those ticker-groups so the
   *  user can expand/collapse everything in one click. */
  const toggleGroupItems = useCallback((assetIds: string[], tickers?: string[]) => {
    const allAssetsOpen = assetIds.every((id) => expanded.has(id));
    const allTickersOpen = !tickers?.length || tickers.every((t) => expandedTickerGroups.has(t));
    const shouldCollapse = allAssetsOpen && allTickersOpen;

    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of assetIds) {
        if (shouldCollapse) next.delete(id);
        else next.add(id);
      }
      return next;
    });

    if (tickers?.length) {
      setExpandedTickerGroups((prev) => {
        const next = new Set(prev);
        for (const t of tickers) {
          if (shouldCollapse) next.delete(t);
          else next.add(t);
        }
        return next;
      });
    }
  }, [expanded, expandedTickerGroups]);

  // Ticker groups for flat mode: merge multi-variant groups + singles into sorted list
  // When sorting by currency, dissolve ticker groups so each exchange listing
  // lands in its correct currency position (e.g. VUAA.MI→EUR, VUAA.L→USD)
  const flatItems = useMemo(() => {
    if (groupMode !== "flat") return [];

    if (sortKey === "currency") {
      const items: FlatItem[] = rows.map((r) => ({
        kind: "single" as const, row: r, value: r.valueBase,
      }));
      return sortFlatItems(items, sortKey, sortDir);
    }

    const { groups: tGroups, singles } = buildTickerGroups(rows);
    const items: FlatItem[] = [
      ...tGroups.map((g) => ({ kind: "ticker-group" as const, group: g, value: g.totalValueBase })),
      ...singles.map((r) => ({ kind: "single" as const, row: r, value: r.valueBase })),
    ];
    return sortFlatItems(items, sortKey, sortDir);
  }, [groupMode, rows, sortKey, sortDir]);

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
  } = useColumnConfig("colConfig:stocks", columns, 7);

  const ctx: RenderContext = { primaryCurrency, fxRates };

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
                Total Equities
              </p>
              <p className="text-2xl font-semibold text-zinc-100 mt-1 tabular-nums">
                {formatCurrency(totalPortfolioValue, primaryCurrency)}
              </p>
              {weighted24hChange !== 0 && (() => {
                const delta = totalPortfolioValue - totalPortfolioValue / (1 + weighted24hChange / 100);
                return (
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`text-xs tabular-nums ${weighted24hChange >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {weighted24hChange >= 0 ? "+" : ""}{weighted24hChange.toFixed(2)}%
                    </span>
                    <span className={`text-xs tabular-nums ${weighted24hChange >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      ({delta >= 0 ? "+" : ""}{formatCurrency(delta, primaryCurrency)})
                    </span>
                    <span className="text-xs text-zinc-600">24h</span>
                  </div>
                );
              })()}
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
                    setExpanded(new Set());
                    setExpandedTickerGroups(new Set());
                    if (next === "flat") {
                      setExpandedGroups(new Set());
                    } else {
                      const groupKeys =
                        next === "type" ? buildStockGroupRows(rows).map(g => g.category)
                        : next === "broker" ? buildStockBrokerGroups(rows).map(g => g.brokerName)
                        : next === "currency" ? buildStockCurrencyGroups(rows).map(g => g.currency)
                        : buildStockSubcategoryGroups(rows).map(g => g.subcategory);
                      setExpandedGroups(new Set(groupKeys));
                    }
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
                      {groupMode === "type" ? "Type" : groupMode === "broker" ? "Broker" : groupMode === "currency" ? "Currency" : "Subtype"}
                    </span>
                  )}
                </button>
                {/* Mobile sort cycle (no column headers on mobile) */}
                {assets.length > 1 && (
                  <button
                    onClick={handleCycleSort}
                    className="md:hidden p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                    title={`Sort: ${SORT_OPTIONS.find((o) => o.key === sortKey)?.label}`}
                  >
                    <div className="flex items-center gap-1">
                      <ArrowUpDown className="w-3.5 h-3.5" />
                      <span className="text-[10px] font-medium">
                        {SORT_OPTIONS.find((o) => o.key === sortKey)?.label}
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
            {groupMode === "type"
              ? typeGroups.map((group) => {
                  const isGroupOpen = expandedGroups.has(group.category);
                  const groupAssetIds = group.rows.map((r) => r.asset.id);
                  const groupTickers = [...new Set(group.rows.map((r) => r.asset.ticker))];
                  const allItemsExpanded = groupAssetIds.length > 0 && groupAssetIds.every((id) => expanded.has(id)) && groupTickers.every((t) => expandedTickerGroups.has(t));
                  return (
                    <div key={`mgroup:${group.category}`}>
                      <button
                        onClick={() => toggleGroupExpand(group.category)}
                        className="w-full flex items-center gap-2 px-3 py-2 mb-1 rounded-lg bg-zinc-800/40 border-l-2 border-l-blue-500/40"
                      >
                        {isGroupOpen ? (
                          <ChevronDown className="w-3 h-3 text-zinc-500" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-zinc-500" />
                        )}
                        <span className={`text-sm font-semibold uppercase tracking-wider ${group.color}`}>
                          {group.label}
                        </span>
                        <span className="text-[11px] text-zinc-600">
                          ({group.assetCount})
                        </span>
                        <span className="ml-auto text-xs font-medium text-zinc-400 tabular-nums">
                          {formatCurrency(group.totalValue, primaryCurrency)}
                        </span>
                      </button>

                      {isGroupOpen && (
                        <>
                        <div className="flex justify-end ml-6">
                          <button
                            onClick={() => toggleGroupItems(groupAssetIds, groupTickers)}
                            className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-zinc-400 hover:text-zinc-200 bg-zinc-800/50 hover:bg-zinc-700/50 transition-colors"
                          >
                            {allItemsExpanded ? <ChevronsDownUp className="w-3.5 h-3.5" /> : <ChevronsUpDown className="w-3.5 h-3.5" />}
                            <span>{allItemsExpanded ? "Collapse all" : "Expand all"}</span>
                          </button>
                        </div>
                        <MobileTypeGroupInner
                          groupRows={group.rows}
                          expanded={expanded}
                          toggleExpand={toggleExpand}
                          expandedTickerGroups={expandedTickerGroups}
                          toggleTickerGroupExpand={toggleTickerGroupExpand}
                          handleEdit={handleEdit}
                          handleDelete={handleDelete}
                          primaryCurrency={primaryCurrency}
                          fxRates={fxRates}
                          sortKey={sortKey}
                          sortDir={sortDir}
                        />
                        </>
                      )}
                    </div>
                  );
                })
              : groupMode === "broker"
              ? brokerGroups.map((group, gi) => {
                  const isGroupOpen = expandedGroups.has(group.brokerName);
                  const groupColor = GROUP_PALETTE[gi % GROUP_PALETTE.length];
                  const groupAssetIds = group.entries.map((e) => e.row.asset.id);
                  const allItemsExpanded = groupAssetIds.length > 0 && groupAssetIds.every((id) => expanded.has(id));
                  return (
                    <div key={`mgroup:broker:${group.brokerName}`}>
                      <button
                        onClick={() => toggleGroupExpand(group.brokerName)}
                        className="w-full flex items-center gap-2 px-3 py-2 mb-1 rounded-lg bg-zinc-800/40 border-l-2 border-l-blue-500/40"
                      >
                        {isGroupOpen ? (
                          <ChevronDown className="w-3 h-3 text-zinc-500" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-zinc-500" />
                        )}
                        <span className={`text-sm font-semibold uppercase tracking-wider ${groupColor}`}>
                          {group.brokerName}
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
                          <div className="flex justify-end">
                            <button
                              onClick={() => toggleGroupItems(groupAssetIds)}
                              className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-zinc-400 hover:text-zinc-200 bg-zinc-800/50 hover:bg-zinc-700/50 transition-colors"
                            >
                              {allItemsExpanded ? <ChevronsDownUp className="w-3.5 h-3.5" /> : <ChevronsUpDown className="w-3.5 h-3.5" />}
                              <span>{allItemsExpanded ? "Collapse all" : "Expand all"}</span>
                            </button>
                          </div>
                          {group.entries.map((entry) => (
                            <MobileStockCard
                              key={`${group.brokerName}:${entry.row.id}`}
                              row={entry.row}
                              expanded={expanded.has(entry.row.asset.id)}
                              toggleExpand={toggleExpand}
                              handleEdit={handleEdit}
                              handleDelete={handleDelete}
                              primaryCurrency={primaryCurrency}
                              fxRates={fxRates}
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
              : groupMode === "currency"
              ? currencyGroups.map((group) => {
                  const isGroupOpen = expandedGroups.has(group.currency);
                  const groupColor = getCurrencyColor(group.currency);
                  const groupAssetIds = group.rows.map((r) => r.asset.id);
                  const allItemsExpanded = groupAssetIds.length > 0 && groupAssetIds.every((id) => expanded.has(id));
                  return (
                    <div key={`mgroup:cur:${group.currency}`}>
                      <button
                        onClick={() => toggleGroupExpand(group.currency)}
                        className="w-full flex items-center gap-2 px-3 py-2 mb-1 rounded-lg bg-zinc-800/40 border-l-2 border-l-blue-500/40"
                      >
                        {isGroupOpen ? (
                          <ChevronDown className="w-3 h-3 text-zinc-500" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-zinc-500" />
                        )}
                        <span className={`text-sm font-semibold uppercase tracking-wider ${groupColor}`}>
                          {group.currency}
                        </span>
                        <span className="text-[11px] text-zinc-600">
                          ({group.assetCount})
                        </span>
                        <span className="ml-auto text-xs font-medium text-zinc-400 tabular-nums">
                          {formatCurrency(group.totalValue, primaryCurrency)}
                        </span>
                      </button>

                      {isGroupOpen && (
                        <div className="space-y-2 ml-6">
                          <div className="flex justify-end">
                            <button
                              onClick={() => toggleGroupItems(groupAssetIds)}
                              className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-zinc-400 hover:text-zinc-200 bg-zinc-800/50 hover:bg-zinc-700/50 transition-colors"
                            >
                              {allItemsExpanded ? <ChevronsDownUp className="w-3.5 h-3.5" /> : <ChevronsUpDown className="w-3.5 h-3.5" />}
                              <span>{allItemsExpanded ? "Collapse all" : "Expand all"}</span>
                            </button>
                          </div>
                          {sortRows(group.rows, sortKey, sortDir).map((row) => (
                            <MobileStockCard
                              key={row.id}
                              row={row}
                              expanded={expanded.has(row.asset.id)}
                              toggleExpand={toggleExpand}
                              handleEdit={handleEdit}
                              handleDelete={handleDelete}
                              primaryCurrency={primaryCurrency}
                              fxRates={fxRates}
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
                  const groupColor = group.isUncategorized
                    ? "text-zinc-500"
                    : GROUP_PALETTE[gi % GROUP_PALETTE.length];
                  const groupAssetIds = group.rows.map((r) => r.asset.id);
                  const allItemsExpanded = groupAssetIds.length > 0 && groupAssetIds.every((id) => expanded.has(id));
                  return (
                    <div key={`mgroup:sub:${group.subcategory}`}>
                      <button
                        onClick={() => toggleGroupExpand(group.subcategory)}
                        className="w-full flex items-center gap-2 px-3 py-2 mb-1 rounded-lg bg-zinc-800/40 border-l-2 border-l-blue-500/40"
                      >
                        {isGroupOpen ? (
                          <ChevronDown className="w-3 h-3 text-zinc-500" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-zinc-500" />
                        )}
                        <span className={`text-sm font-semibold tracking-wider ${groupColor} ${group.isUncategorized ? "italic" : "uppercase"}`}>
                          {group.subcategory}
                        </span>
                        <span className="text-[11px] text-zinc-600">
                          ({group.assetCount})
                        </span>
                        <span className="ml-auto text-xs font-medium text-zinc-400 tabular-nums">
                          {formatCurrency(group.totalValue, primaryCurrency)}
                        </span>
                      </button>

                      {isGroupOpen && (
                        <div className="space-y-2 ml-6">
                          <div className="flex justify-end">
                            <button
                              onClick={() => toggleGroupItems(groupAssetIds)}
                              className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-zinc-400 hover:text-zinc-200 bg-zinc-800/50 hover:bg-zinc-700/50 transition-colors"
                            >
                              {allItemsExpanded ? <ChevronsDownUp className="w-3.5 h-3.5" /> : <ChevronsUpDown className="w-3.5 h-3.5" />}
                              <span>{allItemsExpanded ? "Collapse all" : "Expand all"}</span>
                            </button>
                          </div>
                          {sortRows(group.rows, sortKey, sortDir).map((row) => (
                            <MobileStockCard
                              key={row.id}
                              row={row}
                              expanded={expanded.has(row.asset.id)}
                              toggleExpand={toggleExpand}
                              handleEdit={handleEdit}
                              handleDelete={handleDelete}
                              primaryCurrency={primaryCurrency}
                              fxRates={fxRates}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              : flatItems.map((item) =>
                item.kind === "single" ? (
                  <MobileStockCard
                    key={item.row.id}
                    row={item.row}
                    expanded={expanded.has(item.row.asset.id)}
                    toggleExpand={toggleExpand}
                    handleEdit={handleEdit}
                    handleDelete={handleDelete}
                    primaryCurrency={primaryCurrency}
                    fxRates={fxRates}
                  />
                ) : (
                  <MobileTickerGroupCard
                    key={`mtg:${item.group.ticker}`}
                    group={item.group}
                    isOpen={expandedTickerGroups.has(item.group.ticker)}
                    toggleOpen={() => toggleTickerGroupExpand(item.group.ticker)}
                    expanded={expanded}
                    toggleExpand={toggleExpand}
                    handleEdit={handleEdit}
                    handleDelete={handleDelete}
                    primaryCurrency={primaryCurrency}
                    fxRates={fxRates}
                  />
                )
              )}
          </div>

          {/* ── Desktop table layout ── */}
          <div className="hidden md:block bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-x-auto">
            <table className="w-full min-w-[600px]">
              <thead>
                <tr className="border-b border-zinc-800/50">
                  {orderedColumns.map((col) => {
                    const align = col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left";
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
                        <span className={`inline-flex items-center gap-1 ${align === "text-right" ? "justify-end" : align === "text-center" ? "justify-center" : ""}`}>
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
                {groupMode === "type"
                  ? typeGroups.map((group) => {
                      const isGroupOpen = expandedGroups.has(group.category);
                      const groupAssetIds = group.rows.map((r) => r.asset.id);
                      const groupTickers = [...new Set(group.rows.map((r) => r.asset.ticker))];
                      const allItemsExpanded = groupAssetIds.length > 0 && groupAssetIds.every((id) => expanded.has(id)) && groupTickers.every((t) => expandedTickerGroups.has(t));
                      return (
                        <Fragment key={`group:${group.category}`}>
                          <tr
                            className="border-b border-zinc-800/30 border-l-2 border-l-blue-500/40 bg-zinc-900/80 cursor-pointer hover:bg-zinc-800/40 transition-colors"
                            onClick={() => toggleGroupExpand(group.category)}
                          >
                            <td colSpan={orderedColumns.length - 1} className="px-4 py-2.5">
                              <div className="flex items-center gap-2">
                                {isGroupOpen ? (
                                  <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
                                ) : (
                                  <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />
                                )}
                                <span className={`text-sm font-semibold uppercase tracking-wider ${group.color}`}>
                                  {group.label}
                                </span>
                                <span className="text-[11px] text-zinc-600">
                                  {group.assetCount} asset{group.assetCount !== 1 ? "s" : ""}
                                </span>
                                {isGroupOpen && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); toggleGroupItems(groupAssetIds, groupTickers); }}
                                    className="p-0.5 rounded hover:bg-zinc-700/50 text-zinc-600 hover:text-zinc-400 transition-colors"
                                    title={allItemsExpanded ? "Collapse items" : "Expand items"}
                                  >
                                    {allItemsExpanded ? <ChevronsDownUp className="w-3 h-3" /> : <ChevronsUpDown className="w-3 h-3" />}
                                  </button>
                                )}
                                <span className="ml-auto text-xs font-medium text-zinc-400 tabular-nums">
                                  {formatCurrency(group.totalValue, primaryCurrency)}
                                </span>
                              </div>
                            </td>
                            <td />
                          </tr>

                          {isGroupOpen && <TypeGroupInnerRows
                            groupRows={group.rows}
                            expanded={expanded}
                            toggleExpand={toggleExpand}
                            expandedTickerGroups={expandedTickerGroups}
                            toggleTickerGroupExpand={toggleTickerGroupExpand}
                            orderedColumns={orderedColumns}
                            ctx={ctx}
                            primaryCurrency={primaryCurrency}
                            fxRates={fxRates}
                            sortKey={sortKey}
                            sortDir={sortDir}
                          />}
                        </Fragment>
                      );
                    })
                  : groupMode === "broker"
                  ? brokerGroups.map((group, gi) => {
                      const isGroupOpen = expandedGroups.has(group.brokerName);
                      const groupColor = GROUP_PALETTE[gi % GROUP_PALETTE.length];
                      const groupAssetIds = group.entries.map((e) => e.row.asset.id);
                      const allItemsExpanded = groupAssetIds.length > 0 && groupAssetIds.every((id) => expanded.has(id));
                      return (
                        <Fragment key={`group:broker:${group.brokerName}`}>
                          <tr
                            className="border-b border-zinc-800/30 border-l-2 border-l-blue-500/40 bg-zinc-900/80 cursor-pointer hover:bg-zinc-800/40 transition-colors"
                            onClick={() => toggleGroupExpand(group.brokerName)}
                          >
                            <td colSpan={orderedColumns.length - 1} className="px-4 py-2.5">
                              <div className="flex items-center gap-2">
                                {isGroupOpen ? (
                                  <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
                                ) : (
                                  <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />
                                )}
                                <span className={`text-sm font-semibold uppercase tracking-wider ${groupColor}`}>
                                  {group.brokerName}
                                </span>
                                <span className="text-[11px] text-zinc-600">
                                  {group.entryCount} asset{group.entryCount !== 1 ? "s" : ""}
                                </span>
                                {isGroupOpen && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); toggleGroupItems(groupAssetIds); }}
                                    className="p-0.5 rounded hover:bg-zinc-700/50 text-zinc-600 hover:text-zinc-400 transition-colors"
                                    title={allItemsExpanded ? "Collapse items" : "Expand items"}
                                  >
                                    {allItemsExpanded ? <ChevronsDownUp className="w-3 h-3" /> : <ChevronsUpDown className="w-3 h-3" />}
                                  </button>
                                )}
                                <span className="ml-auto text-xs font-medium text-zinc-400 tabular-nums">
                                  {formatCurrency(group.totalValue, primaryCurrency)}
                                </span>
                              </div>
                            </td>
                            <td />
                          </tr>

                          {/* Broker group child rows (position-level) */}
                          {isGroupOpen &&
                            group.entries.map((entry) => {
                              const { row } = entry;
                              const rowExpanded = expanded.has(row.asset.id);
                              return (
                                <Fragment key={`${group.brokerName}:${row.id}`}>
                                  <tr className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors">
                                    {orderedColumns.map((col, ci) => {
                                      const align = col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left";
                                      const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";
                                      const pl = ci === 0 ? "pl-12 pr-4" : "px-4";
                                      // Override shares/value for per-broker values
                                      if (col.key === "shares") {
                                        return (
                                          <td key={col.key} className={`${pl} py-3 text-right ${hidden}`}>
                                            <span className="text-sm text-zinc-300 tabular-nums">
                                              {entry.groupQty > 0 ? formatQuantity(entry.groupQty, 4) : "—"}
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
                                      return (
                                        <td key={col.key} className={`${pl} py-3 ${align} ${hidden}`}>
                                          {col.renderCell(row, ctx)}
                                        </td>
                                      );
                                    })}
                                  </tr>

                                  {rowExpanded && entry.positions.length > 0 &&
                                    entry.positions.map((pos) => {
                                      const posValueNative = pos.quantity * row.pricePerShare;
                                      const posValueBase = convertToBase(posValueNative, row.asset.currency, primaryCurrency, fxRates);
                                      return (
                                        <ExpandedStockRow
                                          key={pos.id}
                                          brokerName={pos.broker_name}
                                          quantity={formatQuantity(pos.quantity, 4)}
                                          value={posValueBase > 0 ? formatCurrency(posValueBase, primaryCurrency) : "—"}
                                          orderedColumns={orderedColumns}
                                          grouped
                                        />
                                      );
                                    })}

                                  {rowExpanded && entry.positions.length === 0 && (
                                    <tr className="bg-zinc-950/50 border-b border-zinc-800/20">
                                      <td colSpan={orderedColumns.length} className="pl-10 pr-4 py-3">
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
                  : groupMode === "currency"
                  ? currencyGroups.map((group) => {
                      const isGroupOpen = expandedGroups.has(group.currency);
                      const groupColor = getCurrencyColor(group.currency);
                      const groupAssetIds = group.rows.map((r) => r.asset.id);
                      const allItemsExpanded = groupAssetIds.length > 0 && groupAssetIds.every((id) => expanded.has(id));
                      return (
                        <Fragment key={`group:cur:${group.currency}`}>
                          <tr
                            className="border-b border-zinc-800/30 border-l-2 border-l-blue-500/40 bg-zinc-900/80 cursor-pointer hover:bg-zinc-800/40 transition-colors"
                            onClick={() => toggleGroupExpand(group.currency)}
                          >
                            <td colSpan={orderedColumns.length - 1} className="px-4 py-2.5">
                              <div className="flex items-center gap-2">
                                {isGroupOpen ? (
                                  <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
                                ) : (
                                  <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />
                                )}
                                <span className={`text-sm font-semibold uppercase tracking-wider ${groupColor}`}>
                                  {group.currency}
                                </span>
                                <span className="text-[11px] text-zinc-600">
                                  {group.assetCount} asset{group.assetCount !== 1 ? "s" : ""}
                                </span>
                                {isGroupOpen && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); toggleGroupItems(groupAssetIds); }}
                                    className="p-0.5 rounded hover:bg-zinc-700/50 text-zinc-600 hover:text-zinc-400 transition-colors"
                                    title={allItemsExpanded ? "Collapse items" : "Expand items"}
                                  >
                                    {allItemsExpanded ? <ChevronsDownUp className="w-3 h-3" /> : <ChevronsUpDown className="w-3 h-3" />}
                                  </button>
                                )}
                                <span className="ml-auto text-xs font-medium text-zinc-400 tabular-nums">
                                  {formatCurrency(group.totalValue, primaryCurrency)}
                                </span>
                              </div>
                            </td>
                            <td />
                          </tr>

                          {isGroupOpen &&
                            sortRows(group.rows, sortKey, sortDir).map((row) => {
                              const rowExpanded = expanded.has(row.asset.id);
                              return (
                                <Fragment key={row.id}>
                                  <tr className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors">
                                    {orderedColumns.map((col, ci) => {
                                      const align = col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left";
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
                                      const posValueNative = pos.quantity * row.pricePerShare;
                                      const posValueBase = convertToBase(posValueNative, row.asset.currency, primaryCurrency, fxRates);
                                      return (
                                        <ExpandedStockRow
                                          key={pos.id}
                                          brokerName={pos.broker_name}
                                          quantity={formatQuantity(pos.quantity, 4)}
                                          value={posValueBase > 0 ? formatCurrency(posValueBase, primaryCurrency) : "—"}
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
                      const groupColor = group.isUncategorized
                        ? "text-zinc-500"
                        : GROUP_PALETTE[gi % GROUP_PALETTE.length];
                      const groupAssetIds = group.rows.map((r) => r.asset.id);
                      const allItemsExpanded = groupAssetIds.length > 0 && groupAssetIds.every((id) => expanded.has(id));
                      return (
                        <Fragment key={`group:sub:${group.subcategory}`}>
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
                                <span className={`text-sm font-semibold tracking-wider ${groupColor} ${group.isUncategorized ? "italic" : "uppercase"}`}>
                                  {group.subcategory}
                                </span>
                                <span className="text-[11px] text-zinc-600">
                                  {group.assetCount} asset{group.assetCount !== 1 ? "s" : ""}
                                </span>
                                {isGroupOpen && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); toggleGroupItems(groupAssetIds); }}
                                    className="p-0.5 rounded hover:bg-zinc-700/50 text-zinc-600 hover:text-zinc-400 transition-colors"
                                    title={allItemsExpanded ? "Collapse items" : "Expand items"}
                                  >
                                    {allItemsExpanded ? <ChevronsDownUp className="w-3 h-3" /> : <ChevronsUpDown className="w-3 h-3" />}
                                  </button>
                                )}
                                <span className="ml-auto text-xs font-medium text-zinc-400 tabular-nums">
                                  {formatCurrency(group.totalValue, primaryCurrency)}
                                </span>
                              </div>
                            </td>
                            <td />
                          </tr>

                          {isGroupOpen &&
                            sortRows(group.rows, sortKey, sortDir).map((row) => {
                              const rowExpanded = expanded.has(row.asset.id);
                              return (
                                <Fragment key={row.id}>
                                  <tr className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors">
                                    {orderedColumns.map((col, ci) => {
                                      const align = col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left";
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
                                      const posValueNative = pos.quantity * row.pricePerShare;
                                      const posValueBase = convertToBase(posValueNative, row.asset.currency, primaryCurrency, fxRates);
                                      return (
                                        <ExpandedStockRow
                                          key={pos.id}
                                          brokerName={pos.broker_name}
                                          quantity={formatQuantity(pos.quantity, 4)}
                                          value={posValueBase > 0 ? formatCurrency(posValueBase, primaryCurrency) : "—"}
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
                  : flatItems.map((item) =>
                      item.kind === "single" ? (
                        <FlatSingleRow
                          key={item.row.id}
                          row={item.row}
                          expanded={expanded}
                          orderedColumns={orderedColumns}
                          ctx={ctx}
                          primaryCurrency={primaryCurrency}
                          fxRates={fxRates}
                        />
                      ) : (
                        <TickerGroupRows
                          key={`tg:${item.group.ticker}`}
                          group={item.group}
                          isOpen={expandedTickerGroups.has(item.group.ticker)}
                          toggleOpen={() => toggleTickerGroupExpand(item.group.ticker)}
                          expanded={expanded}
                          toggleExpand={toggleExpand}
                          orderedColumns={orderedColumns}
                          ctx={ctx}
                          primaryCurrency={primaryCurrency}
                          fxRates={fxRates}
                          headerPl="px-4"
                          variantPl="pl-10 pr-4"
                        />
                      )
                    )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Modals */}
      <AddStockModal open={addOpen} onClose={() => setAddOpen(false)} brokers={brokers} existingSubcategories={existingSubcategories} existingTags={existingTags} />
      {editingAsset && (
        <StockPositionEditor
          open={!!editingAsset}
          onClose={() => setEditingAsset(null)}
          asset={editingAsset}
          brokers={brokers}
          existingSubcategories={existingSubcategories}
          existingTags={existingTags}
        />
      )}
    </div>
  );
}

// ── Mobile card (extracted for reuse in flat + grouped mode) ──

function MobileStockCard({
  row,
  expanded: isExpanded,
  toggleExpand,
  handleEdit,
  handleDelete,
  primaryCurrency,
  fxRates,
  overrideQty,
  overrideValue,
  groupPositions,
  isVariant,
}: {
  row: StockRow;
  expanded: boolean;
  toggleExpand: (id: string) => void;
  handleEdit: (asset: StockAssetWithPositions) => void;
  handleDelete: (id: string, name: string) => void;
  primaryCurrency: string;
  fxRates: FXRates;
  overrideQty?: number;
  overrideValue?: number;
  groupPositions?: StockAssetWithPositions["positions"];
  isVariant?: boolean;
}) {
  const displayQty = overrideQty ?? row.totalQty;
  const displayValue = overrideValue ?? row.valueBase;
  const displayPositions = groupPositions ?? row.asset.positions;

  return (
    <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
      {/* Card header — tap to expand */}
      <button
        onClick={() => toggleExpand(row.asset.id)}
        className="w-full px-4 py-3 flex items-center justify-between overflow-hidden"
      >
        <div className="text-left min-w-0">
          {isVariant ? (
            <>
              <p className="text-xs font-medium text-zinc-300 truncate">
                {row.asset.yahoo_ticker || row.asset.ticker}
              </p>
              <p className="text-[11px] text-zinc-600">
                {row.asset.currency}
                {row.asset.isin && ` · ${row.asset.isin}`}
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-zinc-200 truncate">
                {row.asset.name}
              </p>
              <p className="text-xs text-zinc-500 uppercase">{row.asset.ticker}</p>
            </>
          )}
        </div>
        <div className="text-right shrink-0 ml-3">
          <p className="text-sm font-semibold text-zinc-100 tabular-nums">
            {displayValue > 0 ? formatCurrency(displayValue, primaryCurrency) : "—"}
          </p>
          {row.change24h !== 0 && (
            <p className={`text-xs tabular-nums ${row.change24h >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {row.change24h >= 0 ? "+" : ""}{row.change24h.toFixed(2)}%
            </p>
          )}
        </div>
      </button>

      {/* Expanded details */}
      {isExpanded && (
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
              <p className="text-zinc-500 tabular-nums">
                {displayQty > 0 ? formatQuantity(displayQty, 4) : "—"}
              </p>
            </div>
            <div>
              <span className="text-zinc-500">Type</span>
              <p className={TYPE_COLORS[row.asset.category]}>
                {TYPE_LABELS[row.asset.category]}
              </p>
            </div>
            <div>
              <span className="text-zinc-500">Value ({primaryCurrency})</span>
              <p className="font-semibold text-zinc-100 tabular-nums">
                {displayValue > 0 ? formatCurrency(displayValue, primaryCurrency) : "—"}
              </p>
            </div>
          </div>

          {/* Broker breakdown */}
          {displayPositions.length > 0 && (
            <div className="mt-3 pt-2 border-t border-zinc-800/20 space-y-1">
              {displayPositions.map((pos) => {
                const posValueNative = pos.quantity * row.pricePerShare;
                const posValueBase = convertToBase(posValueNative, row.asset.currency, primaryCurrency, fxRates);
                return (
                  <div key={pos.id} className="flex justify-between text-xs">
                    <span className="text-zinc-500">{pos.broker_name}</span>
                    <span className="text-zinc-400 tabular-nums">
                      {formatQuantity(pos.quantity, 4)} · {posValueBase > 0 ? formatCurrency(posValueBase, primaryCurrency) : "—"}
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
}

// ── Expanded sub-row ─────────────────────────────────────────
// Renders broker name under the Asset column, quantity under Shares,
// value under Value, and empty cells for everything else.

function ExpandedStockRow({
  brokerName,
  quantity,
  value,
  orderedColumns,
  grouped,
}: {
  brokerName: string;
  quantity: string;
  value: string;
  orderedColumns: ColumnDef<StockRow>[];
  grouped?: boolean;
}) {
  const assetPl = grouped ? "pl-16" : "pl-10";

  return (
    <tr className="bg-zinc-950/50 border-b border-zinc-800/20">
      {orderedColumns.map((col) => {
        const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";

        if (col.key === "asset") {
          return (
            <td key={col.key} className={`${assetPl} pr-4 py-2`}>
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

// ── Flat mode: single row (no ticker group) ─────────────────

function FlatSingleRow({
  row,
  expanded,
  orderedColumns,
  ctx,
  primaryCurrency,
  fxRates,
}: {
  row: StockRow;
  expanded: Set<string>;
  orderedColumns: ColumnDef<StockRow>[];
  ctx: RenderContext;
  primaryCurrency: string;
  fxRates: FXRates;
}) {
  const rowExpanded = expanded.has(row.asset.id);
  return (
    <Fragment>
      <tr className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors">
        {orderedColumns.map((col) => {
          const align = col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left";
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
              quantity={formatQuantity(pos.quantity, 4)}
              value={posValueBase > 0 ? formatCurrency(posValueBase, primaryCurrency) : "—"}
              orderedColumns={orderedColumns}
            />
          );
        })}
      {rowExpanded && row.asset.positions.length === 0 && (
        <tr className="bg-zinc-950/50 border-b border-zinc-800/20">
          <td colSpan={orderedColumns.length} className="pl-10 pr-4 py-3">
            <p className="text-xs text-zinc-600">
              No positions — click edit to add quantities
            </p>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// ── Desktop: ticker group header + variant rows ─────────────

function TickerGroupRows({
  group,
  isOpen,
  toggleOpen,
  expanded,
  toggleExpand,
  orderedColumns,
  ctx,
  primaryCurrency,
  fxRates,
  headerPl,
  variantPl,
}: {
  group: TickerGroup;
  isOpen: boolean;
  toggleOpen: () => void;
  expanded: Set<string>;
  toggleExpand: (id: string) => void;
  orderedColumns: ColumnDef<StockRow>[];
  ctx: RenderContext;
  primaryCurrency: string;
  fxRates: FXRates;
  headerPl: string;   // "px-4" for flat, "pl-12" for inside type groups
  variantPl: string;   // "pl-10 pr-4" for flat, "pl-16 pr-4" for inside type groups
}) {
  return (
    <Fragment>
      {/* Ticker group header */}
      <tr
        className="border-b border-zinc-800/30 border-l-2 border-l-zinc-500/30 bg-zinc-900/80 cursor-pointer hover:bg-zinc-800/40 transition-colors"
        onClick={toggleOpen}
      >
        <td colSpan={orderedColumns.length - 1} className={`${headerPl} py-3`}>
          <div className="flex items-center gap-2">
            {isOpen ? (
              <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            )}
            <span className="text-sm font-semibold text-zinc-100">{group.name}</span>
            <span className="text-xs text-zinc-500 uppercase">{group.ticker}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">
              {group.rows.length} listings
            </span>
            <span
              className={`text-xs tabular-nums ${
                group.weightedChange24h >= 0 ? "text-emerald-400" : "text-red-400"
              }`}
            >
              {group.weightedChange24h >= 0 ? "+" : ""}
              {group.weightedChange24h.toFixed(2)}%
            </span>
            <span className="ml-auto text-sm font-semibold text-zinc-100 tabular-nums">
              {formatCurrency(group.totalValueBase, primaryCurrency)}
            </span>
          </div>
        </td>
        <td />
      </tr>

      {/* Variant rows (one per exchange listing) — visually lighter than header */}
      {isOpen &&
        group.rows.map((row) => {
          const rowExpanded = expanded.has(row.asset.id);
          return (
            <Fragment key={row.id}>
              <tr className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors opacity-85">
                {orderedColumns.map((col, ci) => {
                  const align = col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left";
                  const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";
                  const pl = ci === 0 ? variantPl : "px-4";

                  if (col.key === "asset") {
                    return (
                      <td key={col.key} className={`${pl} py-2.5`}>
                        <button
                          onClick={() => toggleExpand(row.asset.id)}
                          className="flex items-center gap-2 text-left min-w-0"
                        >
                          {rowExpanded ? (
                            <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
                          ) : (
                            <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />
                          )}
                          <div className="min-w-0">
                            <span className="text-xs font-medium text-zinc-300 truncate block">
                              {row.asset.yahoo_ticker || row.asset.ticker}
                            </span>
                            <span className="text-[11px] text-zinc-600">
                              {row.asset.currency}
                              {row.asset.isin && ` · ${row.asset.isin}`}
                            </span>
                          </div>
                        </button>
                      </td>
                    );
                  }

                  return (
                    <td key={col.key} className={`${pl} py-2.5 ${align} ${hidden}`}>
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
                      quantity={formatQuantity(pos.quantity, 4)}
                      value={posValueBase > 0 ? formatCurrency(posValueBase, primaryCurrency) : "—"}
                      orderedColumns={orderedColumns}
                      grouped
                    />
                  );
                })}

              {rowExpanded && row.asset.positions.length === 0 && (
                <tr className="bg-zinc-950/50 border-b border-zinc-800/20">
                  <td colSpan={orderedColumns.length} className="pl-14 pr-4 py-3">
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
}

// ── Desktop: type-group inner rows (with ticker grouping) ───

function TypeGroupInnerRows({
  groupRows,
  expanded,
  toggleExpand,
  expandedTickerGroups,
  toggleTickerGroupExpand,
  orderedColumns,
  ctx,
  primaryCurrency,
  fxRates,
  sortKey: sk,
  sortDir: sd,
}: {
  groupRows: StockRow[];
  expanded: Set<string>;
  toggleExpand: (id: string) => void;
  expandedTickerGroups: Set<string>;
  toggleTickerGroupExpand: (ticker: string) => void;
  orderedColumns: ColumnDef<StockRow>[];
  ctx: RenderContext;
  primaryCurrency: string;
  fxRates: FXRates;
  sortKey: SortKey;
  sortDir: SortDirection;
}) {
  const { groups: innerTGs, singles } = buildTickerGroups(groupRows);

  // Fast path: no multi-ticker groups, or sorting by currency dissolves groups
  if (innerTGs.length === 0 || sk === "currency") {
    const sorted = sortRows(groupRows, sk, sd);
    return (
      <>
        {sorted.map((row) => {
          const rowExpanded = expanded.has(row.asset.id);
          return (
            <Fragment key={row.id}>
              <tr className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors">
                {orderedColumns.map((col, ci) => {
                  const align = col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left";
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
                  const posValueNative = pos.quantity * row.pricePerShare;
                  const posValueBase = convertToBase(posValueNative, row.asset.currency, primaryCurrency, fxRates);
                  return (
                    <ExpandedStockRow
                      key={pos.id}
                      brokerName={pos.broker_name}
                      quantity={formatQuantity(pos.quantity, 4)}
                      value={posValueBase > 0 ? formatCurrency(posValueBase, primaryCurrency) : "—"}
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
      </>
    );
  }

  // Merge ticker groups + singles, sorted by active sort
  const items: FlatItem[] = [
    ...innerTGs.map((g) => ({ kind: "ticker-group" as const, group: g, value: g.totalValueBase })),
    ...singles.map((r) => ({ kind: "single" as const, row: r, value: r.valueBase })),
  ];
  const sortedItems = sortFlatItems(items, sk, sd);

  return (
    <>
      {sortedItems.map((item) => {
        if (item.kind === "single") {
          const row = item.row;
          const rowExpanded = expanded.has(row.asset.id);
          return (
            <Fragment key={row.id}>
              <tr className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors">
                {orderedColumns.map((col, ci) => {
                  const align = col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left";
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
                  const posValueNative = pos.quantity * row.pricePerShare;
                  const posValueBase = convertToBase(posValueNative, row.asset.currency, primaryCurrency, fxRates);
                  return (
                    <ExpandedStockRow
                      key={pos.id}
                      brokerName={pos.broker_name}
                      quantity={formatQuantity(pos.quantity, 4)}
                      value={posValueBase > 0 ? formatCurrency(posValueBase, primaryCurrency) : "—"}
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
        }

        // Ticker group within type group (deeper indent)
        return (
          <TickerGroupRows
            key={`tg:${item.group.ticker}`}
            group={item.group}
            isOpen={expandedTickerGroups.has(item.group.ticker)}
            toggleOpen={() => toggleTickerGroupExpand(item.group.ticker)}
            expanded={expanded}
            toggleExpand={toggleExpand}
            orderedColumns={orderedColumns}
            ctx={ctx}
            primaryCurrency={primaryCurrency}
            fxRates={fxRates}
            headerPl="pl-12 pr-4"
            variantPl="pl-16 pr-4"
          />
        );
      })}
    </>
  );
}

// ── Mobile: ticker group card ───────────────────────────────

function MobileTickerGroupCard({
  group,
  isOpen,
  toggleOpen,
  expanded,
  toggleExpand,
  handleEdit,
  handleDelete,
  primaryCurrency,
  fxRates,
}: {
  group: TickerGroup;
  isOpen: boolean;
  toggleOpen: () => void;
  expanded: Set<string>;
  toggleExpand: (id: string) => void;
  handleEdit: (asset: StockAssetWithPositions) => void;
  handleDelete: (id: string, name: string) => void;
  primaryCurrency: string;
  fxRates: FXRates;
}) {
  return (
    <div>
      <button
        onClick={toggleOpen}
        className="w-full flex items-center gap-2 px-3 py-2.5 mb-1 rounded-lg bg-zinc-800/50 border-l-2 border-l-zinc-500/40"
      >
        {isOpen ? (
          <ChevronDown className="w-3 h-3 text-zinc-500" />
        ) : (
          <ChevronRight className="w-3 h-3 text-zinc-500" />
        )}
        <div className="text-left min-w-0">
          <span className="text-sm font-semibold text-zinc-100 truncate block">{group.name}</span>
          <span className="text-xs text-zinc-500 uppercase">
            {group.ticker}
            <span className="text-[10px] text-zinc-600 ml-1.5 normal-case">
              {group.rows.length} listings
            </span>
          </span>
        </div>
        <div className="ml-auto text-right shrink-0">
          <span className="text-sm font-semibold text-zinc-100 tabular-nums">
            {formatCurrency(group.totalValueBase, primaryCurrency)}
          </span>
          {group.weightedChange24h !== 0 && (
            <span
              className={`block text-xs tabular-nums ${
                group.weightedChange24h >= 0 ? "text-emerald-400" : "text-red-400"
              }`}
            >
              {group.weightedChange24h >= 0 ? "+" : ""}
              {group.weightedChange24h.toFixed(2)}%
            </span>
          )}
        </div>
      </button>

      {isOpen && (
        <div className="space-y-2 ml-6">
          {group.rows.map((row) => (
            <MobileStockCard
              key={row.id}
              row={row}
              expanded={expanded.has(row.asset.id)}
              toggleExpand={toggleExpand}
              handleEdit={handleEdit}
              handleDelete={handleDelete}
              primaryCurrency={primaryCurrency}
              fxRates={fxRates}
              isVariant
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Mobile: type-group inner cards (with ticker grouping) ───

function MobileTypeGroupInner({
  groupRows,
  expanded,
  toggleExpand,
  expandedTickerGroups,
  toggleTickerGroupExpand,
  handleEdit,
  handleDelete,
  primaryCurrency,
  fxRates,
  sortKey: sk,
  sortDir: sd,
}: {
  groupRows: StockRow[];
  expanded: Set<string>;
  toggleExpand: (id: string) => void;
  expandedTickerGroups: Set<string>;
  toggleTickerGroupExpand: (ticker: string) => void;
  handleEdit: (asset: StockAssetWithPositions) => void;
  handleDelete: (id: string, name: string) => void;
  primaryCurrency: string;
  fxRates: FXRates;
  sortKey: SortKey;
  sortDir: SortDirection;
}) {
  const { groups: innerTGs, singles } = buildTickerGroups(groupRows);

  // Fast path: no multi-ticker groups, or sorting by currency dissolves groups
  if (innerTGs.length === 0 || sk === "currency") {
    const sorted = sortRows(groupRows, sk, sd);
    return (
      <div className="space-y-2 ml-6">
        {sorted.map((row) => (
          <MobileStockCard
            key={row.id}
            row={row}
            expanded={expanded.has(row.asset.id)}
            toggleExpand={toggleExpand}
            handleEdit={handleEdit}
            handleDelete={handleDelete}
            primaryCurrency={primaryCurrency}
            fxRates={fxRates}
          />
        ))}
      </div>
    );
  }

  const items: FlatItem[] = [
    ...innerTGs.map((g) => ({ kind: "ticker-group" as const, group: g, value: g.totalValueBase })),
    ...singles.map((r) => ({ kind: "single" as const, row: r, value: r.valueBase })),
  ];
  const sortedItems = sortFlatItems(items, sk, sd);

  return (
    <div className="space-y-2 ml-6">
      {sortedItems.map((item) =>
        item.kind === "single" ? (
          <MobileStockCard
            key={item.row.id}
            row={item.row}
            expanded={expanded.has(item.row.asset.id)}
            toggleExpand={toggleExpand}
            handleEdit={handleEdit}
            handleDelete={handleDelete}
            primaryCurrency={primaryCurrency}
            fxRates={fxRates}
          />
        ) : (
          <MobileTickerGroupCard
            key={`mtg:${item.group.ticker}`}
            group={item.group}
            isOpen={expandedTickerGroups.has(item.group.ticker)}
            toggleOpen={() => toggleTickerGroupExpand(item.group.ticker)}
            expanded={expanded}
            toggleExpand={toggleExpand}
            handleEdit={handleEdit}
            handleDelete={handleDelete}
            primaryCurrency={primaryCurrency}
            fxRates={fxRates}
          />
        )
      )}
    </div>
  );
}
