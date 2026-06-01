"use client";

import { useState, useMemo, useCallback, Fragment } from "react";
import { Plus, Landmark, Coins, Pencil, Trash2, ChevronsDownUp, ChevronsUpDown, ChevronDown, ChevronRight } from "lucide-react";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { ColumnSettingsPopover } from "@/components/ui/column-settings-popover";
import { useColumnConfig } from "@/lib/hooks/use-column-config";
import { useTooltipDismiss } from "@/lib/hooks/use-tooltip-dismiss";
import { ChangeTooltip } from "@/components/ui/change-tooltip";
import { toast } from "sonner";
import { convertToBase } from "@/lib/prices/fx";
import type { FXRates } from "@/lib/prices/fx";
import { deleteCashAccount } from "@/lib/actions/cash-accounts";
import { CashAccountModal } from "@/components/cash/cash-account-modal";
import {
  getCashColumns,
  buildCashGroupRows,
  type CashRow,
} from "@/components/cash/cash-columns";
import { formatCurrency } from "@/lib/format";
import type { ColumnDef, RenderContext } from "@/lib/column-config";
import type {
  CashAccount,
  CryptoAssetWithPositions,
  CoinGeckoPriceData,
  Institution,
} from "@/lib/types";
import { countryName } from "@/lib/types";
import { HIDDEN_BELOW } from "@/lib/constants";
import { useSharedView } from "@/components/shared-view-context";

// ═══════════════════════════════════════════════════════════════
// Stablecoin wallet grouping types
// ═══════════════════════════════════════════════════════════════

interface StablecoinPositionInGroup {
  positionId: string;
  assetName: string;
  ticker: string;
  quantity: number;
  apy: number;
  valueInPrimary: number;
  pegCurrency: string;
}

interface StablecoinWalletGroup {
  walletName: string;
  positions: StablecoinPositionInGroup[];
  totalValue: number;
  weightedApy: number;
  pegCurrency: string;
}

// ═══════════════════════════════════════════════════════════════
// Main CashTable
// ═══════════════════════════════════════════════════════════════

interface CashTableProps {
  cashAccounts: CashAccount[];
  primaryCurrency: string;
  fxRates: FXRates;
  stablecoins?: CryptoAssetWithPositions[];
  stablecoinPrices?: CoinGeckoPriceData;
  /** Total cash 24h change % (FX + stablecoin movement) */
  cashChangePercent?: number;
  /** Total cash 24h absolute change in primary currency */
  cashChangeValue?: number;
  fxValueChange24h?: number;
  deposits?: number;
  depositBreakdown?: { name: string; value: number }[];
  /** Banks for the Add/Edit cash modal's bank picker (empty in read-only/share views). */
  institutions?: Institution[];
}

export function CashTable({
  cashAccounts,
  primaryCurrency,
  fxRates,
  stablecoins,
  stablecoinPrices,
  cashChangePercent = 0,
  cashChangeValue = 0,
  fxValueChange24h = 0,
  deposits = 0,
  depositBreakdown,
  institutions = [],
}: CashTableProps) {
  const { isReadOnly } = useSharedView();
  const { openTooltip, tooltipRef, toggleTooltip } = useTooltipDismiss();

  // ── Compute totals ──────────────────────────────────────
  const cashTotal = useMemo(
    () => cashAccounts.reduce(
      (sum, a) => sum + convertToBase(a.balance, a.currency, primaryCurrency, fxRates),
      0
    ),
    [cashAccounts, primaryCurrency, fxRates]
  );

  const currencyKey = primaryCurrency.toLowerCase() as "usd" | "eur";

  // Group stablecoins by wallet for expandable rows
  const stablecoinWalletGroups: StablecoinWalletGroup[] = useMemo(() => {
    if (!stablecoins || !stablecoinPrices) return [];

    // Flatten all positions with their asset info
    const allPositions: (StablecoinPositionInGroup & { walletName: string })[] = [];
    for (const asset of stablecoins) {
      const price = stablecoinPrices[asset.coingecko_id];
      if (!price) continue;
      const unitPrice = price[currencyKey] ?? 0;
      const pegCurrency = /eur/i.test(asset.ticker)
        ? "EUR"
        : /gbp/i.test(asset.ticker)
          ? "GBP"
          : "USD";
      for (const pos of asset.positions) {
        allPositions.push({
          positionId: pos.id,
          assetName: asset.name,
          ticker: asset.ticker,
          quantity: pos.quantity,
          apy: pos.apy,
          valueInPrimary: pos.quantity * unitPrice,
          pegCurrency,
          walletName: pos.wallet_name || "Unknown",
        });
      }
    }

    // Group by wallet
    const byWallet = new Map<string, (StablecoinPositionInGroup & { walletName: string })[]>();
    for (const pos of allPositions) {
      const list = byWallet.get(pos.walletName) ?? [];
      list.push(pos);
      byWallet.set(pos.walletName, list);
    }

    // Build groups
    const groups: StablecoinWalletGroup[] = [];
    for (const [walletName, positions] of byWallet) {
      const totalValue = positions.reduce((s, p) => s + p.valueInPrimary, 0);
      const weightedApy = totalValue > 0
        ? positions.reduce((s, p) => s + p.apy * (p.valueInPrimary / totalValue), 0)
        : 0;
      // If all positions share the same peg, use it; otherwise default to USD
      const pegs = new Set(positions.map((p) => p.pegCurrency));
      const pegCurrency = pegs.size === 1 ? [...pegs][0] : "USD";

      groups.push({ walletName, positions, totalValue, weightedApy, pegCurrency });
    }

    // Sort by total value descending
    groups.sort((a, b) => b.totalValue - a.totalValue);
    return groups;
  }, [stablecoins, stablecoinPrices, currencyKey]);

  const stablecoinTotal = useMemo(
    () => stablecoinWalletGroups.reduce((s, g) => s + g.totalValue, 0),
    [stablecoinWalletGroups]
  );

  const totalCash = cashTotal + stablecoinTotal;

  const weightedApy = useMemo(() => {
    if (totalCash === 0) return 0;
    const cashWeighted = cashAccounts.reduce((sum, a) => {
      const val = convertToBase(a.balance, a.currency, primaryCurrency, fxRates);
      return sum + val * a.apy;
    }, 0);
    const stablecoinWeighted = (stablecoins ?? []).reduce((sum, asset) => {
      const price = stablecoinPrices?.[asset.coingecko_id];
      if (!price) return sum;
      return asset.positions.reduce((s, p) => {
        const val = p.quantity * (price[currencyKey] ?? 0);
        return s + val * p.apy;
      }, sum);
    }, 0);
    return (cashWeighted + stablecoinWeighted) / totalCash;
  }, [cashAccounts, stablecoins, stablecoinPrices, currencyKey, totalCash, primaryCurrency, fxRates]);

  // ── Unified cash handlers ─────────────────────────────────
  const [cashModalOpen, setCashModalOpen] = useState(false);
  const [editingCash, setEditingCash] = useState<CashAccount | null>(null);

  const openEditCash = useCallback((account: CashAccount) => {
    setEditingCash(account);
    setCashModalOpen(true);
  }, []);

  const handleDeleteCash = useCallback(async (id: string, opts?: { isAdjustment: boolean }) => {
    try {
      await deleteCashAccount(id, opts ? { isAdjustment: opts.isAdjustment } : undefined);
      toast.success("Cash account deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  }, []);

  // ── Group expand/collapse ───────────────────────────────
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const isExpanded = useCallback(
    (id: string) => expandedGroups.has(id),
    [expandedGroups]
  );

  // ── Unified column definitions ────────────────────────────
  const columns = useMemo(
    () =>
      getCashColumns({
        onEdit: openEditCash,
        onDelete: handleDeleteCash,
        isExpanded,
        toggleExpand,
      }),
    [openEditCash, handleDeleteCash, isExpanded, toggleExpand]
  );

  // ── Single shared column config ───────────────────────────
  const {
    orderedColumns,
    configurableColumns,
    toggleColumn,
    moveColumn,
    resetToDefaults,
  } = useColumnConfig("colConfig:cash", columns, 3);

  const ctx: RenderContext = { primaryCurrency, fxRates };

  // ── Build unified row array ──────────────────────────────
  const cashRows: CashRow[] = useMemo(
    () => buildCashGroupRows(cashAccounts, primaryCurrency, fxRates),
    [cashAccounts, primaryCurrency, fxRates]
  );

  const hasAnyRows = cashAccounts.length > 0;

  // Per-section group IDs
  const cashGroupIds = useMemo(() => cashRows.map((r) => r.id), [cashRows]);
  const stablecoinGroupIds = useMemo(() => stablecoinWalletGroups.map((g) => `stablecoin-wallet:${g.walletName}`), [stablecoinWalletGroups]);

  const allGroupIds = useMemo(
    () => [...cashGroupIds, ...stablecoinGroupIds],
    [cashGroupIds, stablecoinGroupIds]
  );

  const allExpanded = allGroupIds.length > 0 && allGroupIds.every((id) => expandedGroups.has(id));

  const toggleExpandAll = useCallback(() => {
    setExpandedGroups((prev) => {
      if (allGroupIds.every((id) => prev.has(id))) return new Set();
      return new Set(allGroupIds);
    });
  }, [allGroupIds]);

  /** Toggle all groups within a single section */
  const toggleSectionGroups = useCallback((sectionIds: string[]) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      const allOpen = sectionIds.every((id) => next.has(id));
      for (const id of sectionIds) {
        if (allOpen) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, []);

  // ── Count labels ─────────────────────────────────────────
  const bankCount = cashAccounts.filter((a) => !a.wallet_id && !a.broker_id).length;
  const exchangeCount = cashAccounts.filter((a) => a.wallet_id).length;
  const brokerCount = cashAccounts.filter((a) => a.broker_id).length;

  return (
    <div>
      {/* ── Summary header ─────────────────────────────────── */}
      <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-4 md:p-5">
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
          Total Banks &amp; Deposits
        </p>
        <div className="flex items-baseline gap-3 mt-1">
          <p className="text-3xl font-semibold text-zinc-100 tabular-nums">
            {formatCurrency(totalCash, primaryCurrency)}
          </p>
          {cashChangePercent !== 0 && (
            <span
              ref={openTooltip === "summary" ? tooltipRef : undefined}
              role="button"
              aria-label="Show cash change breakdown"
              tabIndex={0}
              onClick={(e) => toggleTooltip("summary", e)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggleTooltip("summary", e); } }}
              className={`relative group/tip cursor-pointer text-xs tabular-nums ${cashChangePercent >= 0 ? "text-emerald-400" : "text-red-400"}`}
            >
              {isReadOnly ? (
                <>
                  {cashChangePercent >= 0 ? "+" : ""}{cashChangePercent.toFixed(1)}%
                  <span className="ml-1">({cashChangeValue >= 0 ? "+" : ""}{formatCurrency(cashChangeValue, primaryCurrency)})</span>
                </>
              ) : (
                <>
                  {cashChangeValue >= 0 ? "+" : ""}{formatCurrency(cashChangeValue, primaryCurrency)}
                  <span className="ml-1">({cashChangePercent >= 0 ? "+" : ""}{cashChangePercent.toFixed(1)}%)</span>
                </>
              )}
              <ChangeTooltip
                valueChange={cashChangeValue + deposits}
                fxValueChange={fxValueChange24h}
                deposits={deposits}
                depositBreakdown={depositBreakdown}
                startValue={totalCash - cashChangeValue - deposits}
                cur={primaryCurrency}
                open={openTooltip === "summary"}
              />
            </span>
          )}
        </div>
        {weightedApy > 0 && (
          <p className="text-[11px] text-emerald-400/80 mt-0.5 tabular-nums">
            ~{weightedApy.toFixed(2)}% APY · +{formatCurrency(totalCash * weightedApy / 100, primaryCurrency)}/yr
          </p>
        )}
        {stablecoinTotal > 0 && (
          <p className="text-[11px] text-zinc-400 mt-0.5 tabular-nums">
            incl. {formatCurrency(stablecoinTotal, primaryCurrency)} stablecoins
          </p>
        )}
        <p className="text-[11px] text-zinc-400 mt-0.5">
          {bankCount > 0 && (
            <>{bankCount} bank account{bankCount !== 1 ? "s" : ""}</>
          )}
          {exchangeCount > 0 && (
            <>{bankCount > 0 ? " · " : ""}{exchangeCount} exchange deposit{exchangeCount !== 1 ? "s" : ""}</>
          )}
          {brokerCount > 0 && (
            <>{(bankCount > 0 || exchangeCount > 0) ? " · " : ""}{brokerCount} broker deposit{brokerCount !== 1 ? "s" : ""}</>
          )}
          {bankCount === 0 && exchangeCount === 0 && brokerCount === 0 && "No cash accounts"}
        </p>
      </div>

      {/* ── Toolbar ──────────────────────────────────────── */}
      <div className="flex items-center flex-wrap gap-2 mt-2 mb-3">
        {allGroupIds.length > 0 && (
          <button
            onClick={toggleExpandAll}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
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
        {!isReadOnly && (
          <button
            onClick={() => {
              setEditingCash(null);
              setCashModalOpen(true);
            }}
            className="ml-auto flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add Cash
          </button>
        )}
      </div>

      {/* ── Single unified table ─────────────────────────────── */}
      {!hasAnyRows && stablecoinWalletGroups.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-8 text-center">
          <Landmark className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
          <p className="text-sm text-zinc-400">No cash holdings yet</p>
          <p className="text-xs text-zinc-400 mt-1">
            Add a bank account or fiat deposit to get started
          </p>
          {!isReadOnly && (
            <button
              onClick={() => {
                setEditingCash(null);
                setCashModalOpen(true);
              }}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 mx-auto mt-4 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add Cash
            </button>
          )}
        </div>
      ) : (
        <>
          {/* ── Mobile card layout ── */}
          <div className="space-y-2 md:hidden">
            {/* Cash Accounts */}
            {cashRows.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Landmark className="w-3.5 h-3.5 text-zinc-400" />
                  <span className="text-xs font-medium text-zinc-400">Cash Accounts</span>
                  <span className="text-xs text-zinc-400">{formatCurrency(cashTotal, primaryCurrency)}</span>
                  {cashGroupIds.length > 1 && (
                    <button
                      onClick={() => toggleSectionGroups(cashGroupIds)}
                      className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-zinc-400 hover:text-zinc-200 bg-zinc-800/50 hover:bg-zinc-700/50 transition-colors ml-auto"
                    >
                      {cashGroupIds.every((id) => expandedGroups.has(id)) ? <ChevronsDownUp className="w-3.5 h-3.5" /> : <ChevronsUpDown className="w-3.5 h-3.5" />}
                      <span>{cashGroupIds.every((id) => expandedGroups.has(id)) ? "Collapse all" : "Expand all"}</span>
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {cashRows.map((row) => {
                    const groupExpanded = expandedGroups.has(row.id);
                    return (
                      <div key={row.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
                        <button type="button" onClick={() => toggleExpand(row.id)} className="w-full px-4 py-3 flex items-center justify-between overflow-hidden">
                          <div className="text-left min-w-0">
                            <p className="text-sm font-medium text-zinc-200 truncate">{row.data.groupName}</p>
                            <p className="text-xs text-zinc-400">
                              {row.data.origin} · {row.data.accounts.length} {row.data.origin === "Bank" ? "account" : "deposit"}{row.data.accounts.length !== 1 ? "s" : ""}
                            </p>
                          </div>
                          <div className="text-right shrink-0 ml-3">
                            <p className="text-sm font-medium text-zinc-200 tabular-nums">{formatCurrency(row.data.totalValue, primaryCurrency)}</p>
                            {row.data.weightedApy > 0 && <p className="text-xs text-emerald-400">~{row.data.weightedApy.toFixed(2)}% APY</p>}
                          </div>
                        </button>
                        {groupExpanded && (
                          <div className="px-4 pb-3 border-t border-zinc-800/30 space-y-2 pt-3">
                            {row.data.accounts.map((acct) => {
                              const acctValueBase = convertToBase(acct.balance, acct.currency, primaryCurrency, fxRates);
                              const displayName = acct.name ?? `${acct.currency} deposit`;
                              return (
                                <div key={acct.id} className="flex items-center justify-between text-xs">
                                  <div>
                                    <span className="text-zinc-400">{displayName}</span>
                                    <span className="text-zinc-400 ml-1.5">{acct.currency}</span>
                                    {acct.last_was_transfer ? (
                                      <span className="text-[10px] text-teal-400 font-medium ml-1.5" title="Last change was a sell/buy/move transfer">Xfer</span>
                                    ) : acct.last_was_adjustment ? (
                                      <span className="text-[10px] text-amber-400 font-medium ml-1.5" title="Not a real transaction — portfolio balance correction">Adj.</span>
                                    ) : null}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-zinc-300 tabular-nums">{formatCurrency(acctValueBase, primaryCurrency)}</span>
                                    {!isReadOnly && (
                                      <>
                                        <button type="button" aria-label={`Edit ${acct.name ?? acct.currency}`} onClick={() => openEditCash(acct)} className="p-1 text-zinc-400 hover:text-zinc-300"><Pencil className="w-3 h-3" /></button>
                                        <ConfirmButton showAdjustmentCheckbox onConfirm={(opts) => handleDeleteCash(acct.id, opts)} className="p-1 text-zinc-400 hover:text-red-400"><Trash2 className="w-3 h-3" /></ConfirmButton>
                                      </>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Stablecoins (read-only, grouped by wallet) */}
            {stablecoinWalletGroups.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Coins className="w-3.5 h-3.5 text-zinc-400" />
                  <span className="text-xs font-medium text-zinc-400">Stablecoins</span>
                  <span className="text-xs text-zinc-400">{formatCurrency(stablecoinTotal, primaryCurrency)}</span>
                  {stablecoinGroupIds.length > 1 && (
                    <button
                      onClick={() => toggleSectionGroups(stablecoinGroupIds)}
                      className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-zinc-400 hover:text-zinc-200 bg-zinc-800/50 hover:bg-zinc-700/50 transition-colors ml-auto"
                    >
                      {stablecoinGroupIds.every((id) => expandedGroups.has(id)) ? <ChevronsDownUp className="w-3.5 h-3.5" /> : <ChevronsUpDown className="w-3.5 h-3.5" />}
                      <span>{stablecoinGroupIds.every((id) => expandedGroups.has(id)) ? "Collapse all" : "Expand all"}</span>
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {stablecoinWalletGroups.map((group) => {
                    const groupId = `stablecoin-wallet:${group.walletName}`;
                    const groupExpanded = expandedGroups.has(groupId);
                    return (
                      <div key={groupId} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
                        <button type="button" onClick={() => toggleExpand(groupId)} className="w-full px-4 py-3 flex items-center justify-between overflow-hidden">
                          <div className="text-left min-w-0">
                            <p className="text-sm font-medium text-zinc-200 truncate">{group.walletName}</p>
                            <p className="text-xs text-zinc-400">{group.positions.length} stablecoin{group.positions.length !== 1 ? "s" : ""}</p>
                          </div>
                          <div className="text-right shrink-0 ml-3">
                            <p className="text-sm font-medium text-zinc-200 tabular-nums">{formatCurrency(group.totalValue, primaryCurrency)}</p>
                            {group.weightedApy > 0 && <p className="text-xs text-emerald-400">~{group.weightedApy.toFixed(2)}% APY</p>}
                          </div>
                        </button>
                        {groupExpanded && (
                          <div className="px-4 pb-3 border-t border-zinc-800/30 space-y-2 pt-3">
                            {group.positions.map((pos) => (
                              <div key={pos.positionId} className="flex items-center justify-between text-xs">
                                <div>
                                  <span className="text-zinc-400">{pos.assetName}</span>
                                  <span className="text-zinc-400 ml-1.5">{pos.pegCurrency}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-zinc-300 tabular-nums">{formatCurrency(pos.valueInPrimary, primaryCurrency)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* ── Desktop table layout ── */}
          <div className="hidden md:block bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-x-auto">
            <table className="w-full min-w-[600px]">
              <caption className="sr-only">Cash accounts and deposits</caption>
              <thead>
                <tr className="border-b border-zinc-800/50">
                  {orderedColumns.map((col) => {
                    const align = col.align === "right" ? "text-right" : "text-left";
                    const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";
                    const width = col.width ?? "";
                    return (
                      <th key={col.key} scope="col" className={`px-4 py-2.5 text-xs font-medium text-zinc-400 uppercase tracking-wider ${align} ${hidden} ${width}`}>
                        {col.renderHeader ? col.renderHeader(ctx) : col.header}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {/* Cash account section header */}
                {cashRows.length > 0 && (
                  <tr className="bg-zinc-900/80">
                    {orderedColumns.map((col) => {
                      const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";
                      if (col.key === "name") {
                        return (
                          <td key={col.key} className="px-4 py-2">
                            <div className="flex items-center gap-2">
                              <Landmark className="w-3.5 h-3.5 text-zinc-400" />
                              <span className="text-xs font-medium text-zinc-400">Cash Accounts</span>
                              {cashGroupIds.length > 1 && (
                                <button
                                  onClick={() => toggleSectionGroups(cashGroupIds)}
                                  className="p-0.5 rounded hover:bg-zinc-700/50 text-zinc-600 hover:text-zinc-400 transition-colors"
                                  title={cashGroupIds.every((id) => expandedGroups.has(id)) ? "Collapse all groups" : "Expand all groups"}
                                >
                                  {cashGroupIds.every((id) => expandedGroups.has(id)) ? <ChevronsDownUp className="w-3 h-3" /> : <ChevronsUpDown className="w-3 h-3" />}
                                </button>
                              )}
                            </div>
                          </td>
                        );
                      }
                      if (col.key === "value") {
                        return (
                          <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
                            <span className="text-xs text-zinc-400">{formatCurrency(cashTotal, primaryCurrency)}</span>
                          </td>
                        );
                      }
                      return <td key={col.key} className={hidden} />;
                    })}
                  </tr>
                )}

                {cashRows.length === 0 && stablecoinWalletGroups.length === 0 ? (
                  <tr className="border-b border-zinc-800/30">
                    <td colSpan={orderedColumns.length} className="px-4 py-4 text-center">
                      <p className="text-xs text-zinc-400">No cash accounts yet &mdash; click Add Cash to create one</p>
                    </td>
                  </tr>
                ) : (
                  cashRows.map((row) => {
                    const groupExpanded = expandedGroups.has(row.id);
                    return (
                      <Fragment key={row.id}>
                        <tr className="border-b border-zinc-800/30 group hover:bg-zinc-800/20 transition-colors">
                          {orderedColumns.map((col) => {
                            const align = col.align === "right" ? "text-right" : "text-left";
                            const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";
                            return (
                              <td key={col.key} className={`px-4 py-2.5 ${align} ${hidden}`}>
                                {col.renderCell(row, ctx)}
                              </td>
                            );
                          })}
                        </tr>
                        {groupExpanded &&
                          row.data.accounts.map((acct) => (
                            <ExpandedCashRow key={acct.id} account={acct} orderedColumns={orderedColumns} ctx={ctx} onEdit={() => openEditCash(acct)} onDelete={(opts) => handleDeleteCash(acct.id, opts)} />
                          ))}
                      </Fragment>
                    );
                  })
                )}

                {/* Stablecoins (read-only, grouped by wallet) */}
                {stablecoinWalletGroups.length > 0 && (
                  <>
                    <tr className="bg-zinc-900/80">
                      {orderedColumns.map((col) => {
                        const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";
                        if (col.key === "name") {
                          return (
                            <td key={col.key} className="px-4 py-2">
                              <div className="flex items-center gap-2">
                                <Coins className="w-3.5 h-3.5 text-zinc-400" />
                                <span className="text-xs font-medium text-zinc-400">Stablecoins</span>
                                {stablecoinGroupIds.length > 1 && (
                                  <button
                                    onClick={() => toggleSectionGroups(stablecoinGroupIds)}
                                    className="p-0.5 rounded hover:bg-zinc-700/50 text-zinc-600 hover:text-zinc-400 transition-colors"
                                    title={stablecoinGroupIds.every((id) => expandedGroups.has(id)) ? "Collapse all groups" : "Expand all groups"}
                                  >
                                    {stablecoinGroupIds.every((id) => expandedGroups.has(id)) ? <ChevronsDownUp className="w-3 h-3" /> : <ChevronsUpDown className="w-3 h-3" />}
                                  </button>
                                )}
                              </div>
                            </td>
                          );
                        }
                        if (col.key === "value") {
                          return (
                            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
                              <span className="text-xs text-zinc-400">{formatCurrency(stablecoinTotal, primaryCurrency)}</span>
                            </td>
                          );
                        }
                        return <td key={col.key} className={hidden} />;
                      })}
                    </tr>
                    {stablecoinWalletGroups.map((group) => {
                      const groupId = `stablecoin-wallet:${group.walletName}`;
                      const groupExpanded = isExpanded(groupId);
                      return (
                        <Fragment key={groupId}>
                          <StablecoinWalletGroupRow
                            group={group}
                            expanded={groupExpanded}
                            onToggle={() => toggleExpand(groupId)}
                            orderedColumns={orderedColumns}
                            ctx={ctx}
                          />
                          {groupExpanded &&
                            group.positions.map((pos) => (
                              <ExpandedStablecoinPositionRow
                                key={pos.positionId}
                                position={pos}
                                orderedColumns={orderedColumns}
                                ctx={ctx}
                              />
                            ))}
                        </Fragment>
                      );
                    })}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!isReadOnly && (
        <CashAccountModal
          isOpen={cashModalOpen}
          onClose={() => {
            setCashModalOpen(false);
            setEditingCash(null);
          }}
          cashAccount={editingCash}
          institutionId={editingCash?.institution_id ?? undefined}
          institutionName={editingCash?.institution_name ?? undefined}
          institutions={institutions}
          walletId={editingCash?.wallet_id ?? undefined}
          walletName={editingCash?.wallet_name ?? undefined}
          brokerId={editingCash?.broker_id ?? undefined}
          brokerName={editingCash?.broker_name ?? undefined}
        />
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════
// Expanded Cash Account Sub-Row
// ═══════════════════════════════════════════════════════════════

function ExpandedCashRow({
  account,
  orderedColumns,
  ctx,
  onEdit,
  onDelete,
}: {
  account: CashAccount;
  orderedColumns: ColumnDef<CashRow>[];
  ctx: RenderContext;
  onEdit: () => void;
  onDelete: (opts?: { isAdjustment: boolean }) => void;
}) {
  const { isReadOnly } = useSharedView();
  const valueInBase = convertToBase(
    account.balance,
    account.currency,
    ctx.primaryCurrency,
    ctx.fxRates
  );

  const displayName = account.name ?? `${account.currency} deposit`;

  return (
    <tr className="bg-zinc-950/50 border-b border-zinc-800/20 group">
      {orderedColumns.map((col) => {
        const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";

        if (col.key === "name") {
          return (
            <td key={col.key} className="pl-10 pr-4 py-2">
              <span className="text-xs text-zinc-400">
                {displayName}
                {account.last_was_transfer ? (
                  <span className="text-[10px] text-teal-400 font-medium ml-1.5" title="Last change was a sell/buy/move transfer">Xfer</span>
                ) : account.last_was_adjustment ? (
                  <span className="text-[10px] text-amber-400 font-medium ml-1.5" title="Not a real transaction — portfolio balance correction">Adj.</span>
                ) : null}
              </span>
            </td>
          );
        }
        if (col.key === "type") {
          const origin = account.wallet_id ? "Exchange" : account.broker_id ? "Broker" : "Bank";
          return (
            <td key={col.key} className={`px-4 py-2 text-left ${hidden}`}>
              <span className="text-xs text-zinc-400">{origin}</span>
            </td>
          );
        }
        if (col.key === "currency") {
          return (
            <td key={col.key} className={`px-4 py-2 text-left ${hidden}`}>
              <span className="text-xs text-zinc-400">{account.currency}</span>
            </td>
          );
        }
        if (col.key === "balance") {
          return (
            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
              <span className="text-xs text-zinc-400 tabular-nums">
                {formatCurrency(account.balance, account.currency)}
              </span>
            </td>
          );
        }
        if (col.key === "value") {
          const showConverted = account.currency !== ctx.primaryCurrency;
          return (
            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
              <span
                className={`text-xs tabular-nums ${
                  showConverted ? "text-zinc-400" : "text-zinc-400"
                }`}
              >
                {formatCurrency(valueInBase, ctx.primaryCurrency)}
              </span>
            </td>
          );
        }
        if (col.key === "apy") {
          return (
            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
              {account.apy > 0 ? (
                <span className="text-xs text-emerald-400/70">
                  {account.apy}%
                </span>
              ) : (
                <span className="text-xs text-zinc-400">&mdash;</span>
              )}
            </td>
          );
        }
        if (col.key === "region") {
          return (
            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
              {account.region && (
                <span className="text-xs text-zinc-400">{countryName(account.region)}</span>
              )}
            </td>
          );
        }
        if (col.key === "actions") {
          return (
            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
              {!isReadOnly && (
                <div className="flex items-center justify-end gap-1">
                  <button
                    onClick={onEdit}
                    className="p-1.5 rounded-lg text-zinc-400 hover:text-blue-400 hover:bg-zinc-800 transition-colors"
                    aria-label="Edit account"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <ConfirmButton
                    showAdjustmentCheckbox
                    onConfirm={onDelete}
                    className="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </ConfirmButton>
                </div>
              )}
            </td>
          );
        }
        return <td key={col.key} className={hidden} />;
      })}
    </tr>
  );
}

// ═══════════════════════════════════════════════════════════════
// Stablecoin Wallet Group Row (expandable)
// ═══════════════════════════════════════════════════════════════

function StablecoinWalletGroupRow({
  group,
  expanded,
  onToggle,
  orderedColumns,
  ctx,
}: {
  group: StablecoinWalletGroup;
  expanded: boolean;
  onToggle: () => void;
  orderedColumns: ColumnDef<CashRow>[];
  ctx: RenderContext;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;

  // Balance display: single ticker -> "TICKER qty", mixed -> formatted total
  const tickers = new Set(group.positions.map((p) => p.ticker));
  const totalQty = group.positions.reduce((s, p) => s + p.quantity, 0);
  const balanceLabel =
    tickers.size === 1
      ? `${[...tickers][0]} ${totalQty.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
      : formatCurrency(group.totalValue, ctx.primaryCurrency);

  return (
    <tr
      className="border-b border-zinc-800/30 hover:bg-zinc-800/20 transition-colors cursor-pointer"
      onClick={onToggle}
      tabIndex={0}
      role="button"
      aria-expanded={expanded}
      aria-label={`${group.walletName} group, ${expanded ? "collapse" : "expand"}`}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
    >
      {orderedColumns.map((col) => {
        const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";

        if (col.key === "name") {
          return (
            <td key={col.key} className="px-4 py-2.5">
              <div className="flex items-center gap-2">
                <Chevron className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                <span className="text-sm font-medium text-zinc-200">{group.walletName}</span>
                <span className="text-xs text-zinc-400">
                  {group.positions.length} stablecoin{group.positions.length !== 1 ? "s" : ""}
                </span>
              </div>
            </td>
          );
        }
        if (col.key === "currency") {
          return (
            <td key={col.key} className={`px-4 py-2.5 text-left ${hidden}`}>
              <span className="text-xs text-zinc-400">{group.pegCurrency}</span>
            </td>
          );
        }
        if (col.key === "balance") {
          return (
            <td key={col.key} className={`px-4 py-2.5 text-right ${hidden}`}>
              <span className="text-sm text-zinc-200 tabular-nums whitespace-nowrap">
                {balanceLabel}
              </span>
            </td>
          );
        }
        if (col.key === "apy") {
          return (
            <td key={col.key} className={`px-4 py-2.5 text-right ${hidden}`}>
              {group.weightedApy > 0 ? (
                <span className="text-sm text-emerald-400">
                  ~{group.weightedApy.toFixed(2)}%
                </span>
              ) : (
                <span className="text-sm text-zinc-400">&mdash;</span>
              )}
            </td>
          );
        }
        if (col.key === "value") {
          return (
            <td key={col.key} className={`px-4 py-2.5 text-right ${hidden}`}>
              <span className="text-sm font-medium text-zinc-200 tabular-nums">
                {formatCurrency(group.totalValue, ctx.primaryCurrency)}
              </span>
            </td>
          );
        }
        return <td key={col.key} className={hidden} />;
      })}
    </tr>
  );
}

// ═══════════════════════════════════════════════════════════════
// Expanded Stablecoin Position Row (sub-row)
// ═══════════════════════════════════════════════════════════════

function ExpandedStablecoinPositionRow({
  position,
  orderedColumns,
  ctx,
}: {
  position: StablecoinPositionInGroup;
  orderedColumns: ColumnDef<CashRow>[];
  ctx: RenderContext;
}) {
  return (
    <tr className="bg-zinc-950/50 border-b border-zinc-800/20">
      {orderedColumns.map((col) => {
        const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";

        if (col.key === "name") {
          return (
            <td key={col.key} className="pl-10 pr-4 py-2">
              <span className="text-xs text-zinc-400">{position.assetName}</span>
            </td>
          );
        }
        if (col.key === "currency") {
          return (
            <td key={col.key} className={`px-4 py-2 text-left ${hidden}`}>
              <span className="text-xs text-zinc-400">{position.pegCurrency}</span>
            </td>
          );
        }
        if (col.key === "balance") {
          return (
            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
              <span className="text-xs text-zinc-400 tabular-nums whitespace-nowrap">
                {position.ticker} {position.quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            </td>
          );
        }
        if (col.key === "value") {
          return (
            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
              <span className="text-xs text-zinc-400 tabular-nums">
                {formatCurrency(position.valueInPrimary, ctx.primaryCurrency)}
              </span>
            </td>
          );
        }
        if (col.key === "apy") {
          return (
            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
              {position.apy > 0 ? (
                <span className="text-xs text-emerald-400/70">
                  {position.apy.toFixed(2)}%
                </span>
              ) : (
                <span className="text-xs text-zinc-400">&mdash;</span>
              )}
            </td>
          );
        }
        return <td key={col.key} className={hidden} />;
      })}
    </tr>
  );
}
