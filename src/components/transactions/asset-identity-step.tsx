"use client";

import { useState, useId, useMemo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { PickedAsset } from "@/lib/types";
import { ACQUISITION_TYPES } from "@/lib/types";
import type { AcquisitionType } from "@/lib/types";

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
  existingAssets,
  value,
  onChange,
}: AssetIdentityStepProps) {
  const id = useId();
  // The only internal state: whether the Advanced section is expanded.
  const [advancedExpanded, setAdvancedExpanded] = useState(false);

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

  // ─── Stock branch (placeholder — Task 3 fills this in) ──────────────────────

  if (assetClass === "stock") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          Stock identity fields — coming in Task 3.
        </p>
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
