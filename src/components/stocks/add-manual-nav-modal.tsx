"use client";

import { useState, useEffect, useId } from "react";
import { Loader2, ChevronDown, ChevronRight, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import { addManualNavAsset } from "@/lib/actions/manual-nav";
import { upsertStockPosition } from "@/lib/actions/stocks";
import { MAX_NAV_NOTE_LENGTH } from "@/lib/constants";
import type { AssetCategory, Broker } from "@/lib/types";

interface AddManualNavModalProps {
  open: boolean;
  onClose: () => void;
  brokers: Broker[];
  existingSubcategories: string[];
  existingTags: string[];
}

const TYPES: { value: AssetCategory; label: string }[] = [
  { value: "private_equity", label: "Private Equity" },
  { value: "etf", label: "ETF" },
  { value: "bond_fixed_income", label: "Bond / Fixed Income" },
  { value: "individual_stock", label: "Individual Stock" },
  { value: "other", label: "Other" },
];

const SEEDED_SUBTYPES: Record<AssetCategory, string[]> = {
  etf: ["UCITS", "Non-UCITS"],
  bond_fixed_income: ["Government", "Corporate"],
  individual_stock: [],
  private_equity: ["ELTIF", "SICAV", "Closed-end Fund"],
  other: [],
};

export function AddManualNavModal({
  open,
  onClose,
  brokers,
  existingSubcategories,
  existingTags,
}: AddManualNavModalProps) {
  const id = useId();
  const today = new Date().toISOString().split("T")[0];

  // ─── Asset form state ────────────────────────────────────
  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("");
  const [isin, setIsin] = useState("");
  const [category, setCategory] = useState<AssetCategory>("private_equity");
  const [currency, setCurrency] = useState("EUR");
  const [subcategory, setSubcategory] = useState("ELTIF");
  const [subcategoryOpen, setSubcategoryOpen] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tagsOpen, setTagsOpen] = useState(false);

  // ─── Initial NAV state ───────────────────────────────────
  const [navValue, setNavValue] = useState("");
  const [navDate, setNavDate] = useState(today);
  const [navNote, setNavNote] = useState("");

  // ─── Initial position state (optional) ──────────────────
  const [positionOpen, setPositionOpen] = useState(false);
  const [positionBrokerId, setPositionBrokerId] = useState("");
  const [positionQuantity, setPositionQuantity] = useState("");

  // ─── Adjustment + effective date ────────────────────────
  const [isAdjustment, setIsAdjustment] = useState(false);
  const [effectiveDate, setEffectiveDate] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edge 5: warn when the NAV's as-of-date is later than the position's
  // effective_date — the augmentation will show €0 for the gap because
  // there's no earlier NAV to forward-fill from.
  const navGapWarning =
    effectiveDate && navDate && effectiveDate < navDate && parseFloat(positionQuantity || "0") > 0
      ? `Your position is backdated to ${effectiveDate} but the earliest NAV is ${navDate}. The chart will show €0 for this asset between those dates — consider adding an earlier NAV or moving the effective date.`
      : null;

  // Reset all state when modal closes
  useEffect(() => {
    if (!open) {
      setTicker("");
      setName("");
      setIsin("");
      setCategory("private_equity");
      setCurrency("EUR");
      setSubcategory("ELTIF");
      setSubcategoryOpen(false);
      setTags([]);
      setTagInput("");
      setTagsOpen(false);
      setNavValue("");
      setNavDate(today);
      setNavNote("");
      setPositionOpen(false);
      setPositionBrokerId("");
      setPositionQuantity("");
      setIsAdjustment(false);
      setEffectiveDate("");
      setError(null);
      setLoading(false);
    }
  }, [open, today]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ticker.trim() || !name.trim()) return;

    setError(null);
    setLoading(true);

    try {
      const navNum = navValue.trim() ? parseFloat(navValue) : null;
      if (navValue.trim() && (navNum === null || isNaN(navNum) || navNum <= 0)) {
        throw new Error("Initial NAV must be a positive number");
      }

      const initialNav =
        navNum !== null && navDate
          ? { nav: navNum, effectiveDate: navDate, note: navNote.trim() || null }
          : undefined;

      const adjustOpts = isAdjustment ? { isAdjustment: true } : {};
      const dateOpts = effectiveDate ? { effectiveDate } : {};

      // Two-phase: (1) asset+NAV via addManualNavAsset, (2) optional position
      // via upsertStockPosition. If (1) succeeds but (2) fails, the asset is
      // already committed — show a recovery-friendly error so the user knows
      // the asset was saved and can re-attempt the position separately.
      const assetId = await addManualNavAsset(
        {
          ticker: ticker.trim(),
          name: name.trim(),
          isin: isin.trim() || null,
          yahoo_ticker: null,
          category,
          tags,
          currency,
          subcategory: subcategory.trim() || null,
        },
        { initialNav, ...adjustOpts, ...dateOpts },
      );

      const qty = parseFloat(positionQuantity);
      if (positionBrokerId && qty > 0) {
        try {
          await upsertStockPosition(
            {
              stock_asset_id: assetId,
              broker_id: positionBrokerId,
              quantity: qty,
            },
            {
              ...adjustOpts,
              ...dateOpts,
              currentPriceNative: navNum ?? undefined,
              assetCurrency: currency,
            },
          );
        } catch (posErr) {
          // Asset is already created and persisted. Surface a recovery
          // message so the user knows they don't need to re-create the
          // asset — they just need to add the position separately.
          const posMsg = posErr instanceof Error ? posErr.message : "Failed to create initial position";
          throw new Error(
            `${name.trim()} was added, but the initial position could not be created: ${posMsg}. Open the asset to add a position separately.`,
          );
        }
      }

      onClose();
      toast.success(`${name.trim()} added to portfolio`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add asset");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Manual NAV Asset">
      <p className="text-xs text-zinc-400 mb-4">
        For ELTIFs, SICAVs, closed-end funds, and other assets without a Yahoo
        ticker. You&apos;ll record the NAV manually from fund letters.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Ticker + Name */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${id}-ticker`} className="block text-xs text-zinc-400 mb-1">
              Ticker *
            </label>
            <input
              id={`${id}-ticker`}
              type="text"
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="ENXF"
              required
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70 uppercase"
            />
          </div>
          <div>
            <label htmlFor={`${id}-name`} className="block text-xs text-zinc-400 mb-1">
              Name *
            </label>
            <input
              id={`${id}-name`}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="EQT Nexus ELTIF"
              required
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
            />
          </div>
        </div>

        {/* ISIN + Currency */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${id}-isin`} className="block text-xs text-zinc-400 mb-1">
              ISIN <span className="text-zinc-400">(optional)</span>
            </label>
            <input
              id={`${id}-isin`}
              type="text"
              value={isin}
              onChange={(e) => setIsin(e.target.value)}
              placeholder="LU2647386234"
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70 uppercase"
            />
          </div>
          <div>
            <label htmlFor={`${id}-currency`} className="block text-xs text-zinc-400 mb-1">
              Currency *
            </label>
            <input
              id={`${id}-currency`}
              type="text"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              placeholder="EUR"
              maxLength={3}
              required
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70 uppercase"
            />
          </div>
        </div>

        {/* Type + Subtype */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${id}-type`} className="block text-xs text-zinc-400 mb-1">
              Type
            </label>
            <select
              id={`${id}-type`}
              value={category}
              onChange={(e) => setCategory(e.target.value as AssetCategory)}
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70"
            >
              {TYPES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="relative">
            <label htmlFor={`${id}-subtype`} className="block text-xs text-zinc-400 mb-1">
              Subtype
            </label>
            <input
              id={`${id}-subtype`}
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={subcategoryOpen}
              aria-controls={`${id}-subtype-list`}
              value={subcategory}
              onChange={(e) => {
                setSubcategory(e.target.value);
                setSubcategoryOpen(true);
              }}
              onFocus={() => setSubcategoryOpen(true)}
              onBlur={() => setTimeout(() => setSubcategoryOpen(false), 150)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && subcategoryOpen) {
                  e.preventDefault();
                  setSubcategoryOpen(false);
                }
              }}
              placeholder="e.g. ELTIF, SICAV..."
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
            />
            {subcategoryOpen &&
              (() => {
                const seeded = SEEDED_SUBTYPES[category] ?? [];
                const all = [...new Set([...seeded, ...existingSubcategories])];
                const filtered = all.filter(
                  (s) =>
                    s.toLowerCase().includes(subcategory.toLowerCase()) &&
                    s.toLowerCase() !== subcategory.toLowerCase(),
                );
                if (filtered.length === 0) return null;
                return (
                  <div
                    id={`${id}-subtype-list`}
                    role="listbox"
                    className="absolute z-20 top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl max-h-36 overflow-y-auto"
                  >
                    {filtered.map((s) => (
                      <button
                        key={s}
                        type="button"
                        role="option"
                        aria-selected={false}
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

        {/* Tags */}
        <div className="relative">
          <label htmlFor={`${id}-tags`} className="block text-xs text-zinc-400 mb-1">
            Tags
          </label>
          <div className="w-full min-h-[38px] px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg flex flex-wrap items-center gap-1 focus-within:ring-2 focus-within:ring-blue-500/70">
            {tags.map((tag) => (
              <span key={tag} className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 flex items-center gap-1">
                {tag}
                <button
                  type="button"
                  onClick={() => setTags(tags.filter((t) => t !== tag))}
                  className="text-zinc-400 hover:text-zinc-200"
                  aria-label={`Remove tag ${tag}`}
                >
                  <X className="w-3 h-3" aria-hidden="true" />
                </button>
              </span>
            ))}
            <input
              id={`${id}-tags`}
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={tagsOpen}
              aria-controls={`${id}-tags-list`}
              value={tagInput}
              onChange={(e) => {
                setTagInput(e.target.value);
                setTagsOpen(true);
              }}
              onFocus={() => setTagsOpen(true)}
              onBlur={() => setTimeout(() => setTagsOpen(false), 150)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && tagsOpen) {
                  e.preventDefault();
                  setTagsOpen(false);
                  return;
                }
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
              placeholder={tags.length === 0 ? "e.g. Private Markets..." : ""}
              className="flex-1 min-w-[60px] bg-transparent text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none"
            />
          </div>
          {tagsOpen &&
            (() => {
              const filtered = existingTags.filter(
                (t) => !tags.includes(t) && t.toLowerCase().includes(tagInput.toLowerCase()),
              );
              if (filtered.length === 0) return null;
              return (
                <div
                  id={`${id}-tags-list`}
                  role="listbox"
                  className="absolute z-20 top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl max-h-36 overflow-y-auto"
                >
                  {filtered.map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="option"
                      aria-selected={false}
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

        {/* Initial NAV — strongly encouraged */}
        <div className="border border-zinc-800/50 rounded-lg overflow-hidden bg-zinc-900/20">
          <div className="px-3 py-2 text-xs text-zinc-300 font-medium border-b border-zinc-800/50">
            Initial NAV <span className="text-zinc-400 font-normal">(recommended)</span>
          </div>
          <div className="px-3 py-3 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${id}-nav-value`} className="block text-xs text-zinc-400 mb-1">
                  NAV
                </label>
                <input
                  id={`${id}-nav-value`}
                  type="number"
                  inputMode="decimal"
                  value={navValue}
                  onChange={(e) => setNavValue(e.target.value)}
                  placeholder="105.50"
                  step="any"
                  min="0"
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70 tabular-nums"
                />
              </div>
              <div>
                <label htmlFor={`${id}-nav-date`} className="block text-xs text-zinc-400 mb-1">
                  As of date
                </label>
                <input
                  id={`${id}-nav-date`}
                  type="date"
                  value={navDate}
                  max={today}
                  onChange={(e) => setNavDate(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                />
              </div>
            </div>
            <div>
              <label htmlFor={`${id}-nav-note`} className="block text-xs text-zinc-400 mb-1">
                Note <span className="text-zinc-400">(optional, e.g. &quot;Q1 2026 fund letter&quot;)</span>
              </label>
              <input
                id={`${id}-nav-note`}
                type="text"
                value={navNote}
                onChange={(e) => setNavNote(e.target.value)}
                placeholder="Source / provenance"
                maxLength={MAX_NAV_NOTE_LENGTH}
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
              />
            </div>
          </div>
        </div>

        {/* Optional initial position */}
        {brokers.length > 0 && (
          <div className="border border-zinc-800/50 rounded-lg overflow-hidden">
            <button
              type="button"
              aria-expanded={positionOpen}
              aria-controls={`${id}-position-region`}
              onClick={() => setPositionOpen(!positionOpen)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/30 transition-colors"
            >
              {positionOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              Add initial position
              <span className="text-zinc-400">(optional)</span>
            </button>
            {positionOpen && (
              <div id={`${id}-position-region`} className="px-3 pb-3 pt-1 border-t border-zinc-800/50">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor={`${id}-broker`} className="block text-xs text-zinc-400 mb-1">
                      Broker
                    </label>
                    <select
                      id={`${id}-broker`}
                      value={positionBrokerId}
                      onChange={(e) => setPositionBrokerId(e.target.value)}
                      className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                    >
                      <option value="">Select broker...</option>
                      {brokers.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`${id}-shares`} className="block text-xs text-zinc-400 mb-1">
                      Shares
                    </label>
                    <input
                      id={`${id}-shares`}
                      type="number"
                      inputMode="decimal"
                      value={positionQuantity}
                      onChange={(e) => setPositionQuantity(e.target.value)}
                      placeholder="0"
                      step="any"
                      min="0"
                      className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70 tabular-nums"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Effective date (backdating) */}
        <div>
          <label htmlFor={`${id}-effective-date`} className="block text-xs text-zinc-400 mb-1">
            Effective date <span className="text-zinc-400">(optional, for backdating)</span>
          </label>
          <input
            id={`${id}-effective-date`}
            type="date"
            max={today}
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70"
          />
          <p className="text-[10px] text-zinc-400 mt-1">Leave empty to use today&apos;s date</p>
        </div>

        {navGapWarning && (
          <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 px-3 py-2 rounded-lg">
            {navGapWarning}
          </p>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {error}
          </p>
        )}

        <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none" title="Not a real transaction — portfolio balance correction">
          <input
            type="checkbox"
            checked={isAdjustment}
            onChange={(e) => setIsAdjustment(e.target.checked)}
            className="accent-amber-500"
          />
          Portfolio adjustment
        </label>

        <button
          type="submit"
          disabled={loading || !ticker.trim() || !name.trim()}
          aria-busy={loading}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
          Add to Portfolio
        </button>
      </form>
    </Modal>
  );
}
