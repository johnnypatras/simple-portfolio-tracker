"use client";

import { useState, useId, useMemo } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { PickedAsset } from "@/lib/types";
import { ACQUISITION_TYPES } from "@/lib/types";
import type { AcquisitionType, AssetCategory } from "@/lib/types";

// ─── Stock constants ─────────────────────────────────────────────────────────

const STOCK_TYPES: { value: AssetCategory; label: string }[] = [
  { value: "individual_stock", label: "Individual Stock" },
  { value: "etf", label: "ETF" },
  { value: "bond_fixed_income", label: "Bond / Fixed Income" },
  { value: "private_equity", label: "Private Equity" },
  { value: "other", label: "Other" },
];

const SEEDED_SUBTYPES: Record<AssetCategory, string[]> = {
  etf: ["UCITS", "Non-UCITS"],
  bond_fixed_income: ["Government", "Corporate"],
  individual_stock: [],
  private_equity: ["ELTIF", "SICAV", "Closed-end Fund"],
  other: [],
};

// ─── Exported interfaces — Task 3/4/5 reuse these ───────────────────────────

export interface AssetIdentityValue {
  /** Crypto identity */
  chain?: string;
  subcategory?: string;
  /** Crypto position extras (Advanced disclosure) */
  apy?: number;
  acquisitionMethod?: AcquisitionType;
  /** Stock identity — populated by Task 3 */
  currency?: string;
  category?: string;
  tags?: string[];
  isin?: string;
}

export interface AssetIdentityStepProps {
  assetClass: "crypto" | "stock";
  /** The asset chosen in step 1 (from AssetPicker). */
  picked: PickedAsset;
  /** Crypto: suggested chains from /api/crypto/detail */
  availableChains?: string[];
  existingChains?: string[];
  existingSubcategories?: string[];
  existingTags?: string[];
  existingAssets?: { coingecko_id: string; chain: string | null }[];
  /** Current controlled value. */
  value: AssetIdentityValue;
  /** Emit the full updated value object. */
  onChange: (v: AssetIdentityValue) => void;
}

/**
 * Step that confirms/edits a new asset's identity (metadata) between picking an
 * asset and recording the buy. Fully controlled — owns only the `expanded`
 * (Advanced disclosure) toggle as internal state.
 *
 * Task 2: crypto branch (chain combobox + subcategory + Advanced APY/method).
 * Task 3: stock branch fills in the placeholder.
 */
export function AssetIdentityStep({
  assetClass,
  picked,
  availableChains,
  existingChains,
  existingSubcategories,
  existingTags,
  existingAssets,
  value,
  onChange,
}: AssetIdentityStepProps) {
  const id = useId();
  // The only internal state: whether the Advanced section is expanded.
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  // Local draft for the in-progress tag text (ephemeral input, committed tags live in value.tags).
  const [tagDraft, setTagDraft] = useState("");

  // ─── Crypto helpers ──────────────────────────────────────────────────────────

  // Combined chain options: suggested from API + already used in portfolio.
  const chainOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of availableChains ?? []) set.add(c);
    for (const c of existingChains ?? []) set.add(c);
    return [...set].sort();
  }, [availableChains, existingChains]);

  // Chains on which this exact coin is already held.
  const existingChainsForSelected = useMemo(() => {
    const coinId =
      "id" in picked.raw ? (picked.raw as { id: string }).id : undefined;
    if (!coinId) return [];
    return (existingAssets ?? [])
      .filter((a) => a.coingecko_id === coinId)
      .map((a) => a.chain);
  }, [picked.raw, existingAssets]);

  // Show the multi-chain banner when:
  //   - A chain is currently selected, AND
  //   - The coin is already held on at least one chain, AND
  //   - The selected chain is NOT one of the held chains.
  const showMultiChainBanner =
    !!value.chain &&
    existingChainsForSelected.length > 0 &&
    !existingChainsForSelected.includes(value.chain);

  // ─── Stock branch ────────────────────────────────────────────────────────────

  if (assetClass === "stock") {
    // Determine if the picked result had no confirmed currency.
    const rawCurrency =
      "currency" in picked.raw ? (picked.raw as { currency?: string }).currency : undefined;
    const noCurrencyConfirmed = rawCurrency == null;

    const currentCategory = (value.category as AssetCategory) ?? "individual_stock";
    const subtypeOptions = [
      ...new Set([...(SEEDED_SUBTYPES[currentCategory] ?? []), ...(existingSubcategories ?? [])]),
    ].sort();

    const currentTags = value.tags ?? [];
    const tagSuggestions = (existingTags ?? []).filter(
      (t) => !currentTags.includes(t) && t.toLowerCase().includes(tagDraft.toLowerCase()),
    );

    return (
      <div className="space-y-4">
        {/* Currency warning — shown when the picked result had no confirmed currency */}
        {noCurrencyConfirmed && (
          <div role="status" className="text-xs text-amber-400 bg-amber-950/30 border border-amber-900/40 rounded px-3 py-2">
            Couldn&rsquo;t confirm the trading currency — defaulted to USD, please verify.
          </div>
        )}

        {/* Type + Currency row */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${id}-stock-type`} className="block text-xs text-zinc-400 mb-1">
              Type
            </label>
            <select
              id={`${id}-stock-type`}
              value={value.category ?? "individual_stock"}
              onChange={(e) => onChange({ ...value, category: e.target.value as AssetCategory })}
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70"
            >
              {STOCK_TYPES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor={`${id}-currency`} className="block text-xs text-zinc-400 mb-1">
              Currency
            </label>
            <input
              id={`${id}-currency`}
              type="text"
              value={value.currency ?? ""}
              onChange={(e) => onChange({ ...value, currency: e.target.value.toUpperCase() })}
              placeholder="USD"
              maxLength={3}
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70 uppercase"
            />
          </div>
        </div>

        {/* Subcategory + Tags row */}
        <div className="grid grid-cols-2 gap-3">
          {/* Subcategory — combobox (free-text input + datalist) */}
          <div>
            <label htmlFor={`${id}-stock-subtype`} className="block text-xs text-zinc-400 mb-1">
              Subtype <span className="text-zinc-500">(optional)</span>
            </label>
            <input
              id={`${id}-stock-subtype`}
              type="text"
              list={`${id}-stock-subtype-list`}
              value={value.subcategory ?? ""}
              onChange={(e) => onChange({ ...value, subcategory: e.target.value })}
              placeholder="e.g. UCITS, Non-UCITS…"
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
            />
            {subtypeOptions.length > 0 && (
              <datalist id={`${id}-stock-subtype-list`}>
                {subtypeOptions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            )}
          </div>

          {/* Tags — chip input */}
          <div>
            <label htmlFor={`${id}-tags`} className="block text-xs text-zinc-400 mb-1">
              Tags <span className="text-zinc-500">(optional)</span>
            </label>
            <div className="w-full min-h-[38px] px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg flex flex-wrap items-center gap-1 focus-within:ring-2 focus-within:ring-blue-500/70">
              {currentTags.map((tag) => (
                <span
                  key={tag}
                  className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 flex items-center gap-1"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() =>
                      onChange({ ...value, tags: currentTags.filter((t) => t !== tag) })
                    }
                    className="text-zinc-400 hover:text-zinc-300"
                    aria-label={`Remove tag ${tag}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              <input
                id={`${id}-tags`}
                type="text"
                list={`${id}-tags-list`}
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tagDraft.trim()) {
                    e.preventDefault();
                    const v = tagDraft.trim();
                    if (!currentTags.includes(v)) {
                      onChange({ ...value, tags: [...currentTags, v] });
                    }
                    setTagDraft("");
                  }
                }}
                placeholder={currentTags.length === 0 ? "e.g. S&P 500…" : ""}
                className="flex-1 min-w-[60px] bg-transparent text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none"
              />
            </div>
            {tagSuggestions.length > 0 && (
              <datalist id={`${id}-tags-list`}>
                {tagSuggestions.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            )}
          </div>
        </div>

        {/* ISIN — Advanced cluster */}
        <div className="border border-zinc-800/50 rounded-lg overflow-hidden">
          <button
            type="button"
            aria-expanded={advancedExpanded}
            aria-controls={`${id}-stock-advanced`}
            onClick={() => setAdvancedExpanded((prev) => !prev)}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/30 transition-colors"
          >
            {advancedExpanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            Advanced
            <span className="text-zinc-500">(optional)</span>
          </button>

          {advancedExpanded && (
            <div id={`${id}-stock-advanced`} className="px-3 pb-3 pt-1 border-t border-zinc-800/50">
              <div>
                <label htmlFor={`${id}-isin`} className="block text-xs text-zinc-400 mb-1">
                  ISIN <span className="text-zinc-500">(optional)</span>
                </label>
                <input
                  id={`${id}-isin`}
                  type="text"
                  value={value.isin ?? ""}
                  onChange={(e) => onChange({ ...value, isin: e.target.value })}
                  placeholder="IE00B3RBWM25"
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70 uppercase"
                />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Crypto branch ───────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Multi-chain informational banner */}
      {showMultiChainBanner && (
        <div role="note" className="text-xs text-blue-400 bg-blue-950/30 border border-blue-900/40 rounded px-3 py-2">
          You already hold {picked.ticker} on{" "}
          {existingChainsForSelected.map((c) => c ?? "no chain").join(", ")} —
          this will be tracked as a separate entry.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {/* Chain — combobox (free-text input + datalist) */}
        <div>
          <label htmlFor={`${id}-chain`} className="block text-xs text-zinc-400 mb-1">
            Chain <span className="text-zinc-500">(optional)</span>
          </label>
          <input
            id={`${id}-chain`}
            type="text"
            list={`${id}-chain-list`}
            value={value.chain ?? ""}
            onChange={(e) => onChange({ ...value, chain: e.target.value })}
            placeholder="e.g. Ethereum, Solana, Base…"
            className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
          />
          {chainOptions.length > 0 && (
            <datalist id={`${id}-chain-list`}>
              {chainOptions.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          )}
        </div>

        {/* Subcategory — combobox (free-text input + datalist) */}
        <div>
          <label htmlFor={`${id}-type`} className="block text-xs text-zinc-400 mb-1">
            Type <span className="text-zinc-500">(optional)</span>
          </label>
          <input
            id={`${id}-type`}
            type="text"
            list={`${id}-type-list`}
            value={value.subcategory ?? ""}
            onChange={(e) => onChange({ ...value, subcategory: e.target.value })}
            placeholder="e.g. L1, DeFi…"
            className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
          />
          {(existingSubcategories ?? []).length > 0 && (
            <datalist id={`${id}-type-list`}>
              {[...new Set(existingSubcategories)].sort().map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
        </div>
      </div>

      {/* Advanced disclosure — APY + acquisition method */}
      <div className="border border-zinc-800/50 rounded-lg overflow-hidden">
        <button
          type="button"
          aria-expanded={advancedExpanded}
          aria-controls={`${id}-advanced`}
          onClick={() => setAdvancedExpanded((prev) => !prev)}
          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/30 transition-colors"
        >
          {advancedExpanded ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
          Advanced
          <span className="text-zinc-500">(optional)</span>
        </button>

        {advancedExpanded && (
          <div id={`${id}-advanced`} className="px-3 pb-3 pt-1 border-t border-zinc-800/50">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor={`${id}-acquisition`}
                  className="block text-xs text-zinc-400 mb-1"
                >
                  Acquisition method
                </label>
                <select
                  id={`${id}-acquisition`}
                  value={value.acquisitionMethod ?? ""}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      acquisitionMethod: e.target.value
                        ? (e.target.value as AcquisitionType)
                        : undefined,
                    })
                  }
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                >
                  <option value="">Select…</option>
                  {ACQUISITION_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${id}-apy`} className="block text-xs text-zinc-400 mb-1">
                  APY % <span className="text-zinc-500">(optional)</span>
                </label>
                <input
                  id={`${id}-apy`}
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={value.apy ?? ""}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      apy: e.target.value !== "" ? Number(e.target.value) : undefined,
                    })
                  }
                  placeholder="0"
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
