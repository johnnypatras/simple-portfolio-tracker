"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { Plus, Save, Trash2, Loader2, X, Check } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import { upsertStockPosition, deleteStockPosition, updateStockAsset } from "@/lib/actions/stocks";
import type { StockAssetWithPositions, Broker, AssetCategory } from "@/lib/types";

const TYPES: { value: AssetCategory; label: string }[] = [
  { value: "individual_stock", label: "Individual Stock" },
  { value: "etf", label: "ETF" },
  { value: "bond_fixed_income", label: "Bond / Fixed Income" },
  { value: "other", label: "Other" },
];

/** Seeded subtype suggestions per asset type */
const SEEDED_SUBTYPES: Record<AssetCategory, string[]> = {
  etf: ["UCITS", "Non-UCITS"],
  bond_fixed_income: ["Government", "Corporate"],
  individual_stock: [],
  other: [],
};

interface StockPositionEditorProps {
  open: boolean;
  onClose: () => void;
  asset: StockAssetWithPositions;
  brokers: Broker[];
  existingSubcategories: string[];
  existingTags: string[];
}

export function StockPositionEditor({
  open,
  onClose,
  asset,
  brokers,
  existingSubcategories,
  existingTags,
}: StockPositionEditorProps) {
  const [error, setError] = useState<string | null>(null);

  // Per-row save tracking (replaces single shared `loading`)
  const [savingId, setSavingId] = useState<string | null>(null);
  const [justSavedId, setJustSavedId] = useState<string | null>(null);

  // Clear the "just saved" checkmark after 1.5s
  useEffect(() => {
    if (!justSavedId) return;
    const t = setTimeout(() => setJustSavedId(null), 1500);
    return () => clearTimeout(t);
  }, [justSavedId]);

  // Category + subcategory + tags editing
  const [category, setCategory] = useState<AssetCategory>(asset.category);
  const [subcategory, setSubcategory] = useState(asset.subcategory ?? "");
  const [subcategoryOpen, setSubcategoryOpen] = useState(false);
  const [tags, setTags] = useState<string[]>(asset.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [tagsOpen, setTagsOpen] = useState(false);
  const [metaSaving, setMetaSaving] = useState(false);
  const categoryChanged = category !== asset.category;
  const subcategoryChanged = (subcategory.trim() || null) !== (asset.subcategory ?? null);
  const tagsChanged = JSON.stringify(tags) !== JSON.stringify(asset.tags ?? []);
  const metaChanged = categoryChanged || subcategoryChanged || tagsChanged;

  async function handleMetaSave() {
    setMetaSaving(true);
    setError(null);
    try {
      await updateStockAsset(asset.id, {
        ...(categoryChanged ? { category } : {}),
        ...(subcategoryChanged ? { subcategory: subcategory.trim() || null } : {}),
        ...(tagsChanged ? { tags } : {}),
      });
      toast.success("Asset updated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setMetaSaving(false);
    }
  }

  // Track edits: brokerId → quantity string
  const [edits, setEdits] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    asset.positions.forEach((p) => {
      map[p.broker_id] = p.quantity.toString();
    });
    return map;
  });

  // Build a lookup of original values for dirty detection
  const originals = useMemo(() => {
    const map: Record<string, string> = {};
    asset.positions.forEach((p) => {
      map[p.broker_id] = p.quantity.toString();
    });
    return map;
  }, [asset.positions]);

  // Dirty detection per row
  const isDirty = useCallback(
    (brokerId: string) => {
      const edit = edits[brokerId];
      const orig = originals[brokerId];
      if (orig === undefined) return true; // newly added row is always "dirty"
      return edit !== orig;
    },
    [edits, originals]
  );

  // Which broker to add a new position for
  const [addingBroker, setAddingBroker] = useState("");

  // Brokers that don't already have a position
  const usedBrokerIds = new Set(asset.positions.map((p) => p.broker_id));
  const availableBrokers = brokers.filter((b) => !usedBrokerIds.has(b.id));

  function handleQuantityChange(brokerId: string, value: string) {
    setEdits((prev) => ({ ...prev, [brokerId]: value }));
  }

  async function handleSave(brokerId: string) {
    setError(null);
    setSavingId(brokerId);

    const qty = parseFloat(edits[brokerId] ?? "0");
    try {
      await upsertStockPosition({
        stock_asset_id: asset.id,
        broker_id: brokerId,
        quantity: qty,
      });
      // If zero, remove from local state
      if (qty <= 0) {
        setEdits((prev) => {
          const next = { ...prev };
          delete next[brokerId];
          return next;
        });
      }
      setJustSavedId(brokerId);
      toast.success("Position saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingId(null);
    }
  }

  async function handleDelete(positionId: string, brokerId: string) {
    setError(null);
    setSavingId(brokerId);
    try {
      await deleteStockPosition(positionId);
      setEdits((prev) => {
        const next = { ...prev };
        delete next[brokerId];
        return next;
      });
      toast.success("Position removed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setSavingId(null);
    }
  }

  function handleAddBroker() {
    if (!addingBroker) return;
    setEdits((prev) => ({ ...prev, [addingBroker]: "0" }));
    setAddingBroker("");
  }

  // All positions: existing + newly added
  const allBrokerIds = Object.keys(edits);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${asset.name} (${asset.ticker}) Positions`}
    >
      <div className="space-y-4">
        {/* Type + Subtype */}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {/* Type dropdown */}
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Type</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as AssetCategory)}
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              >
                {TYPES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>

            {/* Subtype combobox */}
            <div className="relative">
              <label className="block text-xs text-zinc-500 mb-1">
                Subtype
              </label>
              <input
                type="text"
                value={subcategory}
                onChange={(e) => {
                  setSubcategory(e.target.value);
                  setSubcategoryOpen(true);
                }}
                onFocus={() => setSubcategoryOpen(true)}
                onBlur={() => setTimeout(() => setSubcategoryOpen(false), 150)}
                placeholder="e.g. UCITS, Non-UCITS..."
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              />
              {subcategoryOpen && (() => {
                const seeded = SEEDED_SUBTYPES[category] ?? [];
                const all = [...new Set([...seeded, ...existingSubcategories])];
                const filtered = all.filter(
                  (s) =>
                    s.toLowerCase().includes(subcategory.toLowerCase()) &&
                    s.toLowerCase() !== subcategory.toLowerCase()
                );
                if (filtered.length === 0) return null;
                return (
                  <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl max-h-36 overflow-y-auto">
                    {filtered.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setSubcategory(s);
                          setSubcategoryOpen(false);
                        }}
                        className="w-full text-left px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800/50 transition-colors"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>

          </div>

          {/* Tags (chip input with autocomplete) */}
          <div className="relative">
            <label className="block text-xs text-zinc-500 mb-1">Tags</label>
            <div className="w-full min-h-[38px] px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg flex flex-wrap items-center gap-1 focus-within:ring-2 focus-within:ring-blue-500/40">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 flex items-center gap-1"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => setTags(tags.filter((t) => t !== tag))}
                    className="text-zinc-500 hover:text-zinc-300"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={tagInput}
                onChange={(e) => {
                  setTagInput(e.target.value);
                  setTagsOpen(true);
                }}
                onFocus={() => setTagsOpen(true)}
                onBlur={() => setTimeout(() => setTagsOpen(false), 150)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tagInput.trim()) {
                    e.preventDefault();
                    const v = tagInput.trim();
                    if (!tags.includes(v)) setTags([...tags, v]);
                    setTagInput("");
                    setTagsOpen(false);
                  }
                  if (e.key === "Backspace" && !tagInput && tags.length > 0) {
                    setTags(tags.slice(0, -1));
                  }
                }}
                placeholder={tags.length === 0 ? "e.g. S&P 500..." : ""}
                className="flex-1 min-w-[60px] bg-transparent text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none"
              />
            </div>
            {tagsOpen && (() => {
              const filtered = existingTags.filter(
                (t) =>
                  !tags.includes(t) &&
                  t.toLowerCase().includes(tagInput.toLowerCase())
              );
              if (filtered.length === 0) return null;
              return (
                <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl max-h-36 overflow-y-auto">
                  {filtered.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setTags([...tags, t]);
                        setTagInput("");
                        setTagsOpen(false);
                      }}
                      className="w-full text-left px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800/50 transition-colors"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* Save button for type/subtype/tags changes */}
          {metaChanged && (
            <div className="flex justify-end">
              <button
                onClick={handleMetaSave}
                disabled={metaSaving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-blue-400 hover:bg-zinc-800 transition-colors disabled:opacity-50"
                title="Save changes"
              >
                {metaSaving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                Save
              </button>
            </div>
          )}
        </div>

        <div className="border-t border-zinc-800/50" />

        {allBrokerIds.length === 0 && (
          <p className="text-sm text-zinc-500 text-center py-4">
            No positions yet — add a broker below
          </p>
        )}

        {allBrokerIds.map((brokerId) => {
          const broker = brokers.find((b) => b.id === brokerId);
          const existingPosition = asset.positions.find(
            (p) => p.broker_id === brokerId
          );
          const isSaving = savingId === brokerId;
          const isBusy = savingId !== null;
          const dirty = isDirty(brokerId);
          const justSaved = justSavedId === brokerId;

          return (
            <div
              key={brokerId}
              className={`flex items-center gap-1.5 sm:gap-2 rounded-lg transition-colors ${
                justSaved
                  ? "bg-emerald-500/5 border-l-2 border-emerald-500/60 pl-1.5"
                  : dirty
                    ? "bg-blue-500/5 border-l-2 border-blue-500/40 pl-1.5"
                    : "pl-2"
              }`}
            >
              <div className="w-20 sm:w-24 shrink-0">
                <span className="text-sm text-zinc-300 truncate block">
                  {broker?.name ?? "Unknown"}
                </span>
                {dirty && !justSaved && (
                  <span className="text-[10px] text-blue-400/70 font-medium">
                    unsaved
                  </span>
                )}
                {justSaved && (
                  <span className="text-[10px] text-emerald-400/70 font-medium flex items-center gap-0.5">
                    <Check className="w-3 h-3" /> saved
                  </span>
                )}
              </div>
              <input
                type="number"
                step="any"
                value={edits[brokerId] ?? "0"}
                onChange={(e) => handleQuantityChange(brokerId, e.target.value)}
                className="min-w-0 flex-1 px-2 sm:px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                disabled={isSaving}
              />
              <button
                onClick={() => handleSave(brokerId)}
                disabled={isBusy}
                className="p-1.5 sm:p-2 rounded-lg text-blue-400 hover:bg-zinc-800 transition-colors disabled:opacity-50 shrink-0"
                title="Save"
              >
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
              </button>
              {existingPosition && (
                <button
                  onClick={() =>
                    handleDelete(existingPosition.id, brokerId)
                  }
                  disabled={isBusy}
                  className="p-1.5 sm:p-2 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors disabled:opacity-50 shrink-0"
                  title="Remove"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          );
        })}

        {/* Add to broker */}
        {availableBrokers.length > 0 && (
          <div className="flex items-center gap-2 pt-2 border-t border-zinc-800/50">
            <select
              value={addingBroker}
              onChange={(e) => setAddingBroker(e.target.value)}
              className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            >
              <option value="">Add to broker...</option>
              {availableBrokers
                .filter((b) => !allBrokerIds.includes(b.id))
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </select>
            <button
              onClick={handleAddBroker}
              disabled={!addingBroker}
              className="p-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 text-white transition-colors"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        )}

        {brokers.length === 0 && (
          <p className="text-xs text-amber-400/80 bg-amber-400/10 px-3 py-2 rounded-lg">
            Add brokers in Settings first to assign positions
          </p>
        )}

        {error && (
          <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
