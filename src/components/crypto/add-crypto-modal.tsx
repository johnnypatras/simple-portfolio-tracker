"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { Search, Loader2, ChevronDown, ChevronRight, ArrowLeft } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import { createCryptoAsset, upsertPosition } from "@/lib/actions/crypto";
import type { CoinGeckoSearchResult, Wallet } from "@/lib/types";
import { ACQUISITION_TYPES, parseWalletChains, getWalletChainTokens } from "@/lib/types";

interface AddCryptoModalProps {
  open: boolean;
  onClose: () => void;
  wallets: Wallet[];
  existingSubcategories: string[];
  existingChains: string[];
}

export function AddCryptoModal({ open, onClose, wallets, existingSubcategories, existingChains }: AddCryptoModalProps) {
  // ─── Search phase state ──────────────────────────────────
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CoinGeckoSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout>(null);

  // ─── Form phase state ────────────────────────────────────
  const [selectedCoin, setSelectedCoin] = useState<CoinGeckoSearchResult | null>(null);
  const [adding, setAdding] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── Chain + subcategory state ────────────────────────────
  const [chain, setChain] = useState("");
  const [availableChains, setAvailableChains] = useState<string[]>([]);
  const [subcategory, setSubcategory] = useState("");
  const [subcategoryDropdownOpen, setSubcategoryDropdownOpen] = useState(false);

  // ─── Optional initial position state ───────────────────
  const [positionOpen, setPositionOpen] = useState(false);
  const [positionWalletId, setPositionWalletId] = useState("");
  const [positionQuantity, setPositionQuantity] = useState("");
  const [acquisitionType, setAcquisitionType] = useState("bought");
  const [positionApy, setPositionApy] = useState("");
  const [showAllWallets, setShowAllWallets] = useState(false);

  // Filter wallets by chain compatibility
  const chainFilteredWallets = useMemo(() => {
    if (!chain) return wallets;
    return wallets.filter((w) => {
      // Wallets with no chain set (multi-chain / exchange) are always compatible
      if (!w.chain) return true;
      // Check if any of the wallet's chains match the selected chain
      return parseWalletChains(w.chain).includes(chain);
    });
  }, [wallets, chain]);

  // If user toggled "show all" or no chain-compatible wallets exist, show everything
  const compatibleWallets = showAllWallets || chainFilteredWallets.length === 0
    ? wallets
    : chainFilteredWallets;

  // Reset wallet selection when chain changes and selected wallet is incompatible
  useEffect(() => {
    if (positionWalletId && !compatibleWallets.find((w) => w.id === positionWalletId)) {
      setPositionWalletId("");
    }
  }, [compatibleWallets, positionWalletId]);

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
      setDetecting(false);
      setChain("");
      setAvailableChains([]);
      setSubcategory("");
      setSubcategoryDropdownOpen(false);
      setPositionOpen(false);
      setPositionWalletId("");
      setPositionQuantity("");
      setAcquisitionType("bought");
      setPositionApy("");
      setShowAllWallets(false);
    }
  }, [open]);

  // ─── Handle selection: move to form phase + fetch detail ──
  async function handleSelect(coin: CoinGeckoSearchResult) {
    setSelectedCoin(coin);
    setError(null);
    setChain("");
    setAvailableChains([]);
    setSubcategory("");

    // Fetch chain + subcategory + available chains from CoinGecko detail API
    setDetecting(true);
    try {
      const res = await fetch(`/api/crypto/detail?id=${encodeURIComponent(coin.id)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.chain) setChain(data.chain);
        if (data.subcategory) setSubcategory(data.subcategory);
        if (Array.isArray(data.availableChains)) setAvailableChains(data.availableChains);
      }
    } catch {
      // Detection failed silently — user can fill manually
    } finally {
      setDetecting(false);
    }
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
        chain: chain.trim() || null,
        subcategory: subcategory.trim() || null,
        image_url: selectedCoin.thumb || null,
      });

      // If user filled in an initial position, create it with its acquisition method
      const qty = parseFloat(positionQuantity);
      if (positionWalletId && qty > 0) {
        const apyVal = parseFloat(positionApy);
        await upsertPosition({
          crypto_asset_id: assetId,
          wallet_id: positionWalletId,
          quantity: qty,
          acquisition_method: acquisitionType,
          apy: apyVal > 0 ? apyVal : undefined,
        });
      }

      onClose();
      toast.success(`${selectedCoin.name} added to portfolio`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setAdding(false);
    }
  }

  // Build combined chain options: availableChains from API + existingChains from portfolio
  const chainOptions = useMemo(() => {
    const set = new Set(availableChains);
    // Also include existing chains from the portfolio for consistency
    for (const c of existingChains) set.add(c);
    return [...set].sort();
  }, [availableChains, existingChains]);

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

          {detecting && (
            <div className="flex items-center gap-2 text-xs text-zinc-500 mb-3">
              <Loader2 className="w-3 h-3 animate-spin" />
              Detecting chain &amp; category…
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Chain + Type row — hide chain when selected wallet is an exchange */}
            {(() => {
              const selectedWallet = wallets.find((w) => w.id === positionWalletId);
              const isExchange = selectedWallet?.wallet_type === "custodial";
              return (
            <div className={`grid gap-3 ${isExchange ? "grid-cols-1" : "grid-cols-2"}`}>
              {/* Chain — dropdown from available platforms (hidden for exchanges) */}
              {!isExchange && (
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Chain <span className="text-zinc-600">(optional)</span>
                </label>
                {chainOptions.length > 0 ? (
                  <select
                    value={chain}
                    onChange={(e) => setChain(e.target.value)}
                    className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                  >
                    <option value="">Select chain...</option>
                    {chainOptions.map((c) => (
                      <option key={c} value={c}>
                        {c}{availableChains.includes(c) && !existingChains.includes(c) ? "" : availableChains.includes(c) ? "" : " (other)"}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={chain}
                    onChange={(e) => setChain(e.target.value)}
                    placeholder="e.g. Ethereum, Solana..."
                    className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                  />
                )}
              </div>
              )}

              {/* Type */}
              <div className="relative">
                <label className="block text-xs text-zinc-500 mb-1">
                  Type <span className="text-zinc-600">(optional)</span>
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
                  placeholder="e.g. L1, DeFi..."
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
            </div>
              );
            })()}

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
                          Wallet / Exchange
                        </label>
                        <select
                          value={positionWalletId}
                          onChange={(e) => setPositionWalletId(e.target.value)}
                          className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                        >
                          <option value="">Select...</option>
                          {compatibleWallets.map((w) => {
                            const tokens = getWalletChainTokens(w.chain);
                            const label = tokens.map((t) => t.toLowerCase() === "evm" ? "EVM" : t).join(", ");
                            return (
                              <option key={w.id} value={w.id}>
                                {w.name}{label ? ` (${label})` : ""}
                              </option>
                            );
                          })}
                        </select>
                        {chain && chainFilteredWallets.length === 0 && (
                          <p className="text-xs text-zinc-500 mt-1">
                            No {chain}-specific wallets — showing all
                          </p>
                        )}
                        {chain && !showAllWallets && chainFilteredWallets.length > 0 && chainFilteredWallets.length < wallets.length && (
                          <p className="text-xs text-zinc-600 mt-1">
                            Showing {chain}-compatible only{" "}
                            <button
                              type="button"
                              onClick={() => setShowAllWallets(true)}
                              className="text-blue-400 hover:text-blue-300 underline"
                            >
                              show all
                            </button>
                          </p>
                        )}
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
                    <div className="grid grid-cols-2 gap-3 mt-3">
                      <div>
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
                      <div>
                        <label className="block text-xs text-zinc-500 mb-1">
                          APY % <span className="text-zinc-600">(optional)</span>
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          value={positionApy}
                          onChange={(e) => setPositionApy(e.target.value)}
                          placeholder="0"
                          className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                        />
                      </div>
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
