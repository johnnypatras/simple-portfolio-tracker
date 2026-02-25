"use client";

import { useState, useEffect } from "react";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import {
  createExchangeDeposit,
  updateExchangeDeposit,
} from "@/lib/actions/exchange-deposits";
import type { ExchangeDeposit, ExchangeDepositInput, CurrencyType, Wallet } from "@/lib/types";

interface ExchangeDepositModalProps {
  open: boolean;
  onClose: () => void;
  editing: ExchangeDeposit | null;
  wallets: Wallet[];
}

export function ExchangeDepositModal({
  open,
  onClose,
  editing,
  wallets,
}: ExchangeDepositModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only custodial wallets can hold exchange deposits (fiat on exchanges)
  const custodialWallets = wallets.filter((w) => w.wallet_type === "custodial");

  // Form state
  const [walletId, setWalletId] = useState("");
  const [currency, setCurrency] = useState<CurrencyType>("USD");
  const [amount, setAmount] = useState("");
  const [apy, setApy] = useState("");

  // Sync form when editing changes
  useEffect(() => {
    if (open && editing) {
      setWalletId(editing.wallet_id);
      setCurrency(editing.currency);
      setAmount(editing.amount.toString());
      setApy(editing.apy.toString());
      setError(null);
    } else if (open && !editing) {
      setWalletId(custodialWallets[0]?.id ?? "");
      setCurrency("USD");
      setAmount("");
      setApy("");
      setError(null);
    }
  }, [open, editing, custodialWallets]);

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
      toast.success(editing ? "Exchange deposit updated" : "Exchange deposit added");
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
            disabled={custodialWallets.length === 0}
          >
            {custodialWallets.length === 0 && (
              <option value="">No exchange wallets available</option>
            )}
            {custodialWallets.map((w) => (
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
