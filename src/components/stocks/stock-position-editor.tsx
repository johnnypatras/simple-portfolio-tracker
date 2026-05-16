"use client";

import { useState, useMemo, useCallback, useEffect, useId } from "react";
import { useRouter } from "next/navigation";
import { Plus, Save, Trash2, Loader2, X, Check, ArrowRightLeft, TrendingDown, TrendingUp } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { TransferDialog } from "@/components/ui/transfer-dialog";
import { toast } from "sonner";
import { upsertStockPosition, deleteStockPosition, updateStockAsset } from "@/lib/actions/stocks";
import type { StockAssetWithPositions, Broker, AssetCategory, TransferMode } from "@/lib/types";

const TYPES: { value: AssetCategory; label: string }[] = [
  { value: "individual_stock", label: "Individual Stock" },
  { value: "etf", label: "ETF" },
  { value: "bond_fixed_income", label: "Bond / Fixed Income" },
  { value: "private_equity", label: "Private Equity" },
  { value: "other", label: "Other" },
];

/** Seeded subtype suggestions per asset type */
const SEEDED_SUBTYPES: Record<AssetCategory, string[]> = {
  etf: ["UCITS", "Non-UCITS"],
  bond_fixed_income: ["Government", "Corporate"],
  individual_stock: [],
  private_equity: ["ELTIF", "SICAV", "Closed-end Fund"],
  other: [],
};

interface StockPositionEditorProps {
  open: boolean;
  onClose: () => void;
  asset: StockAssetWithPositions;
  brokers: Broker[];
  existingSubcategories: string[];
  existingTags: string[];
  prices?: Record<string, { price: number; currency: string }>;
}

export function StockPositionEditor({
  open,
  onClose,
  asset,
  brokers,
  existingSubcategories,
  existingTags,
  prices,
}: StockPositionEditorProps) {
  const id = useId();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  // Transfer dialog state
  const [transferMode, setTransferMode] = useState<TransferMode | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [moveSourceBrokerId, setMoveSourceBrokerId] = useState<string | null>(null);

  // Per-row save tracking (replaces single shared `loading`)
  const [savingId, setSavingId] = useState<string | null>(null);
  const [justSavedId, setJustSavedId] = useState<string | null>(null);
  // Optimistic override for last_was_adjustment (bridges gap until props refresh)
  const [adjOverrides, setAdjOverrides] = useState<Record<string, boolean>>({});

  // ─── Effective date (optional backdating) ──────────────
  const [effectiveDate, setEffectiveDate] = useState("");

  // Clear the "just saved" checkmark after 1.5s
  useEffect(() => {
    if (!justSavedId) return;
    const t = setTimeout(() => setJustSavedId(null), 1500);
    return () => clearTimeout(t);
  }, [justSavedId]);

  // Asset identity fields
  const [localName, setLocalName] = useState(asset.name);
  const [localYahooTicker, setLocalYahooTicker] = useState(asset.yahoo_ticker ?? "");
  const [localIsin, setLocalIsin] = useState(asset.isin ?? "");

  // Category + subcategory + tags editing
  const [category, setCategory] = useState<AssetCategory>(asset.category);
  const [subcategory, setSubcategory] = useState(asset.subcategory ?? "");
  const [subcategoryOpen, setSubcategoryOpen] = useState(false);
  const [tags, setTags] = useState<string[]>(asset.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [tagsOpen, setTagsOpen] = useState(false);
  const [metaSaving, setMetaSaving] = useState(false);

  // Reset all local state when asset prop changes (user opens different asset)
  useEffect(() => {
    setLocalName(asset.name);
    setLocalYahooTicker(asset.yahoo_ticker ?? "");
    setLocalIsin(asset.isin ?? "");
    setCategory(asset.category);
    setSubcategory(asset.subcategory ?? "");
    setTags(asset.tags ?? []);
    setTagInput("");
    // Reset position edits and adjustment state
    const map: Record<string, string> = {};
    asset.positions.forEach((p) => { map[p.broker_id] = p.quantity.toString(); });
    setEdits(map);
    setAdjustmentFlags({});
    setAdjOverrides({});
    setEffectiveDate("");
  }, [asset.id, asset.name, asset.yahoo_ticker, asset.isin, asset.category, asset.subcategory, asset.tags, asset.positions]);

  const nameChanged = localName.trim() !== asset.name;
  const yahooTickerChanged = (localYahooTicker.trim() || null) !== (asset.yahoo_ticker ?? null);
  const isinChanged = (localIsin.trim() || null) !== (asset.isin ?? null);
  const categoryChanged = category !== asset.category;
  const subcategoryChanged = (subcategory.trim() || null) !== (asset.subcategory ?? null);
  const tagsChanged = JSON.stringify(tags) !== JSON.stringify(asset.tags ?? []);
  const metaChanged = nameChanged || yahooTickerChanged || isinChanged || categoryChanged || subcategoryChanged || tagsChanged;

  async function handleMetaSave() {
    setMetaSaving(true);
    setError(null);
    try {
      await updateStockAsset(asset.id, {
        ...(nameChanged ? { name: localName.trim() } : {}),
        ...(yahooTickerChanged ? { yahoo_ticker: localYahooTicker.trim() || null } : {}),
        ...(isinChanged ? { isin: localIsin.trim() || null } : {}),
        ...(categoryChanged ? { category } : {}),
        ...(subcategoryChanged ? { subcategory: subcategory.trim() || null } : {}),
        ...(tagsChanged ? { tags } : {}),
      });
      toast.success("Asset updated");
      router.refresh();
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

  // Per-row adjustment flags (transient, not part of position data)
  const [adjustmentFlags, setAdjustmentFlags] = useState<Record<string, boolean>>({});

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
    const yahooTicker = asset.yahoo_ticker;
    const priceData = yahooTicker ? prices?.[yahooTicker] : undefined;
    try {
      await upsertStockPosition({
        stock_asset_id: asset.id,
        broker_id: brokerId,
        quantity: qty,
      }, {
        isAdjustment: adjustmentFlags[brokerId] ?? false,
        currentPriceNative: priceData?.price,
        assetCurrency: priceData?.currency ?? asset.currency,
        ...(effectiveDate ? { effectiveDate } : {}),
      });
      // If zero, remove from local state
      if (qty <= 0) {
        setEdits((prev) => {
          const next = { ...prev };
          delete next[brokerId];
          return next;
        });
      }
      // Optimistic badge update + reset the adj checkbox after save
      const wasAdj = adjustmentFlags[brokerId] ?? false;
      setAdjOverrides((prev) => ({ ...prev, [brokerId]: wasAdj }));
      setAdjustmentFlags((prev) => ({ ...prev, [brokerId]: false }));
      setJustSavedId(brokerId);
      toast.success(wasAdj ? "Saved as adjustment" : "Position saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingId(null);
    }
  }

  async function handleDelete(positionId: string, brokerId: string) {
    setError(null);
    setSavingId(brokerId);
    const yahooTicker = asset.yahoo_ticker;
    const priceData = yahooTicker ? prices?.[yahooTicker] : undefined;
    try {
      await deleteStockPosition(positionId, {
        isAdjustment: adjustmentFlags[brokerId] ?? false,
        currentPriceNative: priceData?.price,
        assetCurrency: priceData?.currency ?? asset.currency,
      });
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
        {/* Asset identity fields */}
        <div className="space-y-3">
          <div>
            <label htmlFor={`${id}-name`} className="block text-xs text-zinc-400 mb-1">Name</label>
            <input
              id={`${id}-name`}
              type="text"
              value={localName}
              onChange={(e) => setLocalName(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${id}-yahoo-ticker`} className="block text-xs text-zinc-400 mb-1">Yahoo Ticker</label>
              <input
                id={`${id}-yahoo-ticker`}
                type="text"
                value={localYahooTicker}
                onChange={(e) => setLocalYahooTicker(e.target.value)}
                placeholder="e.g. AAPL, BY6.F"
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
              />
            </div>
            <div>
              <label htmlFor={`${id}-isin`} className="block text-xs text-zinc-400 mb-1">ISIN</label>
              <input
                id={`${id}-isin`}
                type="text"
                value={localIsin}
                onChange={(e) => setLocalIsin(e.target.value)}
                placeholder="e.g. US0378331005"
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
              />
            </div>
          </div>
        </div>

        {/* Type + Subtype */}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {/* Type dropdown */}
            <div>
              <label htmlFor={`${id}-type`} className="block text-xs text-zinc-400 mb-1">Type</label>
              <select
                id={`${id}-type`}
                value={category}
                onChange={(e) => setCategory(e.target.value as AssetCategory)}
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70"
              >
                {TYPES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>

            {/* Subtype combobox */}
            <div className="relative">
              <label htmlFor={`${id}-subtype`} className="block text-xs text-zinc-400 mb-1">
                Subtype
              </label>
              <input
                id={`${id}-subtype`}
                type="text"
                value={subcategory}
                onChange={(e) => {
                  setSubcategory(e.target.value);
                  setSubcategoryOpen(true);
                }}
                onFocus={() => setSubcategoryOpen(true)}
                onBlur={() => setTimeout(() => setSubcategoryOpen(false), 150)}
                placeholder="e.g. UCITS, Non-UCITS..."
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
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
            <label htmlFor={`${id}-tags`} className="block text-xs text-zinc-400 mb-1">Tags</label>
            <div className="w-full min-h-[38px] px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg flex flex-wrap items-center gap-1 focus-within:ring-2 focus-within:ring-blue-500/70">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 flex items-center gap-1"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => setTags(tags.filter((t) => t !== tag))}
                    className="text-zinc-400 hover:text-zinc-300"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              <input
                id={`${id}-tags`}
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

        {/* Sell / Buy actions */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => { setTransferMode("sell"); setTransferOpen(true); }}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-400 hover:text-red-400 hover:bg-zinc-800/50 transition-colors"
            title="Sell this asset"
          >
            <TrendingDown className="w-3 h-3" /> Sell
          </button>
          <button
            type="button"
            onClick={() => { setTransferMode("buy"); setTransferOpen(true); }}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-400 hover:text-emerald-400 hover:bg-zinc-800/50 transition-colors"
            title="Buy more of this asset"
          >
            <TrendingUp className="w-3 h-3" /> Buy
          </button>
        </div>

        <div className="border-t border-zinc-800/50" />

        {allBrokerIds.length === 0 && (
          <p className="text-sm text-zinc-400 text-center py-4">
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
              className={`space-y-1.5 rounded-lg transition-colors ${
                justSaved
                  ? "bg-emerald-500/5 border-l-2 border-emerald-500/60 pl-2"
                  : dirty
                    ? "bg-blue-500/5 border-l-2 border-blue-500/40 pl-2"
                    : "pl-2.5"
              }`}
            >
              {/* Broker name header */}
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zinc-300 truncate">
                  {broker?.name ?? "Unknown"}
                </span>
                {/* Stable container prevents insertBefore errors from browser extensions (Safari + Dark Reader) */}
                <div className="flex items-center gap-1.5">
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
                  {existingPosition?.last_was_transfer && !justSaved && (
                    <span className="text-[10px] text-teal-400 font-medium" title="Last change was a sell/buy/move transfer">
                      Xfer
                    </span>
                  )}
                  {!existingPosition?.last_was_transfer && (adjOverrides[brokerId] ?? existingPosition?.last_was_adjustment) && !justSaved && (
                    <span className="text-[10px] text-amber-400 font-medium" title="Not a real transaction — portfolio balance correction">
                      Adj.
                    </span>
                  )}
                </div>
                <label className="ml-auto flex items-center gap-1 text-[10px] text-zinc-400 cursor-pointer select-none" title="Not a real transaction — portfolio balance correction">
                  <input
                    type="checkbox"
                    checked={adjustmentFlags[brokerId] ?? false}
                    onChange={(e) => setAdjustmentFlags((prev) => ({ ...prev, [brokerId]: e.target.checked }))}
                    className="w-3 h-3 accent-amber-500"
                  />
                  Adj.
                </label>
              </div>
              {/* Quantity + Actions */}
              <div className="flex items-center gap-1.5 sm:gap-2">
                <input
                  type="number"
                  step="any"
                  value={edits[brokerId] ?? "0"}
                  onChange={(e) => handleQuantityChange(brokerId, e.target.value)}
                  className="min-w-0 flex-1 px-2 sm:px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                  disabled={isSaving}
                />
                <button
                  onClick={() => handleSave(brokerId)}
                  disabled={isBusy}
                  className="p-1.5 sm:p-2 rounded-lg text-blue-400 hover:bg-zinc-800 transition-colors disabled:opacity-50 shrink-0"
                  title="Save"
                  aria-label="Save"
                >
                  {isSaving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                </button>
                {existingPosition && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setMoveSourceBrokerId(brokerId);
                        setTransferMode("move");
                        setTransferOpen(true);
                      }}
                      disabled={isBusy}
                      className="p-1 rounded text-zinc-400 hover:text-blue-400 hover:bg-zinc-800/50 transition-colors disabled:opacity-50 shrink-0"
                      title="Move to another broker"
                      aria-label="Move to another broker"
                    >
                      <ArrowRightLeft className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() =>
                        handleDelete(existingPosition.id, brokerId)
                      }
                      disabled={isBusy}
                      className="p-1.5 sm:p-2 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-zinc-800 transition-colors disabled:opacity-50 shrink-0"
                      title="Remove"
                      aria-label="Remove"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}

        {/* Add to broker */}
        {availableBrokers.length > 0 && (
          <div className="flex items-center gap-2 pt-2 border-t border-zinc-800/50">
            <select
              value={addingBroker}
              onChange={(e) => setAddingBroker(e.target.value)}
              className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70"
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
              aria-label="Add to selected broker"
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

        {/* Effective date (optional) */}
        <div>
          <label htmlFor={`${id}-effective-date`} className="block text-xs text-zinc-400 mb-1">
            Effective date (optional)
          </label>
          <input
            id={`${id}-effective-date`}
            type="date"
            max={new Date().toISOString().split("T")[0]}
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-zinc-100 text-sm"
          />
          <p className="text-[10px] text-zinc-400 mt-1">Leave empty to use today&apos;s date</p>
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {error}
          </p>
        )}
      </div>

      {transferOpen && transferMode && (() => {
        const yahooTicker = asset.yahoo_ticker;
        const priceData = yahooTicker ? prices?.[yahooTicker] : undefined;

        // For sell/move, determine which broker is the source
        const sourceBrokerId = transferMode === "move" ? moveSourceBrokerId : asset.positions[0]?.broker_id;
        const sourcePosition = asset.positions.find((p) => p.broker_id === sourceBrokerId);
        const sourceBroker = brokers.find((b) => b.id === sourceBrokerId);

        return (
          <TransferDialog
            open={transferOpen}
            onClose={() => { setTransferOpen(false); setMoveSourceBrokerId(null); }}
            onSuccess={() => { router.refresh(); onClose(); }}
            mode={transferMode}
            initialSource={transferMode !== "buy" ? {
              type: "stock_position",
              assetId: asset.id,
              assetName: asset.name,
              assetTicker: asset.ticker ?? asset.yahoo_ticker ?? "",
              locationId: sourceBrokerId ?? "",
              locationName: sourceBroker?.name ?? "Unknown",
              currentQty: sourcePosition?.quantity ?? 0,
              currency: asset.currency,
              currentPrice: priceData?.price,
            } : undefined}
            initialDestination={transferMode === "buy" ? {
              type: "stock_position",
              assetId: asset.id,
              assetName: asset.name,
              assetTicker: asset.ticker ?? asset.yahoo_ticker ?? "",
              locationId: asset.positions[0]?.broker_id ?? "",
              locationName: brokers.find((b) => b.id === asset.positions[0]?.broker_id)?.name ?? "Unknown",
              currentQty: 0,
              currency: asset.currency,
              currentPrice: priceData?.price,
            } : undefined}
          />
        );
      })()}
    </Modal>
  );
}
