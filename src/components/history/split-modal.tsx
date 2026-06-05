"use client";

import { useState, useEffect, useId, useCallback } from "react";
import { X, Plus } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { extractQuantity } from "@/lib/split-helpers";
import { fmtCurrency } from "@/lib/format";
import type { ActivityLog } from "@/lib/types";

// ─── Types ───────────────────────────────────────────────

/**
 * Form state for one split leg. Distinct from the server-action `SplitLeg`
 * in `@/lib/types`: here `quantity` and `cost` are raw controlled-input strings;
 * the server-side `SplitLeg.quantity` is a validated number.
 */
interface SplitLegDraft {
  effective_date: string;
  quantity: string; // string for controlled input
  cost: string;     // string for controlled input; blank → no cost emitted
}

type CostCurrency = "EUR" | "USD";

interface SplitModalProps {
  entry: ActivityLog | null;
  onClose: () => void;
  onSplit: (
    parentId: string,
    legs: {
      effective_date: string;
      quantity: number;
      // Optional per-leg cost (DCA). The UI field that populates this is Task 4.2;
      // the type lives here now so the server-action contract is type-complete.
      cost?: { amount: number; currency: "EUR" | "USD" };
    }[],
  ) => Promise<{ success: boolean; message: string }>;
}

// ─── Helpers ─────────────────────────────────────────────

/**
 * Returns true when the entry is a yield entry (earned income; cost = 0
 * by definition). Model B: a yield row participates in the S&P benchmark at its
 * market value on the receipt date.
 */
function isYieldEntry(entry: ActivityLog): boolean {
  return entry.is_yield;
}

/**
 * Returns true when the parent should hide the cost fields. Two cases:
 * 1. Yield entries — cost is 0 by definition; server rejects a per-leg cost.
 * 2. Adjustment entries — carry delta_* not cashflow_amount_*; server rejects.
 */
function hideCostFields(entry: ActivityLog): boolean {
  return isYieldEntry(entry) || entry.is_adjustment;
}

const CRYPTO_ENTITY_TYPES = new Set([
  "crypto_asset",
  "crypto_position",
]);

function isCryptoEntry(entry: ActivityLog): boolean {
  return CRYPTO_ENTITY_TYPES.has(entry.entity_type);
}

function getUnit(entry: ActivityLog): string {
  if (CRYPTO_ENTITY_TYPES.has(entry.entity_type)) return "units";
  if (entry.entity_type === "stock_asset" || entry.entity_type === "stock_position") return "shares";
  return entry.after_snapshot?.currency as string ?? "units";
}

function formatOriginalDate(entry: ActivityLog): string {
  const dateStr = entry.effective_date ?? entry.created_at;
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Component ───────────────────────────────────────────

export function SplitModal({ entry, onClose, onSplit }: SplitModalProps) {
  const id = useId();
  const [legs, setLegs] = useState<SplitLegDraft[]>([{ effective_date: "", quantity: "", cost: "" }]);
  const [costCurrency, setCostCurrency] = useState<CostCurrency>("EUR");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const originalQty = entry ? extractQuantity(entry) : null;
  const absOriginalQty = originalQty !== null ? Math.abs(originalQty) : null;
  const today = new Date().toISOString().split("T")[0];
  const showCostFields = entry !== null && !hideCostFields(entry);

  // Reset state when entry changes
  useEffect(() => {
    if (entry) {
      setLegs([{ effective_date: "", quantity: "", cost: "" }]);
      setError(null);
      setLoading(false);
    }
  }, [entry]);

  const updateLeg = useCallback((index: number, field: keyof SplitLegDraft, value: string) => {
    setLegs((prev) => prev.map((leg, i) => (i === index ? { ...leg, [field]: value } : leg)));
  }, []);

  const removeLeg = useCallback((index: number) => {
    setLegs((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addLeg = useCallback(() => {
    setLegs((prev) => [...prev, { effective_date: "", quantity: "", cost: "" }]);
  }, []);

  // ── Derived values ──

  const parsedLegQuantities = legs.map((l) => {
    const n = parseFloat(l.quantity);
    return isNaN(n) ? 0 : n;
  });
  const legSum = parsedLegQuantities.reduce((a, b) => a + b, 0);
  const remaining = absOriginalQty !== null ? absOriginalQty - legSum : 0;
  const remainderDate = entry
    ? entry.effective_date ?? entry.created_at.split("T")[0]
    : "";

  // ── Cost-related derived values ──
  // parsedLegCosts[i]: the number if leg i's cost is non-blank and finite; null otherwise.
  const parsedLegCosts = legs.map((l) => {
    if (l.cost.trim() === "") return null;
    const n = parseFloat(l.cost);
    return n; // may be NaN — we check below
  });
  const hasCostNaN = showCostFields && parsedLegCosts.some((c) => c !== null && isNaN(c));
  const filledCosts = parsedLegCosts.filter((c): c is number => c !== null && !isNaN(c));
  const costSum = filledCosts.reduce((a, b) => a + b, 0);
  const hasSomeCost = filledCosts.length > 0;

  // ── Validation ──

  function validate(): string | null {
    if (absOriginalQty === null || absOriginalQty === 0) {
      return "Cannot determine original quantity from snapshots";
    }

    // NaN cost blocks save
    if (hasCostNaN) {
      return "Amount paid must be a valid number";
    }

    // All leg quantities must be positive
    for (let i = 0; i < legs.length; i++) {
      const qty = parsedLegQuantities[i];
      if (qty <= 0) return `Allocation ${i + 1}: quantity must be positive`;
    }

    // Sum cannot exceed original
    if (legSum > absOriginalQty + absOriginalQty * 0.0001) {
      return "Total allocated exceeds original quantity";
    }

    // All dates must be valid and not in the future
    for (let i = 0; i < legs.length; i++) {
      const d = legs[i].effective_date;
      if (!d) return `Allocation ${i + 1}: date is required`;
      if (d > today) return `Allocation ${i + 1}: date cannot be in the future`;
    }

    // Collect all dates (legs + remainder if any)
    const allDates = new Set(legs.map((l) => l.effective_date));
    if (remaining > absOriginalQty * 0.0001) {
      allDates.add(remainderDate);
    }

    // No duplicate dates among legs
    if (allDates.size < legs.length + (remaining > absOriginalQty * 0.0001 ? 1 : 0)) {
      return "All dates must be unique (including remainder date)";
    }

    // Need at least 2 distinct dates total (legs + remainder)
    const totalLegs = legs.length + (remaining > absOriginalQty * 0.0001 ? 1 : 0);
    if (totalLegs < 2) return "Need at least 2 date allocations";
    if (allDates.size < 2) return "Need at least 2 distinct dates";

    return null;
  }

  const validationError = entry ? validate() : null;
  const isValid = validationError === null;

  // ── Submit ──

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!entry || !isValid || absOriginalQty === null) return;

    setError(null);
    setLoading(true);

    try {
      // Build final legs array
      const finalLegs: { effective_date: string; quantity: number; cost?: { amount: number; currency: "EUR" | "USD" } }[] = legs.map((l, i) => {
        const parsedCost = parsedLegCosts[i];
        const base = {
          effective_date: l.effective_date,
          quantity: parsedLegQuantities[i],
        };
        // Only emit cost when the field is non-blank and a valid finite number
        if (showCostFields && parsedCost !== null && !isNaN(parsedCost) && isFinite(parsedCost)) {
          return { ...base, cost: { amount: parsedCost, currency: costCurrency } };
        }
        return base;
      });

      // Add remainder leg if there is leftover quantity
      if (remaining > absOriginalQty * 0.0001) {
        finalLegs.push({
          effective_date: remainderDate,
          quantity: remaining,
        });
      }

      const result = await onSplit(entry.id, finalLegs);
      if (result.success) {
        onClose();
      } else {
        setError(result.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to split entry");
    } finally {
      setLoading(false);
    }
  }

  if (!entry) return null;

  const isCrypto = isCryptoEntry(entry);
  const step = isCrypto ? "any" : "0.01";
  const unit = getUnit(entry);

  return (
    <Modal open={entry !== null} onClose={onClose} title="Split Entry">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Entry info */}
        <div>
          <p className="text-sm text-zinc-200 font-medium">
            {entry.entity_name}
            {absOriginalQty !== null && (
              <span className="text-zinc-400 font-normal">
                {" "}· {absOriginalQty.toLocaleString(undefined, { maximumFractionDigits: 6 })} {unit}
              </span>
            )}
          </p>
          <p className="text-xs text-zinc-400 mt-0.5">
            Recorded: {formatOriginalDate(entry)}
          </p>
        </div>

        {/* Allocations */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs text-zinc-400">Allocations</label>
            {showCostFields && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-zinc-400">Currency:</span>
                <select
                  value={costCurrency}
                  onChange={(e) => setCostCurrency(e.target.value as CostCurrency)}
                  aria-label="Cost currency"
                  className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-100 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                >
                  <option value="EUR">EUR</option>
                  <option value="USD">USD</option>
                </select>
              </div>
            )}
          </div>
          <div className="space-y-2">
            {legs.map((leg, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="date"
                  max={today}
                  value={leg.effective_date}
                  onChange={(e) => updateLeg(i, "effective_date", e.target.value)}
                  aria-label={`Allocation ${i + 1} date`}
                  className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                  required
                />
                <input
                  id={`${id}-qty-${i}`}
                  type="number"
                  step={step}
                  min="0"
                  value={leg.quantity}
                  onChange={(e) => updateLeg(i, "quantity", e.target.value)}
                  placeholder="0"
                  aria-label={`Allocation ${i + 1} quantity`}
                  className="w-28 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                  required
                />
                {showCostFields && (
                  <input
                    id={`${id}-cost-${i}`}
                    type="text"
                    inputMode="decimal"
                    value={leg.cost}
                    onChange={(e) => updateLeg(i, "cost", e.target.value)}
                    placeholder="Amount paid"
                    aria-label={`Allocation ${i + 1} amount paid`}
                    className="w-28 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                  />
                )}
                {legs.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeLeg(i)}
                    className="p-1.5 rounded text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    aria-label={`Remove allocation ${i + 1}`}
                    title="Remove"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Remaining indicator */}
        {absOriginalQty !== null && (
          <p className="text-xs text-zinc-400">
            {remaining > absOriginalQty * 0.0001 ? (
              <>
                Remaining:{" "}
                <span className="text-zinc-200 font-medium">
                  {remaining.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                </span>
                {" "}→ stays at {formatOriginalDate(entry)}
              </>
            ) : remaining < -(absOriginalQty * 0.0001) ? (
              <span className="text-red-400">
                Over-allocated by {Math.abs(remaining).toLocaleString(undefined, { maximumFractionDigits: 6 })}
              </span>
            ) : (
              <span className="text-emerald-400">Fully allocated</span>
            )}
          </p>
        )}

        {/* Cost hint — shown when at least one leg has a cost; NOT blocking */}
        {showCostFields && hasSomeCost && !hasCostNaN && (
          <p className="text-xs text-zinc-400">
            Costs entered:{" "}
            <span className="text-zinc-200 font-medium">
              {fmtCurrency(costSum, costCurrency)}
            </span>
            {" "}— costs should sum to what you actually paid
          </p>
        )}

        {/* NaN cost alert */}
        {hasCostNaN && (
          <p role="alert" className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            Amount paid must be a valid number
          </p>
        )}

        {/* Add date button */}
        <div className="flex justify-center">
          <button
            type="button"
            onClick={addLeg}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800/50 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add date
          </button>
        </div>

        {/* Error display */}
        {error && (
          <p role="alert" className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {error}
          </p>
        )}

        {/* Footer buttons */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!isValid || loading}
            aria-busy={loading}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
          >
            {loading ? "Splitting..." : "Split"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
