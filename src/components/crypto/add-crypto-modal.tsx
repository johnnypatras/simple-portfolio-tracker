"use client";

import { useState, useEffect, useRef } from "react";
import { Search, Loader2, ChevronDown, ChevronRight, ArrowLeft } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { createCryptoAsset, upsertPosition } from "@/lib/actions/crypto";
import type { CoinGeckoSearchResult, Wallet } from "@/lib/types";
import { ACQUISITION_TYPES } from "@/lib/types";

interface AddCryptoModalProps {
  open: boolean;
  onClose: () => void;
  wallets: Wallet[];
  existingSubcategories: string[];
}

export function AddCryptoModal({ open, onClose, wallets, existingSubcategories }: AddCryptoModalProps) {
  // ─── Search phase state ──────────────────────────────────
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CoinGeckoSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout>(null);

  // ─── Form phase state ────────────────────────────────────
  const [selectedCoin, setSelectedCoin] = useState<CoinGeckoSearchResult | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── Optional initial position state ───────────────────
  const [positionOpen, setPositionOpen] = useState(false);
  const [positionWalletId, setPositionWalletId] = useState("");
  const [positionQuantity, setPositionQuantity] = useState("");
  const [acquisitionType, setAcquisitionType] = useState("bought");

  // ─── Subcategory state ──────────────────────────────────
  const [subcategory, setSubcategory] = useState("");
  const [subcategoryDropdownOpen, setSubcategoryDropdownOpen] = useState(false);

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
      setSelectedCoin(null);
      setError(null);
      setAdding(false);
      setPositionOpen(false);
      setPositionWalletId("");
      setPositionQuantity("");
      setAcquisitionType("bought");
      setSubcategory("");
      setSubcategoryDropdownOpen(false);
    }
  }, [open]);

  // ─── Handle selection: move to form phase ──────────────
  function handleSelect(coin: CoinGeckoSearchResult) {
    setSelectedCoin(coin);
    setError(null);
  }

  // ─── Go back to search ────────────────────────────────
  function handleBackToSearch() {
    setSelectedCoin(null);
    setError(null);
  }

  // ─── Submit form ──────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedCoin) return;

    setError(null);
    setAdding(true);

    try {
      const assetId = await createCryptoAsset({
        ticker: selectedCoin.symbol,
        name: selectedCoin.name,
        coingecko_id: selectedCoin.id,
        subcategory: subcategory.trim() || null,
      });

      // If user filled in an initial position, create it with its acquisition method
      const qty = parseFloat(positionQuantity);
      if (positionWalletId && qty > 0) {
        await upsertPosition({
          crypto_asset_id: assetId,
          wallet_id: positionWalletId,
          quantity: qty,
          acquisition_method: acquisitionType,
        });
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setAdding(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Crypto Asset">
      {/* ═══ PHASE 1: Search ═══ */}
      {!selectedCoin && (
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

          {/* Results */}
          <div className="max-h-72 overflow-y-auto space-y-0.5">
            {results.length === 0 && query.length >= 2 && !searching && (
              <p className="text-sm text-zinc-500 text-center py-4">
                No coins found
              </p>
            )}
            {results.map((coin) => (
              <button
                key={coin.id}
                onClick={() => handleSelect(coin)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-zinc-800/50 transition-colors text-left"
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
                {/* Price */}
                {coin.price_usd != null && coin.price_usd > 0 && (
                  <span className="shrink-0 text-sm tabular-nums text-zinc-400">
                    ${coin.price_usd < 1
                      ? coin.price_usd.toLocaleString("en-US", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 6,
                        })
                      : coin.price_usd.toLocaleString("en-US", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                  </span>
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
      )}

      {/* ═══ PHASE 2: Review & Submit Form ═══ */}
      {selectedCoin && (
        <div>
          {/* Back link */}
          <button
            onClick={handleBackToSearch}
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-4"
          >
            <ArrowLeft className="w-3 h-3" />
            Back to search
          </button>

          {/* Selected coin summary */}
          <div className="bg-zinc-800/30 border border-zinc-800/50 rounded-lg px-3 py-2 mb-4">
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={selectedCoin.thumb}
                alt={selectedCoin.name}
                className="w-6 h-6 rounded-full bg-zinc-800"
              />
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zinc-200">
                  {selectedCoin.name}
                </span>
                <span className="text-xs text-zinc-500 uppercase">
                  {selectedCoin.symbol}
                </span>
              </div>
              {selectedCoin.market_cap_rank && (
                <span className="text-xs text-zinc-600">
                  Rank #{selectedCoin.market_cap_rank}
                </span>
              )}
              {selectedCoin.price_usd != null && selectedCoin.price_usd > 0 && (
                <span className="ml-auto shrink-0 text-sm tabular-nums text-zinc-400">
                  ${selectedCoin.price_usd < 1
                    ? selectedCoin.price_usd.toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 6,
                      })
                    : selectedCoin.price_usd.toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                </span>
              )}
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Subcategory */}
            <div className="relative">
              <label className="block text-xs text-zinc-500 mb-1">
                Subcategory <span className="text-zinc-600">(optional — e.g. L1, Ethereum L2, DeFi, Stablecoin)</span>
              </label>
              <input
                type="text"
                value={subcategory}
                onChange={(e) => {
                  setSubcategory(e.target.value);
                  setSubcategoryDropdownOpen(true);
                }}
                onFocus={() => setSubcategoryDropdownOpen(true)}
                onBlur={() => setTimeout(() => setSubcategoryDropdownOpen(false), 150)}
                placeholder="Type or pick a subcategory..."
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              />
              {subcategoryDropdownOpen && existingSubcategories.length > 0 && (() => {
                const filtered = existingSubcategories.filter(
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
                          setSubcategoryDropdownOpen(false);
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

            {/* Optional: Initial position (with acquisition type) */}
            {wallets.length > 0 && (
              <div className="border border-zinc-800/50 rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => setPositionOpen(!positionOpen)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/30 transition-colors"
                >
                  {positionOpen ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : (
                    <ChevronRight className="w-3 h-3" />
                  )}
                  Add initial position
                  <span className="text-zinc-600">(optional)</span>
                </button>

                {positionOpen && (
                  <div className="px-3 pb-3 pt-1 border-t border-zinc-800/50">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-zinc-500 mb-1">
                          Wallet
                        </label>
                        <select
                          value={positionWalletId}
                          onChange={(e) => setPositionWalletId(e.target.value)}
                          className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                        >
                          <option value="">Select wallet...</option>
                          {wallets.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-zinc-500 mb-1">
                          Quantity
                        </label>
                        <input
                          type="number"
                          value={positionQuantity}
                          onChange={(e) => setPositionQuantity(e.target.value)}
                          placeholder="0"
                          step="any"
                          min="0"
                          className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 tabular-nums"
                        />
                      </div>
                    </div>
                    <div className="mt-3">
                      <label className="block text-xs text-zinc-500 mb-1">
                        How was this acquired?
                      </label>
                      <select
                        value={acquisitionType}
                        onChange={(e) => setAcquisitionType(e.target.value)}
                        className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                      >
                        {ACQUISITION_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            )}

            {error && (
              <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={adding}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {adding && <Loader2 className="w-4 h-4 animate-spin" />}
              Add to Portfolio
            </button>
          </form>
        </div>
      )}
    </Modal>
  );
}
