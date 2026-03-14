"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Bitcoin,
  TrendingUp,
  Landmark,
  Building2,
  Shield,
  Pencil,
  Plus,
  Trash2,
  ArrowRightLeft,
} from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, fmtCurrencyCompact, fmtPct, changeColorClass } from "@/lib/format";
import type { FXRates } from "@/lib/prices/fx";
import { buildInstitutionGroups } from "@/lib/portfolio/institution-grouping";
import { EditInstitutionModal } from "@/components/accounts/edit-institution-modal";
import { AddInstitutionModal } from "@/components/accounts/add-institution-modal";
import { AddWalletModal } from "@/components/accounts/add-wallet-modal";
import { EditWalletModal } from "@/components/accounts/edit-wallet-modal";
import { PositionEditor } from "@/components/crypto/position-editor";
import { AddCryptoModal } from "@/components/crypto/add-crypto-modal";
import { StockPositionEditor } from "@/components/stocks/stock-position-editor";
import { AddStockModal } from "@/components/stocks/add-stock-modal";
import { BankAccountModal } from "@/components/cash/bank-account-modal";
import { ExchangeDepositModal } from "@/components/cash/exchange-deposit-modal";
import { BrokerDepositModal } from "@/components/cash/broker-deposit-modal";
import { Modal } from "@/components/ui/modal";
import { useRouter } from "next/navigation";
import { TransferDialog } from "@/components/ui/transfer-dialog";
import { deleteCryptoAsset } from "@/lib/actions/crypto";
import { deleteStockAsset } from "@/lib/actions/stocks";
import { deleteBankAccount } from "@/lib/actions/bank-accounts";
import { deleteExchangeDeposit } from "@/lib/actions/exchange-deposits";
import { deleteBrokerDeposit } from "@/lib/actions/broker-deposits";
import type {
  InstitutionWithRoles,
  CryptoAssetWithPositions,
  StockAssetWithPositions,
  Wallet,
  Broker,
  BankAccount,
  ExchangeDeposit,
  BrokerDeposit,
  CoinGeckoPriceData,
  YahooStockPriceData,
  TransferMode,
} from "@/lib/types";
import { useSharedView } from "@/components/shared-view-context";

// ── Props ────────────────────────────────────────────────

interface AccountsViewProps {
  institutions: InstitutionWithRoles[];
  cryptoAssets: CryptoAssetWithPositions[];
  stockAssets: StockAssetWithPositions[];
  wallets: Wallet[];
  brokers: Broker[];
  bankAccounts: BankAccount[];
  exchangeDeposits: ExchangeDeposit[];
  brokerDeposits: BrokerDeposit[];
  cryptoPrices: CoinGeckoPriceData;
  stockPrices: YahooStockPriceData;
  fxRates: FXRates;
  primaryCurrency: string;
  /** Live EUR/USD rate for write-time cashflow computation */
  eurUsdRate?: number;
}

// ── Component ────────────────────────────────────────────

export function AccountsView({
  institutions,
  cryptoAssets,
  stockAssets,
  wallets,
  brokers,
  bankAccounts,
  exchangeDeposits,
  brokerDeposits,
  cryptoPrices,
  stockPrices,
  fxRates,
  primaryCurrency,
  eurUsdRate,
}: AccountsViewProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [editingInstitution, setEditingInstitution] = useState<InstitutionWithRoles | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showAddWalletModal, setShowAddWalletModal] = useState(false);
  const [editingStandaloneWallet, setEditingStandaloneWallet] = useState<Wallet | null>(null);

  // ── CRUD state ─────────────────────────────────────────
  // Crypto
  const [editingCryptoAsset, setEditingCryptoAsset] = useState<CryptoAssetWithPositions | null>(null);
  const [showAddCrypto, setShowAddCrypto] = useState<string | null>(null); // institution ID

  // Stocks
  const [editingStockAsset, setEditingStockAsset] = useState<StockAssetWithPositions | null>(null);
  const [showAddStock, setShowAddStock] = useState<string | null>(null);

  // Cash
  const [editingBankAccount, setEditingBankAccount] = useState<BankAccount | null>(null);
  const [showAddBankAccount, setShowAddBankAccount] = useState<string | null>(null);
  const [editingExchangeDeposit, setEditingExchangeDeposit] = useState<ExchangeDeposit | null>(null);
  const [showAddExchangeDeposit, setShowAddExchangeDeposit] = useState<string | null>(null);
  const [editingBrokerDeposit, setEditingBrokerDeposit] = useState<BrokerDeposit | null>(null);
  const [showAddBrokerDeposit, setShowAddBrokerDeposit] = useState<string | null>(null);
  const [showAllInstitutions, setShowAllInstitutions] = useState(false);

  // Transfer
  const router = useRouter();
  const [transferInstId, setTransferInstId] = useState<string | null>(null);

  const { isReadOnly } = useSharedView();

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<{
    type: "crypto" | "stock" | "bank" | "exchange_deposit" | "broker_deposit";
    id: string;
    label: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteAdjustment, setDeleteAdjustment] = useState(false);

  // Active row (expand-to-edit: click a row to reveal actions)
  const [activeRowId, setActiveRowId] = useState<string | null>(null);

  // ── Derived data for modals ────────────────────────────
  const existingSubcategories = useMemo(
    () => [
      ...new Set([
        ...cryptoAssets.map((a) => a.subcategory).filter(Boolean),
        ...stockAssets.map((a) => a.subcategory).filter(Boolean),
      ]),
    ] as string[],
    [cryptoAssets, stockAssets]
  );

  const existingChains = useMemo(
    () => [...new Set(cryptoAssets.map((a) => a.chain).filter(Boolean))] as string[],
    [cryptoAssets]
  );

  const existingTags = useMemo(
    () => [...new Set(stockAssets.flatMap((a) => a.tags ?? []))] as string[],
    [stockAssets]
  );

  const existingBankNames = useMemo(
    () => [...new Set(bankAccounts.map((b) => b.bank_name).filter(Boolean))] as string[],
    [bankAccounts]
  );

  // ── Institution-scoped lookups ─────────────────────────
  function walletsForInstitution(instId: string): Wallet[] {
    if (instId.startsWith("__wallet__")) {
      const walletId = instId.replace("__wallet__", "");
      return wallets.filter((w) => w.id === walletId);
    }
    return wallets.filter((w) => w.institution_id === instId);
  }

  function brokersForInstitution(instId: string): Broker[] {
    return brokers.filter((b) => b.institution_id === instId);
  }

  // ── Delete handler ─────────────────────────────────────
  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const adjOpts = deleteAdjustment ? { isAdjustment: true } : undefined;
      const deleteFns: Record<string, (id: string, opts?: { isAdjustment?: boolean }) => Promise<unknown>> = {
        crypto: deleteCryptoAsset,
        stock: deleteStockAsset,
        bank: deleteBankAccount,
        exchange_deposit: deleteExchangeDeposit,
        broker_deposit: deleteBrokerDeposit,
      };
      await deleteFns[deleteTarget.type](deleteTarget.id, adjOpts);
      toast.success(`Deleted ${deleteTarget.label}`);
      setDeleteTarget(null);
      setDeleteAdjustment(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  // ── Build institution groups ──────────────────────────
  const groups = useMemo(
    () => buildInstitutionGroups({
      institutions, cryptoAssets, stockAssets, wallets, brokers,
      bankAccounts, exchangeDeposits, brokerDeposits,
      cryptoPrices, stockPrices, fxRates, primaryCurrency,
    }),
    [
      institutions, cryptoAssets, stockAssets, wallets, brokers,
      bankAccounts, exchangeDeposits, brokerDeposits,
      cryptoPrices, stockPrices, fxRates, primaryCurrency,
    ],
  );

  // ── Expand/collapse ────────────────────────────────────
  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Total across all institutions
  const grandTotal = groups.reduce((sum, g) => sum + g.totalValue, 0);
  const nonEmptyGroups = groups.filter(
    (g) => g.crypto.length > 0 || g.stocks.length > 0 || g.cash.length > 0
  );
  const totalCrypto = groups.reduce((sum, g) => sum + g.crypto.reduce((s, c) => s + c.valueBase, 0), 0);
  const totalStocks = groups.reduce((sum, g) => sum + g.stocks.reduce((s, st) => s + st.valueBase, 0), 0);
  const totalCash = groups.reduce((sum, g) => sum + g.cash.reduce((s, c) => s + c.valueBase, 0), 0);
  const totalAssets = groups.reduce((sum, g) => sum + g.crypto.length + g.stocks.length + g.cash.length, 0);
  const grandChange24h = groups.reduce(
    (acc, g) => ({ valueChange: acc.valueChange + g.change24h.valueChange }),
    { valueChange: 0 },
  );
  const grandPrev = grandTotal - grandChange24h.valueChange;
  const grandPercentChange = grandPrev > 0 ? (grandChange24h.valueChange / grandPrev) * 100 : 0;

  return (
    <div>
      {/* Summary stat card */}
      <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-4 md:p-5">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
            Portfolio Total
          </p>
          <div className="flex items-baseline gap-3 mt-1">
            <p className="text-3xl font-semibold text-zinc-100 tabular-nums">
              {formatCurrency(grandTotal, primaryCurrency)}
            </p>
            {grandChange24h.valueChange !== 0 && (
              <span className={`text-sm tabular-nums ${changeColorClass(grandPercentChange)}`}>
                {grandChange24h.valueChange > 0 ? "+" : ""}{fmtCurrencyCompact(grandChange24h.valueChange, primaryCurrency)}
                <span className="ml-1 font-normal">({fmtPct(grandPercentChange)})</span>
              </span>
            )}
          </div>

          {/* Allocation breakdown — stacked bar + legend */}
          {grandTotal > 0 && (() => {
            const slices = ([
              { label: "Crypto", value: totalCrypto, bar: "bg-orange-500/70", dot: "bg-orange-500" },
              { label: "Equities", value: totalStocks, bar: "bg-blue-500/70", dot: "bg-blue-500" },
              { label: "Cash", value: totalCash, bar: "bg-emerald-500/70", dot: "bg-emerald-500" },
            ] as const).filter(s => s.value > 0).map(s => ({ ...s, pct: (s.value / grandTotal) * 100 }));
            return (
              <div className="mt-4">
                {/* Stacked bar */}
                <div className="flex h-1.5 rounded-full overflow-hidden bg-zinc-800/50 gap-px max-w-md">
                  {slices.map(s => (
                    <div key={s.label} className={`${s.bar} rounded-sm`} style={{ width: `${s.pct}%` }} />
                  ))}
                </div>
                {/* Legend + stats */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px]">
                  {slices.map(s => (
                    <span key={s.label} className="flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                      <span className="text-zinc-500">{s.label}</span>
                      <span className="text-zinc-400 tabular-nums">{s.pct.toFixed(0)}%</span>
                      <span className="hidden md:inline text-zinc-600 tabular-nums">{formatCurrency(s.value, primaryCurrency)}</span>
                    </span>
                  ))}
                  <span className="hidden md:flex items-center gap-x-4 text-zinc-600">
                    <span>·</span>
                    <span>{nonEmptyGroups.length} institution{nonEmptyGroups.length !== 1 ? "s" : ""}, {totalAssets} asset{totalAssets !== 1 ? "s" : ""}</span>
                  </span>
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Action bar — matches crypto/stocks/cash placement */}
      {!isReadOnly && (
        <div className="flex items-center justify-end gap-2 mt-2 mb-3">
          <button
            onClick={() => setShowAddWalletModal(true)}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-amber-800/50 bg-amber-950/20 hover:bg-amber-950/40 text-amber-400 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Wallet
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Institution
          </button>
        </div>
      )}

      {/* Institution cards */}
      <div className="space-y-2">
      {(() => {
        const MIN_VISIBLE_VALUE = 1000; // base currency (EUR)
        const MIN_VISIBLE_COUNT = 10;  // always show top N by value
        const visibleGroups = groups.filter((g, i) => i < MIN_VISIBLE_COUNT || g.totalValue >= MIN_VISIBLE_VALUE);
        const hiddenGroups = groups.filter((g, i) => i >= MIN_VISIBLE_COUNT && g.totalValue < MIN_VISIBLE_VALUE);
        const displayGroups = showAllInstitutions ? groups : visibleGroups;
        return (<>
      {displayGroups.map((group) => {
        const { institution, crypto, stocks, cash, totalValue, change24h } = group;
        const isEmpty = crypto.length === 0 && stocks.length === 0 && cash.length === 0;
        const isExpanded = expandedIds.has(institution.id);
        const isSelfCustody = institution.id.startsWith("__wallet__");
        const HeaderIcon = isSelfCustody ? Shield : Building2;
        const cryptoValue = crypto.reduce((s, c) => s + c.valueBase, 0);
        const stocksValue = stocks.reduce((s, st) => s + st.valueBase, 0);
        const cashValue = cash.reduce((s, c) => s + c.valueBase, 0);
        const assetCounts = [
          crypto.length > 0 ? `${crypto.length} crypto` : "",
          stocks.length > 0 ? `${stocks.length} equit${stocks.length === 1 ? "y" : "ies"}` : "",
          cash.length > 0 ? `${cash.length} cash` : "",
        ].filter(Boolean).join(" · ");

        return (
          <div
            key={institution.id}
            className={`group border rounded-xl ${
              isSelfCustody
                ? "border-amber-900/40 bg-amber-950/10"
                : "border-zinc-800 bg-zinc-900/50"
            }`}
          >
            {/* Clickable header */}
            <div
              role="button"
              tabIndex={0}
              aria-expanded={isExpanded}
              onClick={() => toggleExpand(institution.id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(institution.id); } }}
              className="w-full px-4 py-2.5 hover:bg-zinc-800/30 transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-zinc-500 shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />
                  )}
                  <HeaderIcon className={`w-4 h-4 shrink-0 ${isSelfCustody ? "text-amber-500/70" : "text-zinc-400"}`} />
                  <span className="font-medium text-zinc-100 truncate">
                    {institution.name}
                  </span>
                  {/* Role badges + asset counts — only when expanded */}
                  {isExpanded && (
                    <>
                      <div className="hidden md:flex gap-1.5">
                        {isSelfCustody ? (
                          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-500/70">
                            self-custody
                          </span>
                        ) : (
                          institution.roles.map((role) => (
                            <span
                              key={role}
                              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500"
                            >
                              {role}
                            </span>
                          ))
                        )}
                      </div>
                      {assetCounts && (
                        <span className="hidden md:inline text-[11px] text-zinc-600">{assetCounts}</span>
                      )}
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0 pl-4">
                  {/* Transfer — hover-reveal */}
                  {!isReadOnly && !isEmpty && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setTransferInstId(institution.id);
                      }}
                      className={`p-1.5 rounded-lg text-zinc-600 hover:text-blue-400 hover:bg-zinc-800 transition-colors ${
                        isExpanded ? "opacity-100" : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto"
                      }`}
                      title="Transfer"
                    >
                      <ArrowRightLeft className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {/* Edit institution — hover-reveal */}
                  {!isReadOnly && !isSelfCustody && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingInstitution(institution);
                      }}
                      className={`p-1.5 rounded-lg text-zinc-600 hover:text-blue-400 hover:bg-zinc-800 transition-colors ${
                        isExpanded ? "opacity-100" : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto"
                      }`}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {/* Edit standalone wallet — hover-reveal */}
                  {!isReadOnly && isSelfCustody && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const realId = institution.id.replace("__wallet__", "");
                        const w = wallets.find((w) => w.id === realId);
                        if (w) setEditingStandaloneWallet(w);
                      }}
                      className={`p-1.5 rounded-lg text-zinc-600 hover:text-amber-400 hover:bg-amber-950/30 transition-colors ${
                        isExpanded ? "opacity-100" : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto"
                      }`}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <div className="text-right">
                    {isEmpty ? (
                      <span className="text-sm text-zinc-600">No assets</span>
                    ) : (
                      <>
                        <span className="text-sm font-medium text-zinc-200">
                          {formatCurrency(totalValue, primaryCurrency)}
                        </span>
                        <p className={`text-xs tabular-nums ${change24h.valueChange !== 0 ? changeColorClass(change24h.percentChange) : "invisible"}`}>
                          {change24h.valueChange !== 0
                            ? `${change24h.valueChange > 0 ? "+" : ""}${fmtCurrencyCompact(change24h.valueChange, primaryCurrency)} (${fmtPct(change24h.percentChange)})`
                            : "\u00A0"}
                        </p>
                      </>
                    )}
                  </div>
                </div>
              </div>
              {/* Allocation bar — only when expanded */}
              {isExpanded && !isEmpty && totalValue > 0 && (
                <div className="flex h-1 rounded-full overflow-hidden bg-zinc-800/30 mt-2 ml-7 max-w-[120px]">
                  {cryptoValue > 0 && (
                    <div className="h-full bg-orange-500/50" style={{ width: `${(cryptoValue / totalValue) * 100}%` }} />
                  )}
                  {stocksValue > 0 && (
                    <div className="h-full bg-blue-500/50" style={{ width: `${(stocksValue / totalValue) * 100}%` }} />
                  )}
                  {cashValue > 0 && (
                    <div className="h-full bg-emerald-500/50" style={{ width: `${(cashValue / totalValue) * 100}%` }} />
                  )}
                </div>
              )}
            </div>

            {/* Expanded content */}
            {isExpanded && (
              <div className="px-4 pb-4 space-y-4 border-t border-zinc-800/50">
                {/* Crypto section */}
                {crypto.length > 0 && (
                  <AssetSection
                    icon={<Bitcoin className="w-3.5 h-3.5" />}
                    label="Crypto"
                    count={crypto.length}
                    totalValue={crypto.reduce((s, c) => s + c.valueBase, 0)}
                    primaryCurrency={primaryCurrency}
                  >
                    {crypto
                      .sort((a, b) => b.valueBase - a.valueBase)
                      .map((row) => (
                        <div key={row.positionId}>
                          <div
                            onClick={() => setActiveRowId(activeRowId === row.positionId ? null : row.positionId)}
                            className={`flex items-center py-1.5 text-sm cursor-pointer rounded-md px-1 -mx-1 transition-colors ${
                              activeRowId === row.positionId ? "bg-zinc-800/50" : "hover:bg-zinc-800/30"
                            }`}
                          >
                            <span className="text-zinc-200 font-medium w-16 shrink-0">{row.ticker}</span>
                            <span className="hidden md:inline text-zinc-500 truncate flex-1 min-w-0">
                              {row.name}
                              {row.apy > 0 && (
                                <span className="text-emerald-500/70 text-xs ml-2">{row.apy}% APY</span>
                              )}
                            </span>
                            <span className="flex-1 md:hidden" />
                            {!isReadOnly && (
                              <span className="hidden md:flex items-center gap-0.5 shrink-0">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const asset = cryptoAssets.find((a) => a.id === row.assetId);
                                    if (asset) setEditingCryptoAsset(asset);
                                  }}
                                  className="p-1 rounded text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 transition-colors"
                                  title="Edit positions"
                                >
                                  <Pencil className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setDeleteTarget({ type: "crypto", id: row.assetId, label: `${row.ticker} (${row.name})` });
                                  }}
                                  className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                                  title="Remove asset"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </span>
                            )}
                            <span className="hidden md:inline text-zinc-500 text-xs tabular-nums w-20 text-right shrink-0">
                              ×{formatQuantity(row.quantity)}
                            </span>
                            <span className="text-right shrink-0 pl-2 min-w-[7rem]">
                              <span className="text-zinc-200 tabular-nums text-sm">
                                {formatCurrency(row.valueBase, primaryCurrency)}
                              </span>
                              {row.change24h !== 0 && (
                                <span className={`block text-xs tabular-nums ${changeColorClass(row.change24h)}`}>
                                  {fmtPct(row.change24h)}
                                </span>
                              )}
                            </span>
                          </div>
                          {activeRowId === row.positionId && (
                            <div className="flex items-center gap-2 py-1.5 pl-1 mb-1">
                              <span className="md:hidden text-xs text-zinc-500 truncate min-w-0">
                                {row.name}
                                {row.apy > 0 && <span className="text-emerald-500/70 ml-1">{row.apy}% APY</span>}
                                <span className="text-zinc-600 mx-1">·</span>
                                ×{formatQuantity(row.quantity)}
                              </span>
                              <span className="flex-1" />
                              {!isReadOnly && (
                                <span className="md:hidden flex items-center gap-2">
                                  <button
                                    onClick={() => {
                                      const asset = cryptoAssets.find((a) => a.id === row.assetId);
                                      if (asset) { setActiveRowId(null); setEditingCryptoAsset(asset); }
                                    }}
                                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
                                  >
                                    <Pencil className="w-3 h-3" />
                                    Edit
                                  </button>
                                  <button
                                    onClick={() => { setActiveRowId(null); setDeleteTarget({ type: "crypto", id: row.assetId, label: `${row.ticker} (${row.name})` }); }}
                                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md text-zinc-500 hover:bg-red-950/40 hover:text-red-400 transition-colors"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                    Delete
                                  </button>
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                  </AssetSection>
                )}

                {/* Stocks section */}
                {stocks.length > 0 && (
                  <AssetSection
                    icon={<TrendingUp className="w-3.5 h-3.5" />}
                    label="Equities"
                    count={stocks.length}
                    totalValue={stocks.reduce((s, st) => s + st.valueBase, 0)}
                    primaryCurrency={primaryCurrency}
                  >
                    {stocks
                      .sort((a, b) => b.valueBase - a.valueBase)
                      .map((row) => (
                        <div key={row.positionId}>
                          <div
                            onClick={() => setActiveRowId(activeRowId === row.positionId ? null : row.positionId)}
                            className={`flex items-center py-1.5 text-sm cursor-pointer rounded-md px-1 -mx-1 transition-colors ${
                              activeRowId === row.positionId ? "bg-zinc-800/50" : "hover:bg-zinc-800/30"
                            }`}
                          >
                            <span className="text-zinc-200 font-medium w-16 shrink-0">{row.ticker}</span>
                            <span className="w-11 shrink-0">
                              {row.currency !== primaryCurrency && (
                                <span className="text-[10px] uppercase tracking-wider px-1 py-0.5 rounded bg-zinc-800 text-zinc-500 font-normal">
                                  {row.currency}
                                </span>
                              )}
                            </span>
                            <span className="hidden md:inline text-zinc-500 truncate flex-1 min-w-0">{row.name}</span>
                            <span className="flex-1 md:hidden" />
                            {!isReadOnly && (
                              <span className="hidden md:flex items-center gap-0.5 shrink-0">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const asset = stockAssets.find((a) => a.id === row.assetId);
                                    if (asset) setEditingStockAsset(asset);
                                  }}
                                  className="p-1 rounded text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 transition-colors"
                                  title="Edit positions"
                                >
                                  <Pencil className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setDeleteTarget({ type: "stock", id: row.assetId, label: `${row.ticker} (${row.name})` });
                                  }}
                                  className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                                  title="Remove asset"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </span>
                            )}
                            <span className="hidden md:inline text-zinc-500 text-xs tabular-nums w-20 text-right shrink-0">
                              ×{formatQuantity(row.quantity, 2)}
                            </span>
                            <span className="text-right shrink-0 pl-2 min-w-[7rem]">
                              <span className="text-zinc-200 tabular-nums text-sm">
                                {formatCurrency(row.valueBase, primaryCurrency)}
                              </span>
                              {row.change24h !== 0 && (
                                <span className={`block text-xs tabular-nums ${changeColorClass(row.change24h)}`}>
                                  {fmtPct(row.change24h)}
                                </span>
                              )}
                            </span>
                          </div>
                          {activeRowId === row.positionId && (
                            <div className="flex items-center gap-2 py-1.5 pl-1 mb-1">
                              <span className="md:hidden text-xs text-zinc-500 truncate min-w-0">
                                {row.name}
                                <span className="text-zinc-600 mx-1">·</span>
                                ×{formatQuantity(row.quantity, 2)}
                              </span>
                              <span className="flex-1" />
                              {!isReadOnly && (
                                <span className="md:hidden flex items-center gap-2">
                                  <button
                                    onClick={() => {
                                      const asset = stockAssets.find((a) => a.id === row.assetId);
                                      if (asset) { setActiveRowId(null); setEditingStockAsset(asset); }
                                    }}
                                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
                                  >
                                    <Pencil className="w-3 h-3" />
                                    Edit
                                  </button>
                                  <button
                                    onClick={() => { setActiveRowId(null); setDeleteTarget({ type: "stock", id: row.assetId, label: `${row.ticker} (${row.name})` }); }}
                                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md text-zinc-500 hover:bg-red-950/40 hover:text-red-400 transition-colors"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                    Delete
                                  </button>
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                  </AssetSection>
                )}

                {/* Cash section */}
                {cash.length > 0 && (
                  <AssetSection
                    icon={<Landmark className="w-3.5 h-3.5" />}
                    label="Cash"
                    count={cash.length}
                    totalValue={cash.reduce((s, c) => s + c.valueBase, 0)}
                    primaryCurrency={primaryCurrency}
                  >
                    {cash
                      .sort((a, b) => b.valueBase - a.valueBase)
                      .map((row) => (
                        <div key={row.id}>
                          <div
                            onClick={() => setActiveRowId(activeRowId === row.id ? null : row.id)}
                            className={`flex items-center py-1.5 text-sm cursor-pointer rounded-md px-1 -mx-1 transition-colors ${
                              activeRowId === row.id ? "bg-zinc-800/50" : "hover:bg-zinc-800/30"
                            }`}
                          >
                            <span className="text-zinc-200 font-medium truncate min-w-0 md:shrink-0 md:truncate-none">
                              {row.label}
                              <span className="text-[10px] uppercase tracking-wider px-1 py-0.5 rounded bg-zinc-800 text-zinc-500 ml-1.5 font-normal">
                                {row.currency}
                              </span>
                            </span>
                            <span className="hidden md:inline text-zinc-500 truncate flex-1 min-w-0 ml-3">
                              {row.apy > 0 && (
                                <span className="text-emerald-500/70 text-xs">{row.apy}% APY</span>
                              )}
                            </span>
                            <span className="flex-1 md:hidden" />
                            {!isReadOnly && (
                              <span className="hidden md:flex items-center gap-0.5 shrink-0">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (row.type === "bank") {
                                      const acct = bankAccounts.find((b) => b.id === row.id);
                                      if (acct) setEditingBankAccount(acct);
                                    } else if (row.type === "exchange_deposit") {
                                      const dep = exchangeDeposits.find((d) => d.id === row.id);
                                      if (dep) setEditingExchangeDeposit(dep);
                                    } else {
                                      const dep = brokerDeposits.find((d) => d.id === row.id);
                                      if (dep) setEditingBrokerDeposit(dep);
                                    }
                                  }}
                                  className="p-1 rounded text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 transition-colors"
                                  title="Edit"
                                >
                                  <Pencil className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setDeleteTarget({ type: row.type, id: row.id, label: row.label });
                                  }}
                                  className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                                  title="Remove"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </span>
                            )}
                            {row.currency !== primaryCurrency ? (
                              <span className="hidden md:inline text-zinc-500 text-xs tabular-nums w-20 text-right shrink-0">
                                {formatCurrency(row.amount, row.currency)}
                              </span>
                            ) : (
                              <span className="hidden md:inline w-20 shrink-0" />
                            )}
                            <span className="text-zinc-200 tabular-nums w-28 text-right shrink-0 pl-2">
                              {formatCurrency(row.valueBase, primaryCurrency)}
                            </span>
                          </div>
                          {activeRowId === row.id && (
                            <div className="flex items-center gap-2 py-1.5 pl-1 mb-1">
                              <span className="md:hidden text-xs text-zinc-500 truncate min-w-0">
                                {row.apy > 0 && <span className="text-emerald-500/70">{row.apy}% APY</span>}
                                {row.apy > 0 && row.currency !== primaryCurrency && <span className="text-zinc-600 mx-1">·</span>}
                                {row.currency !== primaryCurrency && formatCurrency(row.amount, row.currency)}
                              </span>
                              <span className="flex-1" />
                              {!isReadOnly && (
                                <span className="md:hidden flex items-center gap-2">
                                  <button
                                    onClick={() => {
                                      setActiveRowId(null);
                                      if (row.type === "bank") {
                                        const acct = bankAccounts.find((b) => b.id === row.id);
                                        if (acct) setEditingBankAccount(acct);
                                      } else if (row.type === "exchange_deposit") {
                                        const dep = exchangeDeposits.find((d) => d.id === row.id);
                                        if (dep) setEditingExchangeDeposit(dep);
                                      } else {
                                        const dep = brokerDeposits.find((d) => d.id === row.id);
                                        if (dep) setEditingBrokerDeposit(dep);
                                      }
                                    }}
                                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
                                  >
                                    <Pencil className="w-3 h-3" />
                                    Edit
                                  </button>
                                  <button
                                    onClick={() => { setActiveRowId(null); setDeleteTarget({ type: row.type, id: row.id, label: row.label }); }}
                                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md text-zinc-500 hover:bg-red-950/40 hover:text-red-400 transition-colors"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                    Delete
                                  </button>
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                  </AssetSection>
                )}

                {/* Empty state */}
                {crypto.length === 0 && stocks.length === 0 && cash.length === 0 && (
                  <div className="pt-3 text-center text-sm text-zinc-600">
                    No assets linked to this institution yet
                  </div>
                )}

                {/* Add asset dropdown */}
                {!isReadOnly && (
                  <AddAssetDropdown
                    institution={institution}
                    isSelfCustody={isSelfCustody}
                    onAddCrypto={() => setShowAddCrypto(institution.id)}
                    onAddStock={() => setShowAddStock(institution.id)}
                    onAddBankAccount={() => setShowAddBankAccount(institution.id)}
                    onAddExchangeDeposit={() => setShowAddExchangeDeposit(institution.id)}
                    onAddBrokerDeposit={() => setShowAddBrokerDeposit(institution.id)}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}

      {hiddenGroups.length > 0 && (
        <button
          onClick={() => setShowAllInstitutions(!showAllInstitutions)}
          className="w-full flex items-center justify-center gap-2 py-2.5 text-sm text-zinc-400 hover:text-zinc-300 transition-colors"
        >
          {showAllInstitutions ? (
            <>
              <ChevronUp className="w-4 h-4" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown className="w-4 h-4" />
              Show {hiddenGroups.length} more
            </>
          )}
        </button>
      )}
      </>); })()}
      </div>

      {/* Empty state when no institutions */}
      {groups.length === 0 && (
        <div className="text-center py-16">
          <Building2 className="w-10 h-10 text-zinc-700 mx-auto mb-3" />
          <p className="text-zinc-500 text-sm">
            No institutions yet. Create one to get started.
          </p>
        </div>
      )}

      {/* ── Modals ──────────────────────────────────────── */}
      {!isReadOnly && (
        <>
          {/* Institution modals */}
          {editingInstitution && (
            <EditInstitutionModal
              open={!!editingInstitution}
              onClose={() => setEditingInstitution(null)}
              institution={editingInstitution}
              wallets={wallets}
            />
          )}
          <AddInstitutionModal
            open={showAddModal}
            onClose={() => setShowAddModal(false)}
          />
          <AddWalletModal
            open={showAddWalletModal}
            onClose={() => setShowAddWalletModal(false)}
          />
          {editingStandaloneWallet && (
            <EditWalletModal
              open={!!editingStandaloneWallet}
              onClose={() => setEditingStandaloneWallet(null)}
              wallet={editingStandaloneWallet}
            />
          )}

          {/* Crypto modals */}
          {editingCryptoAsset && (
            <PositionEditor
              open
              onClose={() => setEditingCryptoAsset(null)}
              asset={editingCryptoAsset}
              wallets={wallets}
              existingSubcategories={existingSubcategories}
              existingChains={existingChains}
            />
          )}
          {showAddCrypto && (
            <AddCryptoModal
              open
              onClose={() => setShowAddCrypto(null)}
              wallets={walletsForInstitution(showAddCrypto)}
              existingSubcategories={existingSubcategories}
              existingChains={existingChains}
            />
          )}

          {/* Stock modals */}
          {editingStockAsset && (
            <StockPositionEditor
              open
              onClose={() => setEditingStockAsset(null)}
              asset={editingStockAsset}
              brokers={brokers}
              existingSubcategories={existingSubcategories}
              existingTags={existingTags}
            />
          )}
          {showAddStock && (
            <AddStockModal
              open
              onClose={() => setShowAddStock(null)}
              brokers={brokersForInstitution(showAddStock)}
              existingSubcategories={existingSubcategories}
              existingTags={existingTags}
            />
          )}

          {/* Cash modals */}
          {(editingBankAccount !== null || showAddBankAccount !== null) && (
            <BankAccountModal
              open
              onClose={() => { setEditingBankAccount(null); setShowAddBankAccount(null); }}
              editing={editingBankAccount}
              existingBankNames={existingBankNames}
              fxRate={eurUsdRate}
            />
          )}
          {(editingExchangeDeposit !== null || showAddExchangeDeposit !== null) && (
            <ExchangeDepositModal
              open
              onClose={() => { setEditingExchangeDeposit(null); setShowAddExchangeDeposit(null); }}
              editing={editingExchangeDeposit}
              wallets={(showAddExchangeDeposit ? walletsForInstitution(showAddExchangeDeposit) : wallets).filter((w) => w.wallet_type === "custodial")}
              fxRate={eurUsdRate}
            />
          )}
          {(editingBrokerDeposit !== null || showAddBrokerDeposit !== null) && (
            <BrokerDepositModal
              open
              onClose={() => { setEditingBrokerDeposit(null); setShowAddBrokerDeposit(null); }}
              editing={editingBrokerDeposit}
              brokers={showAddBrokerDeposit ? brokersForInstitution(showAddBrokerDeposit) : brokers}
              fxRate={eurUsdRate}
            />
          )}

          {/* Transfer dialog */}
          <TransferDialog
            open={!!transferInstId}
            onClose={() => setTransferInstId(null)}
            onSuccess={() => { router.refresh(); setTransferInstId(null); }}
            mode={"sell" as TransferMode}
            initialInstitutionId={transferInstId ?? undefined}
          />

          {/* Delete confirmation */}
          {deleteTarget && (
            <Modal
              open
              onClose={() => { setDeleteTarget(null); setDeleteAdjustment(false); }}
              title="Confirm Delete"
            >
              <div className="space-y-4">
                <p className="text-sm text-zinc-300">
                  Are you sure you want to delete <span className="font-medium text-zinc-100">{deleteTarget.label}</span>?
                  This action cannot be undone.
                </p>
                <label
                  className="flex items-center gap-1 text-[10px] text-amber-400 font-medium cursor-pointer"
                  title="Not a real transaction — portfolio balance correction"
                >
                  <input
                    type="checkbox"
                    checked={deleteAdjustment}
                    onChange={(e) => setDeleteAdjustment(e.target.checked)}
                    className="accent-amber-500"
                  />
                  Portfolio adjustment
                </label>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => { setDeleteTarget(null); setDeleteAdjustment(false); }}
                    className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-lg transition-colors"
                  >
                    {deleting ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </div>
            </Modal>
          )}
        </>
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────

function AssetSection({
  icon,
  label,
  count,
  totalValue,
  primaryCurrency,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  totalValue: number;
  primaryCurrency: string;
  children: React.ReactNode;
}) {
  return (
    <div className="pt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-zinc-400">
          {icon}
          <span className="text-xs font-medium uppercase tracking-wider">
            {label} ({count})
          </span>
        </div>
        <span className="text-xs text-zinc-500 tabular-nums">
          {formatCurrency(totalValue, primaryCurrency)}
        </span>
      </div>
      <div className="pl-5 border-l border-zinc-800/50">{children}</div>
    </div>
  );
}

/** "Add" dropdown in each expanded institution card */
function AddAssetDropdown({
  institution,
  isSelfCustody,
  onAddCrypto,
  onAddStock,
  onAddBankAccount,
  onAddExchangeDeposit,
  onAddBrokerDeposit,
}: {
  institution: InstitutionWithRoles;
  isSelfCustody: boolean;
  onAddCrypto: () => void;
  onAddStock: () => void;
  onAddBankAccount: () => void;
  onAddExchangeDeposit: () => void;
  onAddBrokerDeposit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const roles = institution.roles;

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  // Build available options based on roles
  const options: { label: string; onClick: () => void }[] = [];
  const hasBothDepositRoles = !isSelfCustody && roles.includes("wallet") && roles.includes("broker");

  if (isSelfCustody || roles.includes("wallet")) {
    options.push({ label: "Add Crypto Asset", onClick: onAddCrypto });
  }
  if (!isSelfCustody && roles.includes("wallet")) {
    options.push({
      label: hasBothDepositRoles ? "Add Exchange Deposit" : "Add Fiat Deposit",
      onClick: onAddExchangeDeposit,
    });
  }
  if (roles.includes("broker")) {
    options.push({ label: "Add Stock Asset", onClick: onAddStock });
    options.push({
      label: hasBothDepositRoles ? "Add Broker Deposit" : "Add Fiat Deposit",
      onClick: onAddBrokerDeposit,
    });
  }
  if (roles.includes("bank")) {
    options.push({ label: "Add Bank Account", onClick: onAddBankAccount });
  }

  if (options.length === 0) return null;

  return (
    <div ref={containerRef} className="pt-2 border-t border-zinc-800/30 relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-1 rounded-lg hover:bg-zinc-800/50"
      >
        <Plus className="w-3 h-3" />
        Add
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {open && (
        <div className="absolute left-0 bottom-full mb-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-20 py-1 min-w-[180px]">
          {options.map((opt, i) => (
            <button
              key={i}
              onClick={() => { setOpen(false); opt.onClick(); }}
              className="w-full text-left px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────

/** Format asset quantities with consistent decimal places for column alignment.
 *  @param decimals — max decimals (2 for stocks, 4 for crypto). Default 4 = crypto mode. */
function formatQuantity(qty: number, decimals: number = 4): string {
  // Stocks (decimals=2): always exactly 2 decimal places
  if (decimals <= 2)
    return qty.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  // Crypto ≥ 1: 2–4 decimals for alignment
  if (qty >= 1)
    return qty.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: decimals,
    });
  // Sub-unit crypto: up to 8 decimals, no minimum padding
  return qty.toLocaleString("en-US", { maximumFractionDigits: 8 });
}
