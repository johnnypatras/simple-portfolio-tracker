"use client";

import { useState, useEffect } from "react";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import {
  createBankAccount,
  updateBankAccount,
} from "@/lib/actions/bank-accounts";
import type { BankAccount, BankAccountInput, CurrencyType } from "@/lib/types";
import { COUNTRIES } from "@/lib/types";
import { DEFAULT_COUNTRY } from "@/lib/constants";

interface BankAccountModalProps {
  open: boolean;
  onClose: () => void;
  editing: BankAccount | null;
  existingBankNames?: string[];
}

export function BankAccountModal({
  open,
  onClose,
  editing,
  existingBankNames = [],
}: BankAccountModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [bankName, setBankName] = useState("");
  const [currency, setCurrency] = useState<CurrencyType>("EUR");
  const [balance, setBalance] = useState("");
  const [apy, setApy] = useState("");
  const [country, setCountry] = useState(DEFAULT_COUNTRY);

  // Sync form when editing changes
  useEffect(() => {
    if (open && editing) {
      setName(editing.name);
      setBankName(editing.bank_name);
      setCurrency(editing.currency);
      setBalance(editing.balance.toString());
      setApy(editing.apy.toString());
      setCountry(editing.region || DEFAULT_COUNTRY);
      setError(null);
    } else if (open && !editing) {
      setName("");
      setBankName("");
      setCurrency("EUR");
      setBalance("");
      setApy("");
      setCountry(DEFAULT_COUNTRY);
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
      currency,
      balance: parseFloat(balance) || 0,
      apy: parseFloat(apy) || 0,
      country,
    };

    try {
      if (editing) {
        await updateBankAccount(editing.id, input);
      } else {
        await createBankAccount(input);
      }
      onClose();
      toast.success(editing ? "Bank account updated" : "Bank account added");
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
              Country
            </label>
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </select>
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
