"use client";

import { useState, useEffect, useRef } from "react";
import { Search, Loader2, ArrowLeft, ChevronDown, ChevronRight, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { createStockAsset, upsertStockPosition } from "@/lib/actions/stocks";
import type {
  AssetCategory,
  YahooSearchResult,
  Broker,
} from "@/lib/types";

interface AddStockModalProps {
  open: boolean;
  onClose: () => void;
  brokers: Broker[];
  existingSubcategories: string[];
  existingTags: string[];
}

const TYPES: { value: AssetCategory; label: string }[] = [
  { value: "individual_stock", label: "Individual Stock" },
  { value: "etf", label: "ETF" },
  { value: "bond_fixed_income", label: "Bond / Fixed Income" },
  { value: "other", label: "Other" },
];

/** Strip the exchange suffix from a Yahoo symbol: VWCE.DE → VWCE */
function extractBaseTicker(yahooSymbol: string): string {
  const dot = yahooSymbol.indexOf(".");
  return dot > 0 ? yahooSymbol.slice(0, dot) : yahooSymbol;
}

/** Infer type from Yahoo's quoteType */
function inferCategory(quoteType: string): AssetCategory {
  if (quoteType === "ETF") return "etf";
  if (quoteType === "EQUITY") return "individual_stock";
  return "other";
}

/** Infer subtype (regulatory wrapper only) from Yahoo name */
function inferSubcategory(quoteType: string, name: string): string {
  if (quoteType !== "ETF") return "";
  return name.toUpperCase().includes("UCITS") ? "UCITS" : "Non-UCITS";
}

/** Infer tags (theme + behavior) from Yahoo name */
function inferTags(_quoteType: string, name: string): string[] {
  const tags: string[] = [];
  // Theme / index tags (first)
  if (/S&P\s*500|S&P500/i.test(name)) tags.push("S&P 500");
  if (/ALL.?WORLD|FTSE\s*ALL/i.test(name)) tags.push("World");
  if (/NASDAQ|QQQ/i.test(name)) tags.push("Nasdaq");
  if (/EURO\s*STOXX|EUROSTOXX/i.test(name)) tags.push("Euro Stoxx");
  if (/BOND|TREASURY|FIXED.?INCOME|AGGREGATE/i.test(name)) tags.push("Bonds");
  // Behavior tags (after theme)
  if (/ACCUMULAT/i.test(name)) tags.push("Accumulating");
  if (/DISTRIBUT/i.test(name)) tags.push("Distributing");
  return tags;
}

/** Seeded subtype suggestions per asset type */
const SEEDED_SUBTYPES: Record<AssetCategory, string[]> = {
  etf: ["UCITS", "Non-UCITS"],
  bond_fixed_income: ["Government", "Corporate"],
  individual_stock: [],
  other: [],
};

export function AddStockModal({ open, onClose, brokers, existingSubcategories, existingTags }: AddStockModalProps) {
  // ─── Search phase state ──────────────────────────────────
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<YahooSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout>(null);

  // ─── Form phase state ────────────────────────────────────
  const [selected, setSelected] = useState<YahooSearchResult | null>(null);
  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("");
  const [isin, setIsin] = useState("");
  const [yahooTicker, setYahooTicker] = useState("");
  const [category, setCategory] = useState<AssetCategory>("individual_stock");
  const [currency, setCurrency] = useState("USD");
  const [subcategory, setSubcategory] = useState("");
  const [subcategoryOpen, setSubcategoryOpen] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tagsOpen, setTagsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── Optional initial position state ───────────────────
  const [positionOpen, setPositionOpen] = useState(false);
  const [positionBrokerId, setPositionBrokerId] = useState("");
  const [positionQuantity, setPositionQuantity] = useState("");

  // ─── Debounced search ────────────────────────────────────
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
          `/api/stocks/search?q=${encodeURIComponent(query)}`
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

  // ─── Reset on close ──────────────────────────────────────
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setSelected(null);
      setTicker("");
      setName("");
      setIsin("");
      setYahooTicker("");
      setCategory("individual_stock");
      setCurrency("USD");
      setSubcategory("");
      setSubcategoryOpen(false);
      setTags([]);
      setTagInput("");
      setTagsOpen(false);
      setError(null);
      setLoading(false);
      setPositionOpen(false);
      setPositionBrokerId("");
      setPositionQuantity("");
    }
  }, [open]);

  // ─── Handle selection: auto-fill form ────────────────────
  function handleSelect(result: YahooSearchResult) {
    setSelected(result);
    const fullName = result.longname || result.shortname;
    setTicker(extractBaseTicker(result.symbol));
    setName(fullName);
    setYahooTicker(result.symbol);
    setCategory(inferCategory(result.quoteType));
    setSubcategory(inferSubcategory(result.quoteType, fullName));
    setTags(inferTags(result.quoteType, fullName));
    setCurrency(result.currency ?? "USD");
    setIsin(""); // Yahoo doesn't provide ISIN — user fills manually
    setError(null);
  }

  // ─── Go back to search ──────────────────────────────────
  function handleBackToSearch() {
    setSelected(null);
    setError(null);
  }

  // ─── Submit form ─────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ticker.trim() || !name.trim()) return;

    setError(null);
    setLoading(true);

    try {
      const assetId = await createStockAsset({
        ticker: ticker.trim(),
        name: name.trim(),
        isin: isin.trim() || null,
        yahoo_ticker: yahooTicker.trim() || null,
        category,
        tags,
        currency,
        subcategory: subcategory.trim() || null,
      });

      // If user filled in an initial position, create it too
      const qty = parseFloat(positionQuantity);
      if (positionBrokerId && qty > 0) {
        await upsertStockPosition({
          stock_asset_id: assetId,
          broker_id: positionBrokerId,
          quantity: qty,
        });
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Stock / ETF">
      {/* ═══ PHASE 1: Search ═══ */}
      {!selected && (
        <div className="space-y-3">
          {/* Search input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search stocks & ETFs (e.g. AAPL, VWCE, S&P 500...)"
              className="w-full pl-10 pr-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              autoFocus
            />
            {searching && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 animate-spin" />
            )}
          </div>

          {/* Results dropdown */}
          <div className="max-h-72 overflow-y-auto space-y-0.5">
            {results.length === 0 && query.length >= 2 && !searching && (
              <p className="text-sm text-zinc-500 text-center py-4">
                No stocks or ETFs found
              </p>
            )}
            {results.map((result) => (
              <button
                key={result.symbol}
                onClick={() => handleSelect(result)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-zinc-800/50 transition-colors text-left"
              >
                {/* Type badge */}
                <span
                  className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${
                    result.quoteType === "ETF"
                      ? "bg-purple-500/20 text-purple-400"
                      : "bg-blue-500/20 text-blue-400"
                  }`}
                >
                  {result.quoteType}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200 uppercase">
                      {result.symbol}
                    </span>
                    <span className="text-xs text-zinc-500 truncate">
                      {result.longname || result.shortname}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-zinc-600">
                      {result.exchDisp}
                    </span>
                    {result.currency && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                        {result.currency}
                      </span>
                    )}
                  </div>
                </div>
                {/* Price */}
                {result.price != null && result.price > 0 && (
                  <span className="shrink-0 text-sm tabular-nums text-zinc-400">
                    {result.currency === "EUR" ? "€" : result.currency === "GBP" ? "£" : "$"}
                    {result.price.toLocaleString("en-US", {
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
      {selected && (
        <div>
          {/* Back link */}
          <button
            onClick={handleBackToSearch}
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-4"
          >
            <ArrowLeft className="w-3 h-3" />
            Back to search
          </button>

          {/* Selected asset summary */}
          <div className="bg-zinc-800/30 border border-zinc-800/50 rounded-lg px-3 py-2 mb-4">
            <div className="flex items-center gap-2">
              <span
                className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                  selected.quoteType === "ETF"
                    ? "bg-purple-500/20 text-purple-400"
                    : "bg-blue-500/20 text-blue-400"
                }`}
              >
                {selected.quoteType}
              </span>
              <span className="text-sm font-medium text-zinc-200">
                {selected.symbol}
              </span>
              <span className="text-xs text-zinc-500">
                {selected.exchDisp}
              </span>
              {selected.currency && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                  {selected.currency}
                </span>
              )}
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Ticker + Name row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Ticker *
                </label>
                <input
                  type="text"
                  value={ticker}
                  onChange={(e) => setTicker(e.target.value)}
                  placeholder="AAPL"
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 uppercase"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Name *
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Apple Inc."
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                />
              </div>
            </div>

            {/* Yahoo Ticker + ISIN row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Yahoo Ticker
                </label>
                <input
                  type="text"
                  value={yahooTicker}
                  onChange={(e) => setYahooTicker(e.target.value)}
                  placeholder="VWCE.DE"
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 uppercase"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  ISIN{" "}
                  <span className="text-zinc-600">(optional)</span>
                </label>
                <input
                  type="text"
                  value={isin}
                  onChange={(e) => setIsin(e.target.value)}
                  placeholder="IE00B3RBWM25"
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 uppercase"
                />
              </div>
            </div>

            {/* Type + Currency row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Type
                </label>
                <select
                  value={category}
                  onChange={(e) =>
                    setCategory(e.target.value as AssetCategory)
                  }
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  {TYPES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Currency
                </label>
                <input
                  type="text"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  placeholder="USD"
                  maxLength={3}
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 uppercase"
                />
              </div>
            </div>

            {/* Subtype + Tags row */}
            <div className="grid grid-cols-2 gap-3">
              {/* Subtype (autocomplete with seeded suggestions) */}
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

              {/* Tags (chip input with autocomplete) */}
              <div className="relative">
                <label className="block text-xs text-zinc-500 mb-1">
                  Tags
                </label>
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
            </div>

            {/* ─── Optional: Initial Position ─────────────────── */}
            {brokers.length > 0 && (
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
                          Broker
                        </label>
                        <select
                          value={positionBrokerId}
                          onChange={(e) => setPositionBrokerId(e.target.value)}
                          className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
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
                        <label className="block text-xs text-zinc-500 mb-1">
                          Shares
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
              disabled={loading || !ticker.trim() || !name.trim()}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              Add to Portfolio
            </button>
          </form>
        </div>
      )}
    </Modal>
  );
}
