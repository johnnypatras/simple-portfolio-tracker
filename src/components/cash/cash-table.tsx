"use client";

import { useState } from "react";
import { Plus, Pencil, Trash2, Landmark, Wallet } from "lucide-react";
import { Modal } from "@/components/ui/modal";
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
import type {
  BankAccount,
  BankAccountInput,
  ExchangeDeposit,
  ExchangeDepositInput,
  CurrencyType,
  Wallet as WalletType,
} from "@/lib/types";

interface CashTableProps {
  bankAccounts: BankAccount[];
  exchangeDeposits: ExchangeDeposit[];
  wallets: WalletType[];
  primaryCurrency: string;
  fxRates: FXRates;
}

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
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

  return (
    <div className="space-y-8">
      {/* ── Summary header ─────────────────────────────────── */}
      <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
              Total Cash
            </p>
            <p className="text-2xl font-semibold text-zinc-100 mt-1 tabular-nums">
              {formatCurrency(totalCash, primaryCurrency)}
            </p>
          </div>
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
        </div>
      </div>

      {/* ── Bank Accounts ──────────────────────────────────── */}
      <BankAccountsSection
        bankAccounts={bankAccounts}
        primaryCurrency={primaryCurrency}
        fxRates={fxRates}
        bankTotal={bankTotal}
      />

      {/* ── Exchange Deposits ──────────────────────────────── */}
      <ExchangeDepositsSection
        deposits={exchangeDeposits}
        wallets={wallets}
        primaryCurrency={primaryCurrency}
        fxRates={fxRates}
        depositTotal={depositTotal}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// Bank Accounts Section
// ═══════════════════════════════════════════════════════════

function BankAccountsSection({
  bankAccounts,
  primaryCurrency,
  fxRates,
  bankTotal,
}: {
  bankAccounts: BankAccount[];
  primaryCurrency: string;
  fxRates: FXRates;
  bankTotal: number;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<BankAccount | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [bankName, setBankName] = useState("");
  const [region, setRegion] = useState("EU");
  const [currency, setCurrency] = useState<CurrencyType>("EUR");
  const [balance, setBalance] = useState("");
  const [apy, setApy] = useState("");

  function openCreate() {
    setEditing(null);
    setName("");
    setBankName("");
    setRegion("EU");
    setCurrency("EUR");
    setBalance("");
    setApy("");
    setError(null);
    setModalOpen(true);
  }

  function openEdit(bank: BankAccount) {
    setEditing(bank);
    setName(bank.name);
    setBankName(bank.bank_name);
    setRegion(bank.region);
    setCurrency(bank.currency);
    setBalance(bank.balance.toString());
    setApy(bank.apy.toString());
    setError(null);
    setModalOpen(true);
  }

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
      setModalOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this bank account?")) return;
    try {
      await deleteBankAccount(id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Landmark className="w-4 h-4 text-zinc-500" />
          <h2 className="text-sm font-medium text-zinc-300">Bank Accounts</h2>
          <span className="text-xs text-zinc-600">
            {formatCurrency(bankTotal, primaryCurrency)}
          </span>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          <Plus className="w-3 h-3" />
          Add Account
        </button>
      </div>

      {bankAccounts.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-8 text-center">
          <Landmark className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
          <p className="text-sm text-zinc-500">No bank accounts yet</p>
          <p className="text-xs text-zinc-600 mt-1">
            Add a bank or savings account to track your cash
          </p>
        </div>
      ) : (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800/50">
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">
                  Account
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">
                  Bank
                </th>
                <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">
                  Balance
                </th>
                <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider hidden sm:table-cell">
                  Value
                </th>
                <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider hidden md:table-cell">
                  APY
                </th>
                <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider hidden lg:table-cell">
                  Region
                </th>
                <th className="w-20 px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {bankAccounts.map((b) => {
                const valueInBase = convertToBase(
                  b.balance,
                  b.currency,
                  primaryCurrency,
                  fxRates
                );
                const showConverted = b.currency !== primaryCurrency;

                return (
                  <tr
                    key={b.id}
                    className="border-b border-zinc-800/30 last:border-0 group hover:bg-zinc-800/20 transition-colors"
                  >
                    <td className="px-4 py-3 text-sm text-zinc-200">
                      {b.name}
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-400">
                      {b.bank_name}
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-200 text-right tabular-nums">
                      {formatCurrency(b.balance, b.currency)}
                    </td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums hidden sm:table-cell">
                      {showConverted ? (
                        <span className="text-zinc-400">
                          {formatCurrency(valueInBase, primaryCurrency)}
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-right hidden md:table-cell">
                      {b.apy > 0 ? (
                        <span className="text-emerald-400">
                          {b.apy}%
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-500 text-right hidden lg:table-cell">
                      {b.region}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => openEdit(b)}
                          className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(b.id)}
                          className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Bank Account Modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
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
                className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                required
              />
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
              onClick={() => setModalOpen(false)}
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
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// Exchange Deposits Section
// ═══════════════════════════════════════════════════════════

function ExchangeDepositsSection({
  deposits,
  wallets,
  primaryCurrency,
  fxRates,
  depositTotal,
}: {
  deposits: ExchangeDeposit[];
  wallets: WalletType[];
  primaryCurrency: string;
  fxRates: FXRates;
  depositTotal: number;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ExchangeDeposit | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [walletId, setWalletId] = useState("");
  const [currency, setCurrency] = useState<CurrencyType>("USD");
  const [amount, setAmount] = useState("");
  const [apy, setApy] = useState("");

  function openCreate() {
    setEditing(null);
    setWalletId(wallets[0]?.id ?? "");
    setCurrency("USD");
    setAmount("");
    setApy("");
    setError(null);
    setModalOpen(true);
  }

  function openEdit(deposit: ExchangeDeposit) {
    setEditing(deposit);
    setWalletId(deposit.wallet_id);
    setCurrency(deposit.currency);
    setAmount(deposit.amount.toString());
    setApy(deposit.apy.toString());
    setError(null);
    setModalOpen(true);
  }

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
      setModalOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this exchange deposit?")) return;
    try {
      await deleteExchangeDeposit(id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Wallet className="w-4 h-4 text-zinc-500" />
          <h2 className="text-sm font-medium text-zinc-300">
            Exchange Deposits
          </h2>
          <span className="text-xs text-zinc-600">
            {formatCurrency(depositTotal, primaryCurrency)}
          </span>
        </div>
        <button
          onClick={openCreate}
          disabled={wallets.length === 0}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-colors"
          title={wallets.length === 0 ? "Add a wallet first in Settings" : ""}
        >
          <Plus className="w-3 h-3" />
          Add Deposit
        </button>
      </div>

      {deposits.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-8 text-center">
          <Wallet className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
          <p className="text-sm text-zinc-500">No exchange deposits yet</p>
          <p className="text-xs text-zinc-600 mt-1">
            {wallets.length === 0
              ? "Add a wallet in Settings first, then track fiat deposits here"
              : "Track fiat sitting on your crypto exchanges"}
          </p>
        </div>
      ) : (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800/50">
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">
                  Wallet
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">
                  Currency
                </th>
                <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">
                  Amount
                </th>
                <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider hidden sm:table-cell">
                  Value
                </th>
                <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider hidden md:table-cell">
                  APY
                </th>
                <th className="w-20 px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {deposits.map((d) => {
                const valueInBase = convertToBase(
                  d.amount,
                  d.currency,
                  primaryCurrency,
                  fxRates
                );
                const showConverted = d.currency !== primaryCurrency;

                return (
                  <tr
                    key={d.id}
                    className="border-b border-zinc-800/30 last:border-0 group hover:bg-zinc-800/20 transition-colors"
                  >
                    <td className="px-4 py-3 text-sm text-zinc-200">
                      {d.wallet_name}
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-400">
                      {d.currency}
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-200 text-right tabular-nums">
                      {formatCurrency(d.amount, d.currency)}
                    </td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums hidden sm:table-cell">
                      {showConverted ? (
                        <span className="text-zinc-400">
                          {formatCurrency(valueInBase, primaryCurrency)}
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-right hidden md:table-cell">
                      {d.apy > 0 ? (
                        <span className="text-emerald-400">
                          {d.apy}%
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => openEdit(d)}
                          className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(d.id)}
                          className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Exchange Deposit Modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
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
              onClick={() => setModalOpen(false)}
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
    </div>
  );
}
