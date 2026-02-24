"use client";

import { useState, useMemo, useCallback, useEffect, Fragment } from "react";
import { Plus, Landmark, Wallet as WalletIcon, Briefcase, Coins, Pencil, Trash2, ChevronsDownUp, ChevronsUpDown, ChevronDown, ChevronRight } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { ColumnSettingsPopover } from "@/components/ui/column-settings-popover";
import { useColumnConfig } from "@/lib/hooks/use-column-config";
import { toast } from "sonner";
import { convertToBase } from "@/lib/prices/fx";
import type { FXRates } from "@/lib/prices/fx";
import { deleteBankAccount } from "@/lib/actions/bank-accounts";
import { deleteExchangeDeposit } from "@/lib/actions/exchange-deposits";
import { deleteBrokerDeposit } from "@/lib/actions/broker-deposits";
import { BankAccountModal } from "@/components/cash/bank-account-modal";
import { ExchangeDepositModal } from "@/components/cash/exchange-deposit-modal";
import { BrokerDepositModal } from "@/components/cash/broker-deposit-modal";
import {
  getCashColumns,
  buildBankGroupRows,
  buildExchangeGroupRows,
  buildBrokerGroupRows,
  type CashRow,
} from "@/components/cash/cash-columns";
import { formatCurrency } from "@/lib/format";
import type { ColumnDef, RenderContext } from "@/lib/column-config";
import type {
  BankAccount,
  Broker,
  BrokerDeposit,
  ExchangeDeposit,
  CryptoAssetWithPositions,
  CoinGeckoPriceData,
  Wallet,
} from "@/lib/types";
import { countryName } from "@/lib/types";
import { HIDDEN_BELOW } from "@/lib/constants";

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
  bankAccounts: BankAccount[];
  exchangeDeposits: ExchangeDeposit[];
  brokerDeposits: BrokerDeposit[];
  wallets: Wallet[];
  brokers: Broker[];
  primaryCurrency: string;
  fxRates: FXRates;
  stablecoins?: CryptoAssetWithPositions[];
  stablecoinPrices?: CoinGeckoPriceData;
  /** Total cash 24h change % (FX + stablecoin movement) */
  cashChangePercent?: number;
  /** Total cash 24h absolute change in primary currency */
  cashChangeValue?: number;
  /** FX-only 24h change % (e.g. EUR/USD impact on cash value) */
  fxChangePercent?: number;
  /** FX-only 24h absolute change in primary currency */
  fxChangeValue?: number;
  /** Stablecoin 24h absolute change in primary currency */
  stablecoinChange?: number;
}

export function CashTable({
  bankAccounts,
  exchangeDeposits,
  brokerDeposits,
  wallets,
  brokers,
  primaryCurrency,
  fxRates,
  stablecoins,
  stablecoinPrices,
  cashChangePercent = 0,
  cashChangeValue = 0,
  fxChangePercent = 0,
  fxChangeValue = 0,
  stablecoinChange = 0,
}: CashTableProps) {
  // ── Compute totals ──────────────────────────────────────
  const bankTotal = bankAccounts.reduce(
    (sum, b) =>
      sum + convertToBase(b.balance, b.currency, primaryCurrency, fxRates),
    0
  );
  const exchangeDepositTotal = exchangeDeposits.reduce(
    (sum, d) =>
      sum + convertToBase(d.amount, d.currency, primaryCurrency, fxRates),
    0
  );
  const brokerDepositTotal = brokerDeposits.reduce(
    (sum, d) =>
      sum + convertToBase(d.amount, d.currency, primaryCurrency, fxRates),
    0
  );
  const depositTotal = exchangeDepositTotal + brokerDepositTotal;

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

  const totalCash = bankTotal + depositTotal + stablecoinTotal;

  const weightedApy = useMemo(() => {
    if (totalCash === 0) return 0;
    const bankWeighted = bankAccounts.reduce((sum, b) => {
      const val = convertToBase(b.balance, b.currency, primaryCurrency, fxRates);
      return sum + val * b.apy;
    }, 0);
    const exchWeighted = exchangeDeposits.reduce((sum, d) => {
      const val = convertToBase(d.amount, d.currency, primaryCurrency, fxRates);
      return sum + val * d.apy;
    }, 0);
    const brokerWeighted = brokerDeposits.reduce((sum, d) => {
      const val = convertToBase(d.amount, d.currency, primaryCurrency, fxRates);
      return sum + val * d.apy;
    }, 0);
    const stablecoinWeighted = (stablecoins ?? []).reduce((sum, asset) => {
      const price = stablecoinPrices?.[asset.coingecko_id];
      if (!price) return sum;
      return asset.positions.reduce((s, p) => {
        const val = p.quantity * (price[currencyKey] ?? 0);
        return s + val * p.apy;
      }, sum);
    }, 0);
    return (bankWeighted + exchWeighted + brokerWeighted + stablecoinWeighted) / totalCash;
  }, [bankAccounts, exchangeDeposits, brokerDeposits, stablecoins, stablecoinPrices, currencyKey, totalCash, primaryCurrency, fxRates]);

  // ── Bank handlers ─────────────────────────────────────────
  const [bankModalOpen, setBankModalOpen] = useState(false);
  const [editingBank, setEditingBank] = useState<BankAccount | null>(null);

  const openEditBank = useCallback((bank: BankAccount) => {
    setEditingBank(bank);
    setBankModalOpen(true);
  }, [setBankModalOpen]);

  const handleDeleteBank = useCallback(async (id: string) => {
    try {
      await deleteBankAccount(id);
      toast.success("Bank account deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  }, []);

  // ── Exchange handlers ─────────────────────────────────────
  const [exchModalOpen, setExchModalOpen] = useState(false);
  const [editingExch, setEditingExch] = useState<ExchangeDeposit | null>(null);

  const openEditExchange = useCallback((deposit: ExchangeDeposit) => {
    setEditingExch(deposit);
    setExchModalOpen(true);
  }, [setExchModalOpen]);

  const handleDeleteExchange = useCallback(async (id: string) => {
    try {
      await deleteExchangeDeposit(id);
      toast.success("Exchange deposit deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  }, []);

  // ── Broker deposit handlers ─────────────────────────────
  const [brokerDepModalOpen, setBrokerDepModalOpen] = useState(false);
  const [editingBrokerDep, setEditingBrokerDep] = useState<BrokerDeposit | null>(null);

  const openEditBrokerDeposit = useCallback((deposit: BrokerDeposit) => {
    setEditingBrokerDep(deposit);
    setBrokerDepModalOpen(true);
  }, [setBrokerDepModalOpen]);

  const handleDeleteBrokerDeposit = useCallback(async (id: string) => {
    try {
      await deleteBrokerDeposit(id);
      toast.success("Broker deposit deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  }, []);

  // ── Bank group expand/collapse ───────────────────────────
  const [expandedBanks, setExpandedBanks] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((id: string) => {
    setExpandedBanks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const isExpanded = useCallback(
    (id: string) => expandedBanks.has(id),
    [expandedBanks]
  );

  // ── Unified column definitions ────────────────────────────
  const columns = useMemo(
    () =>
      getCashColumns({
        onEditBank: openEditBank,
        onDeleteBank: handleDeleteBank,
        onEditExchange: openEditExchange,
        onDeleteExchange: handleDeleteExchange,
        onEditBrokerDeposit: openEditBrokerDeposit,
        onDeleteBrokerDeposit: handleDeleteBrokerDeposit,
        isExpanded,
        toggleExpand,
      }),
    [openEditBank, handleDeleteBank, openEditExchange, handleDeleteExchange, openEditBrokerDeposit, handleDeleteBrokerDeposit, isExpanded, toggleExpand]
  );

  // ── Single shared column config ───────────────────────────
  const {
    orderedColumns,
    configurableColumns,
    toggleColumn,
    moveColumn,
    resetToDefaults,
  } = useColumnConfig("colConfig:cash", columns, 2);

  const ctx: RenderContext = { primaryCurrency, fxRates };

  // ── Build unified row arrays ──────────────────────────────
  const bankRows: CashRow[] = useMemo(
    () => buildBankGroupRows(bankAccounts, primaryCurrency, fxRates),
    [bankAccounts, primaryCurrency, fxRates]
  );
  const exchRows: CashRow[] = useMemo(
    () => buildExchangeGroupRows(exchangeDeposits, primaryCurrency, fxRates),
    [exchangeDeposits, primaryCurrency, fxRates]
  );
  const brokerDepRows: CashRow[] = useMemo(
    () => buildBrokerGroupRows(brokerDeposits, primaryCurrency, fxRates),
    [brokerDeposits, primaryCurrency, fxRates]
  );

  const hasAnyRows = bankAccounts.length > 0 || exchangeDeposits.length > 0 || brokerDeposits.length > 0;

  // Per-section group IDs (used for per-section toggle)
  const bankGroupIds = useMemo(() => bankRows.filter((r) => r.type === "bank-group").map((r) => r.id), [bankRows]);
  const exchGroupIds = useMemo(() => exchRows.filter((r) => r.type === "exchange-group").map((r) => r.id), [exchRows]);
  const brokerGroupIds = useMemo(() => brokerDepRows.filter((r) => r.type === "broker-group").map((r) => r.id), [brokerDepRows]);
  const stablecoinGroupIds = useMemo(() => stablecoinWalletGroups.map((g) => `stablecoin-wallet:${g.walletName}`), [stablecoinWalletGroups]);

  const allGroupIds = useMemo(
    () => [...bankGroupIds, ...exchGroupIds, ...brokerGroupIds, ...stablecoinGroupIds],
    [bankGroupIds, exchGroupIds, brokerGroupIds, stablecoinGroupIds]
  );

  const allExpanded = allGroupIds.length > 0 && allGroupIds.every((id) => expandedBanks.has(id));

  const toggleExpandAll = useCallback(() => {
    setExpandedBanks((prev) => {
      if (allGroupIds.every((id) => prev.has(id))) return new Set();
      return new Set(allGroupIds);
    });
  }, [allGroupIds]);

  /** Toggle all groups within a single section */
  const toggleSectionGroups = useCallback((sectionIds: string[]) => {
    setExpandedBanks((prev) => {
      const next = new Set(prev);
      const allOpen = sectionIds.every((id) => next.has(id));
      for (const id of sectionIds) {
        if (allOpen) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, []);

  // ── Add chooser ─────────────────────────────────────────
  const [addChooserOpen, setAddChooserOpen] = useState(false);

  // ── Bank modal form helpers ───────────────────────────────
  function openCreateBank() {
    setAddChooserOpen(false);
    setEditingBank(null);
    setBankModalOpen(true);
  }

  function openCreateExchange() {
    setAddChooserOpen(false);
    setEditingExch(null);
    setExchModalOpen(true);
  }

  function openCreateBrokerDeposit() {
    setAddChooserOpen(false);
    setEditingBrokerDep(null);
    setBrokerDepModalOpen(true);
  }

  return (
    <div>
      {/* ── Summary header ─────────────────────────────────── */}
      <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-4 md:p-5">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-0 md:gap-4">
          {/* Info: total + stats */}
          <div className="flex items-center justify-between md:justify-start md:gap-6 flex-1 min-w-0">
            <div>
              <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                Total Banks &amp; Deposits
              </p>
              <p className="text-3xl font-semibold text-zinc-100 mt-1 tabular-nums">
                {formatCurrency(totalCash, primaryCurrency)}
              </p>
              {cashChangePercent !== 0 && (
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-xs tabular-nums ${cashChangePercent >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {cashChangePercent >= 0 ? "+" : ""}{cashChangePercent.toFixed(2)}%
                  </span>
                  <span className={`text-xs tabular-nums ${cashChangePercent >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    ({cashChangeValue >= 0 ? "+" : ""}{formatCurrency(cashChangeValue, primaryCurrency)})
                  </span>
                  <span className="text-xs text-zinc-600">24h</span>
                </div>
              )}
              {weightedApy > 0 && (
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs tabular-nums text-emerald-400">
                    ~{weightedApy.toFixed(2)}% APY · +{formatCurrency(totalCash * weightedApy / 100, primaryCurrency)}/yr
                  </span>
                </div>
              )}
              {fxChangePercent !== 0 && (
                <p className="text-[11px] text-zinc-500 mt-0.5 tabular-nums">
                  incl. {fxChangePercent >= 0 ? "+" : ""}{fxChangePercent.toFixed(2)}% ({fxChangeValue > 0 ? "+" : ""}{formatCurrency(fxChangeValue, primaryCurrency)}) EUR/USD
                </p>
              )}
              {stablecoinTotal > 0 && (
                <p className="text-[11px] text-zinc-500 mt-0.5 tabular-nums">
                  incl. {formatCurrency(stablecoinTotal, primaryCurrency)} stablecoins
                  {stablecoinChange !== 0 && (
                    <span> ({stablecoinChange > 0 ? "+" : ""}{formatCurrency(stablecoinChange, primaryCurrency)})</span>
                  )}
                </p>
              )}
            </div>
            <div className="text-right md:text-left text-xs text-zinc-500 space-y-0.5">
              <p>
                {bankAccounts.length} bank account
                {bankAccounts.length !== 1 ? "s" : ""}
              </p>
              {exchangeDeposits.length > 0 && (
                <p>
                  {exchangeDeposits.length} exchange deposit
                  {exchangeDeposits.length !== 1 ? "s" : ""}
                </p>
              )}
              {brokerDeposits.length > 0 && (
                <p>
                  {brokerDeposits.length} broker deposit
                  {brokerDeposits.length !== 1 ? "s" : ""}
                </p>
              )}
            </div>
          </div>
          {/* Toolbar: action buttons */}
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-zinc-800/30 md:mt-0 md:pt-0 md:border-t-0">
            {allGroupIds.length > 0 && (
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
            {/* Mobile: + Add Asset in toolbar */}
            <button
              onClick={() => setAddChooserOpen(true)}
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
          onClick={() => setAddChooserOpen(true)}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Asset
        </button>
      </div>

      {/* ── Single unified table ─────────────────────────────── */}
      {!hasAnyRows ? (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-8 text-center">
          <Landmark className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
          <p className="text-sm text-zinc-500">No cash holdings yet</p>
          <p className="text-xs text-zinc-600 mt-1">
            Add a bank account or exchange deposit to get started
          </p>
          <button
            onClick={() => setAddChooserOpen(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 mx-auto mt-4 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add Asset
          </button>
        </div>
      ) : (
        <>
          {/* ── Mobile card layout ── */}
          <div className="space-y-2 md:hidden">
            {/* Bank Accounts */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Landmark className="w-3.5 h-3.5 text-zinc-500" />
                <span className="text-xs font-medium text-zinc-400">Bank Accounts</span>
                <span className="text-xs text-zinc-600">{formatCurrency(bankTotal, primaryCurrency)}</span>
                {bankGroupIds.length > 1 && (
                  <button
                    onClick={() => toggleSectionGroups(bankGroupIds)}
                    className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-zinc-400 hover:text-zinc-200 bg-zinc-800/50 hover:bg-zinc-700/50 transition-colors ml-auto"
                  >
                    {bankGroupIds.every((id) => expandedBanks.has(id)) ? <ChevronsDownUp className="w-3.5 h-3.5" /> : <ChevronsUpDown className="w-3.5 h-3.5" />}
                    <span>{bankGroupIds.every((id) => expandedBanks.has(id)) ? "Collapse all" : "Expand all"}</span>
                  </button>
                )}
              </div>
              {bankRows.length === 0 ? (
                <p className="text-xs text-zinc-600 px-4 py-3">No bank accounts yet</p>
              ) : (
                <div className="space-y-2">
                  {bankRows.map((row) => {
                    if (row.type !== "bank-group") return null;
                    const groupExpanded = expandedBanks.has(row.id);
                    return (
                      <div key={row.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
                        <button onClick={() => toggleExpand(row.id)} className="w-full px-4 py-3 flex items-center justify-between overflow-hidden">
                          <div className="text-left min-w-0">
                            <p className="text-sm font-medium text-zinc-200 truncate">{row.data.bankName}</p>
                            <p className="text-xs text-zinc-500">{row.data.accounts.length} account{row.data.accounts.length !== 1 ? "s" : ""}</p>
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
                              return (
                                <div key={acct.id} className="flex items-center justify-between text-xs">
                                  <div>
                                    <span className="text-zinc-400">{acct.name}</span>
                                    <span className="text-zinc-600 ml-1.5">{acct.currency}</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-zinc-300 tabular-nums">{formatCurrency(acctValueBase, primaryCurrency)}</span>
                                    <button onClick={() => openEditBank(acct)} className="p-1 text-zinc-500 hover:text-zinc-300"><Pencil className="w-3 h-3" /></button>
                                    <ConfirmButton onConfirm={() => handleDeleteBank(acct.id)} className="p-1 text-zinc-500 hover:text-red-400"><Trash2 className="w-3 h-3" /></ConfirmButton>
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
              )}
            </div>

            {/* Exchange Deposits */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <WalletIcon className="w-3.5 h-3.5 text-zinc-500" />
                <span className="text-xs font-medium text-zinc-400">Exchange Deposits</span>
                <span className="text-xs text-zinc-600">{formatCurrency(exchangeDepositTotal, primaryCurrency)}</span>
                {exchGroupIds.length > 1 && (
                  <button
                    onClick={() => toggleSectionGroups(exchGroupIds)}
                    className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-zinc-400 hover:text-zinc-200 bg-zinc-800/50 hover:bg-zinc-700/50 transition-colors ml-auto"
                  >
                    {exchGroupIds.every((id) => expandedBanks.has(id)) ? <ChevronsDownUp className="w-3.5 h-3.5" /> : <ChevronsUpDown className="w-3.5 h-3.5" />}
                    <span>{exchGroupIds.every((id) => expandedBanks.has(id)) ? "Collapse all" : "Expand all"}</span>
                  </button>
                )}
              </div>
              {exchRows.length === 0 ? (
                <p className="text-xs text-zinc-600 px-4 py-3">{wallets.length === 0 ? "Add a wallet in Settings first" : "No exchange deposits yet"}</p>
              ) : (
                <div className="space-y-2">
                  {exchRows.map((row) => {
                    if (row.type !== "exchange-group") return null;
                    const groupExpanded = expandedBanks.has(row.id);
                    return (
                      <div key={row.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
                        <button onClick={() => toggleExpand(row.id)} className="w-full px-4 py-3 flex items-center justify-between overflow-hidden">
                          <div className="text-left min-w-0">
                            <p className="text-sm font-medium text-zinc-200 truncate">{row.data.walletName}</p>
                            <p className="text-xs text-zinc-500">{row.data.deposits.length} deposit{row.data.deposits.length !== 1 ? "s" : ""}</p>
                          </div>
                          <div className="text-right shrink-0 ml-3">
                            <p className="text-sm font-medium text-zinc-200 tabular-nums">{formatCurrency(row.data.totalValue, primaryCurrency)}</p>
                            {row.data.weightedApy > 0 && <p className="text-xs text-emerald-400">~{row.data.weightedApy.toFixed(2)}% APY</p>}
                          </div>
                        </button>
                        {groupExpanded && (
                          <div className="px-4 pb-3 border-t border-zinc-800/30 space-y-2 pt-3">
                            {row.data.deposits.map((dep) => {
                              const depValueBase = convertToBase(dep.amount, dep.currency, primaryCurrency, fxRates);
                              return (
                                <div key={dep.id} className="flex items-center justify-between text-xs">
                                  <div>
                                    <span className="text-zinc-400">{dep.currency} deposit</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-zinc-300 tabular-nums">{formatCurrency(depValueBase, primaryCurrency)}</span>
                                    <button onClick={() => openEditExchange(dep)} className="p-1 text-zinc-500 hover:text-zinc-300"><Pencil className="w-3 h-3" /></button>
                                    <ConfirmButton onConfirm={() => handleDeleteExchange(dep.id)} className="p-1 text-zinc-500 hover:text-red-400"><Trash2 className="w-3 h-3" /></ConfirmButton>
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
              )}
            </div>

            {/* Broker Deposits */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Briefcase className="w-3.5 h-3.5 text-zinc-500" />
                <span className="text-xs font-medium text-zinc-400">Broker Deposits</span>
                <span className="text-xs text-zinc-600">{formatCurrency(brokerDepositTotal, primaryCurrency)}</span>
                {brokerGroupIds.length > 1 && (
                  <button
                    onClick={() => toggleSectionGroups(brokerGroupIds)}
                    className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-zinc-400 hover:text-zinc-200 bg-zinc-800/50 hover:bg-zinc-700/50 transition-colors ml-auto"
                  >
                    {brokerGroupIds.every((id) => expandedBanks.has(id)) ? <ChevronsDownUp className="w-3.5 h-3.5" /> : <ChevronsUpDown className="w-3.5 h-3.5" />}
                    <span>{brokerGroupIds.every((id) => expandedBanks.has(id)) ? "Collapse all" : "Expand all"}</span>
                  </button>
                )}
              </div>
              {brokerDepRows.length === 0 ? (
                <p className="text-xs text-zinc-600 px-4 py-3">{brokers.length === 0 ? "Add a broker in Settings first" : "No broker deposits yet"}</p>
              ) : (
                <div className="space-y-2">
                  {brokerDepRows.map((row) => {
                    if (row.type !== "broker-group") return null;
                    const groupExpanded = expandedBanks.has(row.id);
                    return (
                      <div key={row.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
                        <button onClick={() => toggleExpand(row.id)} className="w-full px-4 py-3 flex items-center justify-between overflow-hidden">
                          <div className="text-left min-w-0">
                            <p className="text-sm font-medium text-zinc-200 truncate">{row.data.brokerName}</p>
                            <p className="text-xs text-zinc-500">{row.data.deposits.length} deposit{row.data.deposits.length !== 1 ? "s" : ""}</p>
                          </div>
                          <div className="text-right shrink-0 ml-3">
                            <p className="text-sm font-medium text-zinc-200 tabular-nums">{formatCurrency(row.data.totalValue, primaryCurrency)}</p>
                            {row.data.weightedApy > 0 && <p className="text-xs text-emerald-400">~{row.data.weightedApy.toFixed(2)}% APY</p>}
                          </div>
                        </button>
                        {groupExpanded && (
                          <div className="px-4 pb-3 border-t border-zinc-800/30 space-y-2 pt-3">
                            {row.data.deposits.map((dep) => {
                              const depValueBase = convertToBase(dep.amount, dep.currency, primaryCurrency, fxRates);
                              return (
                                <div key={dep.id} className="flex items-center justify-between text-xs">
                                  <div>
                                    <span className="text-zinc-400">{dep.currency} deposit</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-zinc-300 tabular-nums">{formatCurrency(depValueBase, primaryCurrency)}</span>
                                    <button onClick={() => openEditBrokerDeposit(dep)} className="p-1 text-zinc-500 hover:text-zinc-300"><Pencil className="w-3 h-3" /></button>
                                    <ConfirmButton onConfirm={() => handleDeleteBrokerDeposit(dep.id)} className="p-1 text-zinc-500 hover:text-red-400"><Trash2 className="w-3 h-3" /></ConfirmButton>
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
              )}
            </div>

            {/* Stablecoins (read-only, grouped by wallet) */}
            {stablecoinWalletGroups.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Coins className="w-3.5 h-3.5 text-zinc-500" />
                  <span className="text-xs font-medium text-zinc-400">Stablecoins</span>
                  <span className="text-xs text-zinc-600">{formatCurrency(stablecoinTotal, primaryCurrency)}</span>
                  {stablecoinGroupIds.length > 1 && (
                    <button
                      onClick={() => toggleSectionGroups(stablecoinGroupIds)}
                      className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-zinc-400 hover:text-zinc-200 bg-zinc-800/50 hover:bg-zinc-700/50 transition-colors ml-auto"
                    >
                      {stablecoinGroupIds.every((id) => expandedBanks.has(id)) ? <ChevronsDownUp className="w-3.5 h-3.5" /> : <ChevronsUpDown className="w-3.5 h-3.5" />}
                      <span>{stablecoinGroupIds.every((id) => expandedBanks.has(id)) ? "Collapse all" : "Expand all"}</span>
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {stablecoinWalletGroups.map((group) => {
                    const groupId = `stablecoin-wallet:${group.walletName}`;
                    const groupExpanded = expandedBanks.has(groupId);
                    return (
                      <div key={groupId} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
                        <button onClick={() => toggleExpand(groupId)} className="w-full px-4 py-3 flex items-center justify-between overflow-hidden">
                          <div className="text-left min-w-0">
                            <p className="text-sm font-medium text-zinc-200 truncate">{group.walletName}</p>
                            <p className="text-xs text-zinc-500">{group.positions.length} stablecoin{group.positions.length !== 1 ? "s" : ""}</p>
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
                                  <span className="text-zinc-600 ml-1.5">{pos.pegCurrency}</span>
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
              <thead>
                <tr className="border-b border-zinc-800/50">
                  {orderedColumns.map((col) => {
                    const align = col.align === "right" ? "text-right" : "text-left";
                    const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";
                    const width = col.width ?? "";
                    return (
                      <th key={col.key} className={`px-4 py-2.5 text-xs font-medium text-zinc-500 uppercase tracking-wider ${align} ${hidden} ${width}`}>
                        {col.renderHeader ? col.renderHeader(ctx) : col.header}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                <tr className="bg-zinc-900/80">
                  {orderedColumns.map((col) => {
                    const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";
                    if (col.key === "name") {
                      return (
                        <td key={col.key} className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            <Landmark className="w-3.5 h-3.5 text-zinc-500" />
                            <span className="text-xs font-medium text-zinc-400">Bank Accounts</span>
                            {bankGroupIds.length > 1 && (
                              <button
                                onClick={() => toggleSectionGroups(bankGroupIds)}
                                className="p-0.5 rounded hover:bg-zinc-700/50 text-zinc-600 hover:text-zinc-400 transition-colors"
                                title={bankGroupIds.every((id) => expandedBanks.has(id)) ? "Collapse all groups" : "Expand all groups"}
                              >
                                {bankGroupIds.every((id) => expandedBanks.has(id)) ? <ChevronsDownUp className="w-3 h-3" /> : <ChevronsUpDown className="w-3 h-3" />}
                              </button>
                            )}
                          </div>
                        </td>
                      );
                    }
                    if (col.key === "value") {
                      return (
                        <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
                          <span className="text-xs text-zinc-600">{formatCurrency(bankTotal, primaryCurrency)}</span>
                        </td>
                      );
                    }
                    return <td key={col.key} className={hidden} />;
                  })}
                </tr>

                {bankRows.length === 0 ? (
                  <tr className="border-b border-zinc-800/30">
                    <td colSpan={orderedColumns.length} className="px-4 py-4 text-center">
                      <p className="text-xs text-zinc-600">No bank accounts yet — click Add to create one</p>
                    </td>
                  </tr>
                ) : (
                  bankRows.map((row) => {
                    const groupExpanded = row.type === "bank-group" && expandedBanks.has(row.id);
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
                        {groupExpanded && row.type === "bank-group" &&
                          row.data.accounts.map((acct) => (
                            <ExpandedBankRow key={acct.id} account={acct} orderedColumns={orderedColumns} ctx={ctx} onEdit={() => openEditBank(acct)} onDelete={() => handleDeleteBank(acct.id)} />
                          ))}
                      </Fragment>
                    );
                  })
                )}

                <tr className="bg-zinc-900/80">
                  {orderedColumns.map((col) => {
                    const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";
                    if (col.key === "name") {
                      return (
                        <td key={col.key} className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            <WalletIcon className="w-3.5 h-3.5 text-zinc-500" />
                            <span className="text-xs font-medium text-zinc-400">Exchange Deposits</span>
                            {exchGroupIds.length > 1 && (
                              <button
                                onClick={() => toggleSectionGroups(exchGroupIds)}
                                className="p-0.5 rounded hover:bg-zinc-700/50 text-zinc-600 hover:text-zinc-400 transition-colors"
                                title={exchGroupIds.every((id) => expandedBanks.has(id)) ? "Collapse all groups" : "Expand all groups"}
                              >
                                {exchGroupIds.every((id) => expandedBanks.has(id)) ? <ChevronsDownUp className="w-3 h-3" /> : <ChevronsUpDown className="w-3 h-3" />}
                              </button>
                            )}
                          </div>
                        </td>
                      );
                    }
                    if (col.key === "value") {
                      return (
                        <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
                          <span className="text-xs text-zinc-600">{formatCurrency(exchangeDepositTotal, primaryCurrency)}</span>
                        </td>
                      );
                    }
                    return <td key={col.key} className={hidden} />;
                  })}
                </tr>

                {exchRows.length === 0 ? (
                  <tr>
                    <td colSpan={orderedColumns.length} className="px-4 py-4 text-center">
                      <p className="text-xs text-zinc-600">{wallets.length === 0 ? "Add a wallet in Settings first" : "No exchange deposits yet — click Add to create one"}</p>
                    </td>
                  </tr>
                ) : (
                  exchRows.map((row) => {
                    const groupExpanded = row.type === "exchange-group" && expandedBanks.has(row.id);
                    return (
                      <Fragment key={row.id}>
                        <tr className="border-b border-zinc-800/30 last:border-0 group hover:bg-zinc-800/20 transition-colors">
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
                        {groupExpanded && row.type === "exchange-group" &&
                          row.data.deposits.map((dep) => (
                            <ExpandedExchangeRow key={dep.id} deposit={dep} orderedColumns={orderedColumns} ctx={ctx} onEdit={() => openEditExchange(dep)} onDelete={() => handleDeleteExchange(dep.id)} />
                          ))}
                      </Fragment>
                    );
                  })
                )}

                <tr className="bg-zinc-900/80">
                  {orderedColumns.map((col) => {
                    const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";
                    if (col.key === "name") {
                      return (
                        <td key={col.key} className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            <Briefcase className="w-3.5 h-3.5 text-zinc-500" />
                            <span className="text-xs font-medium text-zinc-400">Broker Deposits</span>
                            {brokerGroupIds.length > 1 && (
                              <button
                                onClick={() => toggleSectionGroups(brokerGroupIds)}
                                className="p-0.5 rounded hover:bg-zinc-700/50 text-zinc-600 hover:text-zinc-400 transition-colors"
                                title={brokerGroupIds.every((id) => expandedBanks.has(id)) ? "Collapse all groups" : "Expand all groups"}
                              >
                                {brokerGroupIds.every((id) => expandedBanks.has(id)) ? <ChevronsDownUp className="w-3 h-3" /> : <ChevronsUpDown className="w-3 h-3" />}
                              </button>
                            )}
                          </div>
                        </td>
                      );
                    }
                    if (col.key === "value") {
                      return (
                        <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
                          <span className="text-xs text-zinc-600">{formatCurrency(brokerDepositTotal, primaryCurrency)}</span>
                        </td>
                      );
                    }
                    return <td key={col.key} className={hidden} />;
                  })}
                </tr>

                {brokerDepRows.length === 0 ? (
                  <tr>
                    <td colSpan={orderedColumns.length} className="px-4 py-4 text-center">
                      <p className="text-xs text-zinc-600">{brokers.length === 0 ? "Add a broker in Settings first" : "No broker deposits yet — click Add to create one"}</p>
                    </td>
                  </tr>
                ) : (
                  brokerDepRows.map((row) => {
                    const groupExpanded = row.type === "broker-group" && expandedBanks.has(row.id);
                    return (
                      <Fragment key={row.id}>
                        <tr className="border-b border-zinc-800/30 last:border-0 group hover:bg-zinc-800/20 transition-colors">
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
                        {groupExpanded && row.type === "broker-group" &&
                          row.data.deposits.map((dep) => (
                            <ExpandedExchangeRow key={dep.id} deposit={dep} orderedColumns={orderedColumns} ctx={ctx} onEdit={() => openEditBrokerDeposit(dep)} onDelete={() => handleDeleteBrokerDeposit(dep.id)} />
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
                                <Coins className="w-3.5 h-3.5 text-zinc-500" />
                                <span className="text-xs font-medium text-zinc-400">Stablecoins</span>
                                {stablecoinGroupIds.length > 1 && (
                                  <button
                                    onClick={() => toggleSectionGroups(stablecoinGroupIds)}
                                    className="p-0.5 rounded hover:bg-zinc-700/50 text-zinc-600 hover:text-zinc-400 transition-colors"
                                    title={stablecoinGroupIds.every((id) => expandedBanks.has(id)) ? "Collapse all groups" : "Expand all groups"}
                                  >
                                    {stablecoinGroupIds.every((id) => expandedBanks.has(id)) ? <ChevronsDownUp className="w-3 h-3" /> : <ChevronsUpDown className="w-3 h-3" />}
                                  </button>
                                )}
                              </div>
                            </td>
                          );
                        }
                        if (col.key === "value") {
                          return (
                            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
                              <span className="text-xs text-zinc-600">{formatCurrency(stablecoinTotal, primaryCurrency)}</span>
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

      {/* ── Add Type Chooser ────────────────────────────────── */}
      <Modal
        open={addChooserOpen}
        onClose={() => setAddChooserOpen(false)}
        title="What would you like to add?"
      >
        <div className="space-y-2">
          <button
            onClick={openCreateBank}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/50 transition-colors text-left"
          >
            <Landmark className="w-5 h-5 text-zinc-400 shrink-0" />
            <div>
              <p className="text-sm font-medium text-zinc-200">Bank Account</p>
              <p className="text-xs text-zinc-500">Savings, checking, or other bank accounts</p>
            </div>
          </button>
          <button
            onClick={openCreateExchange}
            disabled={wallets.length === 0}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/50 disabled:opacity-40 disabled:hover:border-zinc-800 disabled:hover:bg-transparent transition-colors text-left"
          >
            <WalletIcon className="w-5 h-5 text-zinc-400 shrink-0" />
            <div>
              <p className="text-sm font-medium text-zinc-200">Exchange Deposit</p>
              <p className="text-xs text-zinc-500">
                {wallets.length === 0
                  ? "Add a wallet in Settings first"
                  : "Fiat deposits on crypto exchanges"}
              </p>
            </div>
          </button>
          <button
            onClick={openCreateBrokerDeposit}
            disabled={brokers.length === 0}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/50 disabled:opacity-40 disabled:hover:border-zinc-800 disabled:hover:bg-transparent transition-colors text-left"
          >
            <Briefcase className="w-5 h-5 text-zinc-400 shrink-0" />
            <div>
              <p className="text-sm font-medium text-zinc-200">Broker Deposit</p>
              <p className="text-xs text-zinc-500">
                {brokers.length === 0
                  ? "Add a broker in Settings first"
                  : "Uninvested cash on stock brokers"}
              </p>
            </div>
          </button>
        </div>
      </Modal>

      {/* ── Bank Account Modal ─────────────────────────────── */}
      <BankAccountModal
        open={bankModalOpen}
        onClose={() => setBankModalOpen(false)}
        editing={editingBank}
        existingBankNames={[...new Set(bankAccounts.map((b) => b.bank_name))]}
      />

      {/* ── Exchange Deposit Modal ─────────────────────────── */}
      <ExchangeDepositModal
        open={exchModalOpen}
        onClose={() => setExchModalOpen(false)}
        editing={editingExch}
        wallets={wallets}
      />

      {/* ── Broker Deposit Modal ──────────────────────────── */}
      <BrokerDepositModal
        open={brokerDepModalOpen}
        onClose={() => setBrokerDepModalOpen(false)}
        editing={editingBrokerDep}
        brokers={brokers}
      />
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════
// NOTE: BankAccountModal, ExchangeDepositModal, BrokerDepositModal
// extracted to separate files for reuse by AccountsView
// ═══════════════════════════════════════════════════════════════

// Expanded Bank Account Sub-Row
// ═══════════════════════════════════════════════════════════════
// Renders an individual bank account within an expanded group,
// using key-based column switching so cells stay aligned even
// when the user reorders or hides columns.

function ExpandedBankRow({
  account,
  orderedColumns,
  ctx,
  onEdit,
  onDelete,
}: {
  account: BankAccount;
  orderedColumns: ColumnDef<CashRow>[];
  ctx: RenderContext;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const valueInBase = convertToBase(
    account.balance,
    account.currency,
    ctx.primaryCurrency,
    ctx.fxRates
  );

  return (
    <tr className="bg-zinc-950/50 border-b border-zinc-800/20 group">
      {orderedColumns.map((col) => {
        const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";

        if (col.key === "name") {
          return (
            <td key={col.key} className="pl-10 pr-4 py-2">
              <span className="text-xs text-zinc-400">{account.name}</span>
            </td>
          );
        }
        if (col.key === "currency") {
          return (
            <td key={col.key} className={`px-4 py-2 text-left ${hidden}`}>
              <span className="text-xs text-zinc-500">{account.currency}</span>
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
                  showConverted ? "text-zinc-500" : "text-zinc-400"
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
                <span className="text-xs text-zinc-600">—</span>
              )}
            </td>
          );
        }
        if (col.key === "region") {
          return (
            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
              <span className="text-xs text-zinc-500">{countryName(account.region)}</span>
            </td>
          );
        }
        if (col.key === "actions") {
          return (
            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
              <div className="flex items-center justify-end gap-1 md:opacity-0 md:pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto transition-opacity">
                <button
                  onClick={onEdit}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <ConfirmButton
                  onConfirm={onDelete}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </ConfirmButton>
              </div>
            </td>
          );
        }
        return <td key={col.key} className={hidden} />;
      })}
    </tr>
  );
}

// ═══════════════════════════════════════════════════════════════
// Expanded Exchange Deposit Sub-Row
// ═══════════════════════════════════════════════════════════════

function ExpandedExchangeRow({
  deposit,
  orderedColumns,
  ctx,
  onEdit,
  onDelete,
}: {
  deposit: { id: string; currency: string; amount: number; apy: number };
  orderedColumns: ColumnDef<CashRow>[];
  ctx: RenderContext;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const valueInBase = convertToBase(
    deposit.amount,
    deposit.currency,
    ctx.primaryCurrency,
    ctx.fxRates
  );

  return (
    <tr className="bg-zinc-950/50 border-b border-zinc-800/20 group">
      {orderedColumns.map((col) => {
        const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";

        if (col.key === "name") {
          return (
            <td key={col.key} className="pl-10 pr-4 py-2">
              <span className="text-xs text-zinc-400">
                {deposit.currency} deposit
              </span>
            </td>
          );
        }
        if (col.key === "currency") {
          return (
            <td key={col.key} className={`px-4 py-2 text-left ${hidden}`}>
              <span className="text-xs text-zinc-500">{deposit.currency}</span>
            </td>
          );
        }
        if (col.key === "balance") {
          return (
            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
              <span className="text-xs text-zinc-400 tabular-nums">
                {formatCurrency(deposit.amount, deposit.currency)}
              </span>
            </td>
          );
        }
        if (col.key === "value") {
          const showConverted = deposit.currency !== ctx.primaryCurrency;
          return (
            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
              <span
                className={`text-xs tabular-nums ${
                  showConverted ? "text-zinc-500" : "text-zinc-400"
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
              {deposit.apy > 0 ? (
                <span className="text-xs text-emerald-400/70">
                  {deposit.apy}%
                </span>
              ) : (
                <span className="text-xs text-zinc-600">—</span>
              )}
            </td>
          );
        }
        if (col.key === "actions") {
          return (
            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
              <div className="flex items-center justify-end gap-1 md:opacity-0 md:pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto transition-opacity">
                <button
                  onClick={onEdit}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <ConfirmButton
                  onConfirm={onDelete}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </ConfirmButton>
              </div>
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

  // Balance display: single ticker → "TICKER qty", mixed → formatted total
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
    >
      {orderedColumns.map((col) => {
        const hidden = col.hiddenBelow ? HIDDEN_BELOW[col.hiddenBelow] : "";

        if (col.key === "name") {
          return (
            <td key={col.key} className="px-4 py-2.5">
              <div className="flex items-center gap-2">
                <Chevron className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="text-sm font-medium text-zinc-200">{group.walletName}</span>
                <span className="text-xs text-zinc-600">
                  {group.positions.length} stablecoin{group.positions.length !== 1 ? "s" : ""}
                </span>
              </div>
            </td>
          );
        }
        if (col.key === "currency") {
          return (
            <td key={col.key} className={`px-4 py-2.5 text-left ${hidden}`}>
              <span className="text-xs text-zinc-500">{group.pegCurrency}</span>
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
                <span className="text-sm text-zinc-600">—</span>
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
              <span className="text-xs text-zinc-500">{position.pegCurrency}</span>
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
              <span className="text-xs text-zinc-500 tabular-nums">
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
                <span className="text-xs text-zinc-600">—</span>
              )}
            </td>
          );
        }
        return <td key={col.key} className={hidden} />;
      })}
    </tr>
  );
}
