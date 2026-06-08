"use client";

import { useState, useEffect, useRef } from "react";
import type { YahooSearchResult, CoinGeckoSearchResult } from "@/lib/types";

/** A single raw search result — kept raw (not flattened) so the caller can build a
 *  newCryptoAsset/newStockAsset spec from its full fields. */
export type AssetSearchResult = YahooSearchResult | CoinGeckoSearchResult;

/**
 * Debounced, class-scoped asset search for the toolbar-Buy picker. Mirrors the
 * transfer-dialog buy-mode search (transfer-dialog.tsx): 350ms debounce, one
 * endpoint per class (the toolbar fixes the class — no type tabs), raw result
 * shape. Queries under 2 chars are ignored. A pending request is cancelled when the
 * query/class changes (the `cancelled` flag guards stale setState — a bug the
 * original transfer-dialog search lacked).
 */
export function useAssetSearch(
  assetClass: "crypto" | "stock",
  query: string,
): { results: AssetSearchResult[]; loading: boolean } {
  const [results, setResults] = useState<AssetSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const endpoint =
          assetClass === "stock"
            ? `/api/stocks/search?q=${encodeURIComponent(query)}`
            : `/api/crypto/search?q=${encodeURIComponent(query)}`;
        const res = await fetch(endpoint);
        if (!res.ok) {
          if (!cancelled) setResults([]);
          return;
        }
        const data = (await res.json()) as AssetSearchResult[];
        if (!cancelled) setResults(data);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, assetClass]);

  return { results, loading };
}
