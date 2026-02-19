"use client";

import { useState, useMemo, useCallback, Fragment } from "react";
import { Plus, Landmark, Wallet, Pencil, Trash2, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { ColumnSettingsPopover } from "@/components/ui/column-settings-popover";
import { useColumnConfig } from "@/lib/hooks/use-column-config";
import { convertToBase } from "@/lib/prices/fx";
import type { FXRates } from "@/lib/prices/fx";
import {
  createBankAccount,
  updateBankAccount,
  deleteBankAccount,
} from "@/lib/actions/bank-accounts";
import {
  createExchangeDeposit,
  updateExchangeDeposit,
  deleteExchangeDeposit,
} from "@/lib/actions/exchange-deposits";
import {
  getCashColumns,
  buildBankGroupRows,
  buildExchangeGroupRows,
  formatCurrency,
  type CashRow,
} from "@/components/cash/cash-columns";
import type { ColumnDef, RenderContext } from "@/lib/column-config";
import type {
  BankAccount,
  BankAccountInput,
  ExchangeDeposit,
  ExchangeDepositInput,
  CurrencyType,
  Wallet as WalletType,
} from "@/lib/types";

// ── Breakpoint → Tailwind class mapping ──────────────────────

const HIDDEN_BELOW: Record<string, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};

// ═══════════════════════════════════════════════════════════════
// Main CashTable
// ═══════════════════════════════════════════════════════════════

interface CashTableProps {
  bankAccounts: BankAccount[];
  exchangeDeposits: ExchangeDeposit[];
  wallets: WalletType[];
  primaryCurrency: string;
  fxRates: FXRates;
}

export function CashTable({
  bankAccounts,
  exchangeDeposits,
  wallets,
  primaryCurrency,
  fxRates,
}: CashTableProps) {
  // ── Compute totals ──────────────────────────────────────
  const bankTotal = bankAccounts.reduce(
    (sum, b) =>
      sum + convertToBase(b.balance, b.currency, primaryCurrency, fxRates),
    0
  );
  const depositTotal = exchangeDeposits.reduce(
    (sum, d) =>
      sum + convertToBase(d.amount, d.currency, primaryCurrency, fxRates),
    0
  );
  const totalCash = bankTotal + depositTotal;

  // ── Bank handlers ─────────────────────────────────────────
  const [bankModalOpen, setBankModalOpen] = useState(false);
  const [editingBank, setEditingBank] = useState<BankAccount | null>(null);

  const openEditBank = useCallback((bank: BankAccount) => {
    setEditingBank(bank);
    setBankModalOpen(true);
  }, [setBankModalOpen]);

  const handleDeleteBank = useCallback(async (id: string) => {
    if (!confirm("Delete this bank account?")) return;
    try {
      await deleteBankAccount(id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete");
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
    if (!confirm("Delete this exchange deposit?")) return;
    try {
      await deleteExchangeDeposit(id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete");
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
        isExpanded,
        toggleExpand,
      }),
    [openEditBank, handleDeleteBank, openEditExchange, handleDeleteExchange, isExpanded, toggleExpand]
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

  const hasAnyRows = bankAccounts.length > 0 || exchangeDeposits.length > 0;

  const allGroupIds = useMemo(() => {
    const ids: string[] = [];
    for (const r of bankRows) if (r.type === "bank-group") ids.push(r.id);
    for (const r of exchRows) if (r.type === "exchange-group") ids.push(r.id);
    return ids;
  }, [bankRows, exchRows]);

  const allExpanded = allGroupIds.length > 0 && allGroupIds.every((id) => expandedBanks.has(id));

  const toggleExpandAll = useCallback(() => {
    setExpandedBanks((prev) => {
      if (allGroupIds.every((id) => prev.has(id))) return new Set();
      return new Set(allGroupIds);
    });
  }, [allGroupIds]);

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

  return (
    <div>
      {/* ── Summary header ─────────────────────────────────── */}
      <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
              Total Banks &amp; Deposits
            </p>
            <p className="text-2xl font-semibold text-zinc-100 mt-1 tabular-nums">
              {formatCurrency(totalCash, primaryCurrency)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right text-xs text-zinc-500 space-y-0.5">
              <p>
                {bankAccounts.length} bank account
                {bankAccounts.length !== 1 ? "s" : ""}
              </p>
              <p>
                {exchangeDeposits.length} exchange deposit
                {exchangeDeposits.length !== 1 ? "s" : ""}
              </p>
            </div>
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
          </div>
        </div>
      </div>

      {/* ── Action bar ───────────────────────────────────── */}
      <div className="flex items-center justify-end mt-2 mb-3">
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
                            {row.data.weightedApy > 0 && <p className="text-xs text-emerald-400">~{row.data.weightedApy.toFixed(1)}% APY</p>}
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
                                    <button onClick={() => handleDeleteBank(acct.id)} className="p-1 text-zinc-500 hover:text-red-400"><Trash2 className="w-3 h-3" /></button>
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

            {/* Exchange / Broker Deposits */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Wallet className="w-3.5 h-3.5 text-zinc-500" />
                <span className="text-xs font-medium text-zinc-400">Exchange / Broker Deposits</span>
                <span className="text-xs text-zinc-600">{formatCurrency(depositTotal, primaryCurrency)}</span>
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
                            {row.data.weightedApy > 0 && <p className="text-xs text-emerald-400">~{row.data.weightedApy.toFixed(1)}% APY</p>}
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
                                    <button onClick={() => handleDeleteExchange(dep.id)} className="p-1 text-zinc-500 hover:text-red-400"><Trash2 className="w-3 h-3" /></button>
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
                  <td colSpan={orderedColumns.length} className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <Landmark className="w-3.5 h-3.5 text-zinc-500" />
                      <span className="text-xs font-medium text-zinc-400">Bank Accounts</span>
                      <span className="text-xs text-zinc-600">{formatCurrency(bankTotal, primaryCurrency)}</span>
                    </div>
                  </td>
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
                  <td colSpan={orderedColumns.length} className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <Wallet className="w-3.5 h-3.5 text-zinc-500" />
                      <span className="text-xs font-medium text-zinc-400">Exchange / Broker Deposits</span>
                      <span className="text-xs text-zinc-600">{formatCurrency(depositTotal, primaryCurrency)}</span>
                    </div>
                  </td>
                </tr>

                {exchRows.length === 0 ? (
                  <tr>
                    <td colSpan={orderedColumns.length} className="px-4 py-4 text-center">
                      <p className="text-xs text-zinc-600">{wallets.length === 0 ? "Add a wallet in Settings first, then track fiat deposits here" : "No exchange deposits yet — click Add to create one"}</p>
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
            <Wallet className="w-5 h-5 text-zinc-400 shrink-0" />
            <div>
              <p className="text-sm font-medium text-zinc-200">Exchange / Broker Deposit</p>
              <p className="text-xs text-zinc-500">
                {wallets.length === 0
                  ? "Add a wallet in Settings first"
                  : "Fiat deposits on crypto exchanges or brokers"}
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
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Bank Account Modal
// ═══════════════════════════════════════════════════════════════

function BankAccountModal({
  open,
  onClose,
  editing,
  existingBankNames = [],
}: {
  open: boolean;
  onClose: () => void;
  editing: BankAccount | null;
  existingBankNames?: string[];
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [bankName, setBankName] = useState("");
  const [region, setRegion] = useState("EU");
  const [currency, setCurrency] = useState<CurrencyType>("EUR");
  const [balance, setBalance] = useState("");
  const [apy, setApy] = useState("");

  // Sync form when editing changes
  useMemo(() => {
    if (open && editing) {
      setName(editing.name);
      setBankName(editing.bank_name);
      setRegion(editing.region);
      setCurrency(editing.currency);
      setBalance(editing.balance.toString());
      setApy(editing.apy.toString());
      setError(null);
    } else if (open && !editing) {
      setName("");
      setBankName("");
      setRegion("EU");
      setCurrency("EUR");
      setBalance("");
      setApy("");
      setError(null);
    }
  }, [open, editing]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const input: BankAccountInput = {
      name,
      bank_name: bankName,
      region,
      currency,
      balance: parseFloat(balance) || 0,
      apy: parseFloat(apy) || 0,
    };

    try {
      if (editing) {
        await updateBankAccount(editing.id, input);
      } else {
        await createBankAccount(input);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit Bank Account" : "Add Bank Account"}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Account Label
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Savings"
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Bank Name
            </label>
            <input
              type="text"
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              placeholder="e.g. ING, N26"
              list="bank-name-suggestions"
              autoComplete="off"
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              required
            />
            {existingBankNames.length > 0 && (
              <datalist id="bank-name-suggestions">
                {existingBankNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Currency
            </label>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as CurrencyType)}
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            >
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Region
            </label>
            <input
              type="text"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="EU"
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Balance
            </label>
            <input
              type="number"
              step="0.01"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              placeholder="0.00"
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              APY %
            </label>
            <input
              type="number"
              step="0.01"
              value={apy}
              onChange={(e) => setApy(e.target.value)}
              placeholder="0.00"
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-lg transition-colors"
          >
            {loading
              ? "Saving..."
              : editing
                ? "Save Changes"
                : "Add Account"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════
// Exchange Deposit Modal
// ═══════════════════════════════════════════════════════════════

function ExchangeDepositModal({
  open,
  onClose,
  editing,
  wallets,
}: {
  open: boolean;
  onClose: () => void;
  editing: ExchangeDeposit | null;
  wallets: WalletType[];
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [walletId, setWalletId] = useState("");
  const [currency, setCurrency] = useState<CurrencyType>("USD");
  const [amount, setAmount] = useState("");
  const [apy, setApy] = useState("");

  // Sync form when editing changes
  useMemo(() => {
    if (open && editing) {
      setWalletId(editing.wallet_id);
      setCurrency(editing.currency);
      setAmount(editing.amount.toString());
      setApy(editing.apy.toString());
      setError(null);
    } else if (open && !editing) {
      setWalletId(wallets[0]?.id ?? "");
      setCurrency("USD");
      setAmount("");
      setApy("");
      setError(null);
    }
  }, [open, editing, wallets]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const input: ExchangeDepositInput = {
      wallet_id: walletId,
      currency,
      amount: parseFloat(amount) || 0,
      apy: parseFloat(apy) || 0,
    };

    try {
      if (editing) {
        await updateExchangeDeposit(editing.id, input);
      } else {
        await createExchangeDeposit(input);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit Exchange Deposit" : "Add Exchange Deposit"}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-zinc-400 mb-1.5">
            Wallet / Exchange
          </label>
          <select
            value={walletId}
            onChange={(e) => setWalletId(e.target.value)}
            className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            required
          >
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Currency
            </label>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as CurrencyType)}
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            >
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Amount
            </label>
            <input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              required
            />
          </div>
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1.5">
            APY % <span className="text-zinc-600">(optional)</span>
          </label>
          <input
            type="number"
            step="0.01"
            value={apy}
            onChange={(e) => setApy(e.target.value)}
            placeholder="0.00"
            className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-lg transition-colors"
          >
            {loading
              ? "Saving..."
              : editing
                ? "Save Changes"
                : "Add Deposit"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

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
              <span className="text-xs text-zinc-500">{account.region}</span>
            </td>
          );
        }
        if (col.key === "actions") {
          return (
            <td key={col.key} className={`px-4 py-2 text-right ${hidden}`}>
              <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={onEdit}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={onDelete}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
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
  deposit: ExchangeDeposit;
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
              <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={onEdit}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={onDelete}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </td>
          );
        }
        return <td key={col.key} className={hidden} />;
      })}
    </tr>
  );
}
