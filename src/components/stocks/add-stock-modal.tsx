"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { createStockAsset } from "@/lib/actions/stocks";
import type { AssetCategory, CurrencyType } from "@/lib/types";

interface AddStockModalProps {
  open: boolean;
  onClose: () => void;
}

const CATEGORIES: { value: AssetCategory; label: string }[] = [
  { value: "stock", label: "Individual Stock" },
  { value: "etf_sp500", label: "ETF — S&P 500" },
  { value: "etf_world", label: "ETF — World" },
  { value: "bond", label: "Bond / Fixed Income" },
  { value: "other", label: "Other" },
];

export function AddStockModal({ open, onClose }: AddStockModalProps) {
  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("");
  const [isin, setIsin] = useState("");
  const [category, setCategory] = useState<AssetCategory>("stock");
  const [currency, setCurrency] = useState<CurrencyType>("USD");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setTicker("");
      setName("");
      setIsin("");
      setCategory("stock");
      setCurrency("USD");
      setError(null);
      setLoading(false);
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ticker.trim() || !name.trim()) return;

    setError(null);
    setLoading(true);

    try {
      await createStockAsset({
        ticker: ticker.trim(),
        name: name.trim(),
        isin: isin.trim() || null,
        category,
        currency,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Stock / ETF">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Ticker + Name row */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">
              Ticker *
            </label>
            <input
              type="text"
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="AAPL"
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 uppercase"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">
              Name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Apple Inc."
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>
        </div>

        {/* ISIN */}
        <div>
          <label className="block text-xs text-zinc-500 mb-1">
            ISIN <span className="text-zinc-600">(optional)</span>
          </label>
          <input
            type="text"
            value={isin}
            onChange={(e) => setIsin(e.target.value)}
            placeholder="US0378331005"
            className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 uppercase"
          />
        </div>

        {/* Category + Currency row */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">
              Category
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as AssetCategory)}
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">
              Currency
            </label>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as CurrencyType)}
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            >
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
            </select>
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading || !ticker.trim() || !name.trim()}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          Add to Portfolio
        </button>
      </form>
    </Modal>
  );
}
