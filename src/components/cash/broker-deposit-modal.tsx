"use client";

import { useState, useEffect } from "react";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import {
  createBrokerDeposit,
  updateBrokerDeposit,
} from "@/lib/actions/broker-deposits";
import type { Broker, BrokerDeposit, BrokerDepositInput, CurrencyType } from "@/lib/types";

interface BrokerDepositModalProps {
  open: boolean;
  onClose: () => void;
  editing: BrokerDeposit | null;
  brokers: Broker[];
}

export function BrokerDepositModal({
  open,
  onClose,
  editing,
  brokers,
}: BrokerDepositModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAdjustment, setIsAdjustment] = useState(false);

  const [brokerId, setBrokerId] = useState("");
  const [currency, setCurrency] = useState<CurrencyType>("EUR");
  const [amount, setAmount] = useState("");
  const [apy, setApy] = useState("");

  // Sync form when editing changes
  useEffect(() => {
    if (open && editing) {
      setBrokerId(editing.broker_id);
      setCurrency(editing.currency);
      setAmount(editing.amount.toString());
      setApy(editing.apy.toString());
      setError(null);
      setIsAdjustment(false);
    } else if (open && !editing) {
      setBrokerId(brokers[0]?.id ?? "");
      setCurrency("EUR");
      setAmount("");
      setApy("");
      setError(null);
      setIsAdjustment(false);
    }
  }, [open, editing, brokers]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const input: BrokerDepositInput = {
      broker_id: brokerId,
      currency,
      amount: parseFloat(amount) || 0,
      apy: parseFloat(apy) || 0,
    };

    try {
      if (editing) {
        await updateBrokerDeposit(editing.id, input, { isAdjustment });
      } else {
        await createBrokerDeposit(input, { isAdjustment });
      }
      onClose();
      const adjLabel = isAdjustment ? " (adjustment)" : "";
      toast.success((editing ? "Fiat deposit updated" : "Fiat deposit added") + adjLabel);
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
      title={editing ? "Edit Fiat Deposit" : "Add Fiat Deposit"}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {editing?.last_was_adjustment && (
          <div className="flex items-center gap-1.5 -mt-2 mb-1">
            <span className="text-[10px] text-amber-400 font-medium" title="Not a real transaction — portfolio balance correction">Adj.</span>
            <span className="text-[10px] text-zinc-600">Last saved as portfolio adjustment</span>
          </div>
        )}
        <div>
          <label className="block text-xs text-zinc-500 mb-1">
            Broker
          </label>
          <select
            value={brokerId}
            onChange={(e) => setBrokerId(e.target.value)}
            className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            required
          >
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">
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
            <label className="block text-xs text-zinc-500 mb-1">
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
          <label className="block text-xs text-zinc-500 mb-1">
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

        <div className="flex items-center justify-between gap-2 pt-2">
          <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none" title="Not a real transaction — portfolio balance correction">
            <input
              type="checkbox"
              checked={isAdjustment}
              onChange={(e) => setIsAdjustment(e.target.checked)}
              className="accent-amber-500"
            />
            Portfolio adjustment
          </label>
          <div className="flex gap-2">
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
        </div>
      </form>
    </Modal>
  );
}
