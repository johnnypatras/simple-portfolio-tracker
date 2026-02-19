"use client";

import { useState } from "react";
import { Plus, BookOpen, Pencil, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import {
  createTradeEntry,
  updateTradeEntry,
  deleteTradeEntry,
} from "@/lib/actions/trades";
import type {
  TradeEntry,
  TradeEntryInput,
  TradeAssetType,
  TradeAction,
} from "@/lib/types";

// ── Helpers ────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // Fallback for unsupported currency codes
    return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  }
}

function formatQuantity(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 8,
  });
}

const ASSET_TYPE_STYLES: Record<TradeAssetType, string> = {
  crypto: "bg-orange-500/10 text-orange-400",
  stock: "bg-blue-500/10 text-blue-400",
  cash: "bg-emerald-500/10 text-emerald-400",
  other: "bg-zinc-500/10 text-zinc-400",
};

const ACTION_STYLES: Record<TradeAction, string> = {
  buy: "bg-emerald-500/10 text-emerald-400",
  sell: "bg-red-500/10 text-red-400",
};

// ── Helpers for datetime-local input ──────────────────────

function toLocalDatetime(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60_000);
  return local.toISOString().slice(0, 16);
}

// ── Props ───────────────────────────────────────────────────

interface AssetOptions {
  crypto: { ticker: string; name: string }[];
  stock: { ticker: string; name: string; currency: string }[];
  cash: string[];
}

// ── Main Component ─────────────────────────────────────────

export function TradeTable({
  trades,
  assetOptions,
}: {
  trades: TradeEntry[];
  assetOptions: AssetOptions;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<TradeEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [tradeDate, setTradeDate] = useState(toLocalDatetime());
  const [assetType, setAssetType] = useState<TradeAssetType>("crypto");
  const [assetName, setAssetName] = useState("");
  const [action, setAction] = useState<TradeAction>("buy");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [notes, setNotes] = useState("");

  function openCreate() {
    setEditing(null);
    setTradeDate(toLocalDatetime());
    setAssetType("crypto");
    setAssetName("");
    setAction("buy");
    setQuantity("");
    setPrice("");
    setCurrency("USD");
    setNotes("");
    setError(null);
    setModalOpen(true);
  }

  function openEdit(t: TradeEntry) {
    setEditing(t);
    setTradeDate(toLocalDatetime(t.trade_date));
    setAssetType(t.asset_type);
    setAssetName(t.asset_name);
    setAction(t.action);
    setQuantity(t.quantity.toString());
    setPrice(t.price.toString());
    setCurrency(t.currency);
    setNotes(t.notes ?? "");
    setError(null);
    setModalOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const input: TradeEntryInput = {
      trade_date: new Date(tradeDate).toISOString(),
      asset_type: assetType,
      asset_name: assetName,
      action,
      quantity: parseFloat(quantity) || 0,
      price: parseFloat(price) || 0,
      currency: currency || "USD",
      notes: notes || undefined,
    };

    try {
      if (editing) {
        await updateTradeEntry(editing.id, input);
      } else {
        await createTradeEntry(input);
      }
      setModalOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this trade entry?")) return;
    try {
      await deleteTradeEntry(id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  // ── Modal JSX (inlined to avoid re-mount on every render) ──

  const modalJSX = (
    <Modal
      open={modalOpen}
      onClose={() => setModalOpen(false)}
      title={editing ? "Edit Trade" : "Log Trade"}
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Row 1: Date + Buy/Sell */}
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">
              Trade Date
            </label>
            <input
              type="datetime-local"
              value={tradeDate}
              onChange={(e) => setTradeDate(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">
              Side
            </label>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => setAction("buy")}
                className={`px-2 py-2 rounded-lg text-sm font-medium transition-colors ${
                  action === "buy"
                    ? "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30"
                    : "bg-zinc-800/50 text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Buy
              </button>
              <button
                type="button"
                onClick={() => setAction("sell")}
                className={`px-2 py-2 rounded-lg text-sm font-medium transition-colors ${
                  action === "sell"
                    ? "bg-red-500/20 text-red-400 ring-1 ring-red-500/30"
                    : "bg-zinc-800/50 text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Sell
              </button>
            </div>
          </div>
        </div>

        {/* Row 2: Asset type + name */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">
              Asset Type
            </label>
            <select
              value={assetType}
              onChange={(e) => {
                const newType = e.target.value as TradeAssetType;
                setAssetType(newType);
                setAssetName("");
              }}
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            >
              <option value="crypto">Crypto</option>
              <option value="stock">Stock</option>
              <option value="cash">Cash</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">
              Asset Name
            </label>
            {assetType === "crypto" && assetOptions.crypto.length > 0 ? (
              <select
                value={assetName}
                onChange={(e) => setAssetName(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                required
              >
                <option value="">Select asset…</option>
                {assetOptions.crypto.map((a) => (
                  <option key={a.ticker} value={a.ticker}>
                    {a.ticker} — {a.name}
                  </option>
                ))}
              </select>
            ) : assetType === "stock" && assetOptions.stock.length > 0 ? (
              <select
                value={assetName}
                onChange={(e) => {
                  setAssetName(e.target.value);
                  const match = assetOptions.stock.find(
                    (s) => s.ticker === e.target.value
                  );
                  if (match) setCurrency(match.currency);
                }}
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                required
              >
                <option value="">Select asset…</option>
                {assetOptions.stock.map((a) => (
                  <option key={a.ticker} value={a.ticker}>
                    {a.ticker} — {a.name}
                  </option>
                ))}
              </select>
            ) : assetType === "cash" && assetOptions.cash.length > 0 ? (
              <select
                value={assetName}
                onChange={(e) => {
                  setAssetName(e.target.value);
                  if (e.target.value) setCurrency(e.target.value);
                }}
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                required
              >
                <option value="">Select currency…</option>
                {assetOptions.cash.map((cur) => (
                  <option key={cur} value={cur}>
                    {cur}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={assetName}
                onChange={(e) => setAssetName(e.target.value)}
                placeholder="e.g. EUR, USD"
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                required
              />
            )}
          </div>
        </div>

        {/* Row 3: Quantity + Price + Currency */}
        <div className="grid grid-cols-[1fr_1fr_70px] gap-3">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">
              Quantity
            </label>
            <input
              type="number"
              step="any"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="Qty"
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">
              Price
            </label>
            <input
              type="number"
              step="any"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="Price"
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">
              Ccy
            </label>
            <input
              type="text"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              placeholder="USD"
              maxLength={5}
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>
        </div>

        {/* Notes — single line on mobile */}
        <div>
          <label className="block text-sm text-zinc-400 mb-1">
            Notes{" "}
            <span className="text-zinc-600 font-normal">(optional)</span>
          </label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Why did you make this trade?"
            className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
        </div>

        {/* Live total preview + buttons */}
        <div className="flex items-center justify-between pt-1">
          <div className="text-sm text-zinc-500">
            {parseFloat(quantity) > 0 && parseFloat(price) > 0 && (
              <>
                Total:{" "}
                <span className="font-medium text-zinc-200">
                  {formatMoney(
                    (parseFloat(quantity) || 0) * (parseFloat(price) || 0),
                    currency || "USD"
                  )}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-lg transition-colors"
            >
              {loading ? "Saving..." : editing ? "Save Changes" : "Log Trade"}
            </button>
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );

  // ── Empty State ──────────────────────────────────────────

  if (trades.length === 0 && !modalOpen) {
    return (
      <div>
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-12 text-center">
          <BookOpen className="w-10 h-10 text-zinc-700 mx-auto mb-3" />
          <p className="text-sm text-zinc-400 mb-1">No trades logged yet</p>
          <p className="text-xs text-zinc-600 mb-4">
            Record your significant buys and sells for future reference
          </p>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Trade
          </button>
        </div>
        {modalJSX}
      </div>
    );
  }

  // ── List View ────────────────────────────────────────────

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-zinc-400">
          {trades.length} trade{trades.length !== 1 ? "s" : ""} logged
        </p>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Trade
        </button>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-zinc-800/50">
              <th className="text-left text-xs font-medium text-zinc-500 px-4 py-3">
                Date
              </th>
              <th className="text-left text-xs font-medium text-zinc-500 px-4 py-3">
                Asset
              </th>
              <th className="text-left text-xs font-medium text-zinc-500 px-4 py-3">
                Action
              </th>
              <th className="text-right text-xs font-medium text-zinc-500 px-4 py-3">
                Quantity
              </th>
              <th className="text-right text-xs font-medium text-zinc-500 px-4 py-3">
                Price
              </th>
              <th className="text-right text-xs font-medium text-zinc-500 px-4 py-3">
                Total
              </th>
              <th className="text-left text-xs font-medium text-zinc-500 px-4 py-3">
                Notes
              </th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr
                key={t.id}
                className="border-b border-zinc-800/30 last:border-0 group hover:bg-zinc-800/20 transition-colors"
              >
                <td className="px-4 py-3 text-sm text-zinc-400 whitespace-nowrap">
                  {formatDate(t.trade_date)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">
                      {t.asset_name}
                    </span>
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full uppercase ${ASSET_TYPE_STYLES[t.asset_type]}`}
                    >
                      {t.asset_type}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full capitalize ${ACTION_STYLES[t.action]}`}
                  >
                    {t.action}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-zinc-300 text-right tabular-nums">
                  {formatQuantity(t.quantity)}
                </td>
                <td className="px-4 py-3 text-sm text-zinc-300 text-right tabular-nums">
                  {formatMoney(t.price, t.currency)}
                </td>
                <td className="px-4 py-3 text-sm font-medium text-zinc-200 text-right tabular-nums">
                  {formatMoney(t.total_value, t.currency)}
                </td>
                <td className="px-4 py-3 text-xs text-zinc-500 max-w-[160px] truncate">
                  {t.notes || "—"}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => openEdit(t)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(t.id)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {trades.map((t) => (
          <div
            key={t.id}
            className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl px-4 py-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                {/* Row 1: Asset + badges */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-zinc-200">
                    {t.asset_name}
                  </span>
                  <span
                    className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full uppercase ${ASSET_TYPE_STYLES[t.asset_type]}`}
                  >
                    {t.asset_type}
                  </span>
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full capitalize ${ACTION_STYLES[t.action]}`}
                  >
                    {t.action}
                  </span>
                </div>
                {/* Row 2: Qty × Price = Total */}
                <p className="text-sm text-zinc-300 mt-1 tabular-nums">
                  {formatQuantity(t.quantity)} × {formatMoney(t.price, t.currency)}
                  <span className="text-zinc-500 mx-1.5">=</span>
                  <span className="font-medium text-zinc-200">
                    {formatMoney(t.total_value, t.currency)}
                  </span>
                </p>
                {/* Row 3: Date + notes */}
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-zinc-500">
                    {formatDate(t.trade_date)}
                  </span>
                  {t.notes && (
                    <span className="text-xs text-zinc-600 truncate max-w-[200px]">
                      · {t.notes}
                    </span>
                  )}
                </div>
              </div>
              {/* Actions */}
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  onClick={() => openEdit(t)}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleDelete(t.id)}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {modalJSX}
    </div>
  );
}
