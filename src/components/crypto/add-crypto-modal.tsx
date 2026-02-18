"use client";

import { useState, useEffect, useRef } from "react";
import { Search, Plus, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { createCryptoAsset } from "@/lib/actions/crypto";
import type { CoinGeckoSearchResult } from "@/lib/types";

interface AddCryptoModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddCryptoModal({ open, onClose }: AddCryptoModalProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CoinGeckoSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<NodeJS.Timeout>(null);

  // Debounced search
  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      return;
    }

    setSearching(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/crypto/search?q=${encodeURIComponent(query)}`
        );
        const data = await res.json();
        setResults(data);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setError(null);
      setAdding(null);
    }
  }, [open]);

  async function handleAdd(coin: CoinGeckoSearchResult) {
    setError(null);
    setAdding(coin.id);

    try {
      await createCryptoAsset({
        ticker: coin.symbol,
        name: coin.name,
        coingecko_id: coin.id,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setAdding(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Crypto Asset">
      <div className="space-y-3">
        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search coins (e.g. Bitcoin, ETH, SOL...)"
            className="w-full pl-10 pr-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            autoFocus
          />
          {searching && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 animate-spin" />
          )}
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {error}
          </p>
        )}

        {/* Results */}
        <div className="max-h-64 overflow-y-auto space-y-1">
          {results.length === 0 && query.length >= 2 && !searching && (
            <p className="text-sm text-zinc-500 text-center py-4">
              No coins found
            </p>
          )}
          {results.map((coin) => (
            <button
              key={coin.id}
              onClick={() => handleAdd(coin)}
              disabled={adding !== null}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-zinc-800/50 transition-colors text-left disabled:opacity-50"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={coin.thumb}
                alt={coin.name}
                className="w-6 h-6 rounded-full bg-zinc-800"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-200 truncate">
                    {coin.name}
                  </span>
                  <span className="text-xs text-zinc-500 uppercase">
                    {coin.symbol}
                  </span>
                </div>
                {coin.market_cap_rank && (
                  <span className="text-xs text-zinc-600">
                    Rank #{coin.market_cap_rank}
                  </span>
                )}
              </div>
              {adding === coin.id ? (
                <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
              ) : (
                <Plus className="w-4 h-4 text-zinc-600 shrink-0" />
              )}
            </button>
          ))}
        </div>

        {query.length < 2 && (
          <p className="text-xs text-zinc-600 text-center">
            Type at least 2 characters to search
          </p>
        )}
      </div>
    </Modal>
  );
}
