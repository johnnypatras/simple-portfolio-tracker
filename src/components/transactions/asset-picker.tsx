"use client";

import { useState } from "react";
import { Search, Loader2 } from "lucide-react";
import { useAssetSearch, type AssetSearchResult } from "@/lib/hooks/use-asset-search";
import type { PickedAsset } from "@/lib/types";

function resultName(r: AssetSearchResult): string {
  return "shortname" in r ? r.shortname : r.name;
}

interface AssetPickerProps {
  assetClass: "crypto" | "stock";
  /** Uppercased tickers already in the portfolio → drives the "Owned" badge. */
  ownedTickers: Set<string>;
  onPick: (picked: PickedAsset) => void;
}

/**
 * The search step of the toolbar-Buy picker. Class-scoped (the toolbar fixes the
 * class — no type tabs). Renders a search box + a results list; clicking a result
 * emits a PickedAsset (raw result + display ticker/name) to the parent.
 * Presentational — owns only the query string; search lives in useAssetSearch.
 */
export function AssetPicker({ assetClass, ownedTickers, onPick }: AssetPickerProps) {
  const [query, setQuery] = useState("");
  const { results, loading } = useAssetSearch(assetClass, query);

  return (
    <div>
      <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5">
        <Search className="w-3.5 h-3.5 text-zinc-400 mr-2 flex-shrink-0" aria-hidden="true" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={assetClass === "stock" ? "Search stocks or ETFs" : "Search crypto"}
          placeholder={assetClass === "stock" ? "Search stocks or ETFs…" : "Search crypto…"}
          className="flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          autoFocus
        />
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" aria-hidden="true" />}
      </div>

      {/* Announce result arrival to screen readers (the list itself is silent). */}
      <span className="sr-only" aria-live="polite">
        {results.length > 0 ? `${results.length} results` : ""}
      </span>

      {results.length > 0 && (
        <ul className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 divide-y divide-zinc-800/60">
          {results.map((r) => {
            const ticker = r.symbol.toUpperCase();
            const isOwned = ownedTickers.has(ticker);
            return (
              <li key={"id" in r ? r.id : r.symbol}>
                <button
                  type="button"
                  onClick={() => onPick({ assetClass, ticker, name: resultName(r), raw: r })}
                  className="w-full text-left px-3 py-2 hover:bg-zinc-800/60 focus:bg-zinc-800/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 transition-colors"
                >
                  <span className="text-sm text-zinc-100">{ticker}</span>
                  <span className="text-xs text-zinc-400 ml-2">{resultName(r)}</span>
                  {"exchDisp" in r && (
                    <span className="text-xs text-zinc-400 ml-1">({r.exchDisp})</span>
                  )}
                  {isOwned && (
                    <span className="ml-1.5 text-[10px] text-teal-400 font-medium">Owned</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
