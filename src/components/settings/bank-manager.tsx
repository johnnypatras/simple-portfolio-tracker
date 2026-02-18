"use client";

import { useState } from "react";
import { Plus, Pencil, Trash2, Landmark } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import {
  createBankAccount,
  updateBankAccount,
  deleteBankAccount,
} from "@/lib/actions/bank-accounts";
import type { BankAccount, BankAccountInput, CurrencyType } from "@/lib/types";

export function BankManager({ banks }: { banks: BankAccount[] }) {
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

  function formatCurrency(amount: number, cur: CurrencyType) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
      minimumFractionDigits: 2,
    }).format(amount);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-zinc-400">
          Bank and savings accounts for cash tracking
        </p>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Account
        </button>
      </div>

      {banks.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-8 text-center">
          <Landmark className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
          <p className="text-sm text-zinc-500">No bank accounts yet</p>
          <p className="text-xs text-zinc-600 mt-1">
            Add a bank or savings account to track your cash holdings
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {banks.map((b) => (
            <div
              key={b.id}
              className="flex items-center justify-between px-4 py-3 bg-zinc-900/50 border border-zinc-800/50 rounded-lg group"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-zinc-200 truncate">
                    {b.name}
                  </p>
                  <span className="text-xs text-zinc-600">{b.bank_name}</span>
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-xs text-zinc-400">
                    {formatCurrency(b.balance, b.currency)}
                  </span>
                  {b.apy > 0 && (
                    <span className="text-xs text-emerald-400">
                      {b.apy}% APY
                    </span>
                  )}
                  <span className="text-xs text-zinc-600">{b.region}</span>
                </div>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
            </div>
          ))}
        </div>
      )}

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
