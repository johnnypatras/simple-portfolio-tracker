"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Image from "next/image";
import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { useSharedView } from "@/components/shared-view-context";
import {
  Search,
  LayoutDashboard,
  Building2,
  Bitcoin,
  TrendingUp,
  Landmark,
  History,
  BookOpen,
  Settings,
  Plus,
  ArrowRightLeft,
  Download,
  Loader2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type { HoldingItem } from "@/lib/types";

// ─── Static data ──────────────────────────────────────────

const DASHBOARD_PAGES = [
  { label: "Dashboard", path: "/dashboard", icon: LayoutDashboard, keywords: ["home", "overview"] },
  { label: "Accounts", path: "/dashboard/accounts", icon: Building2, keywords: ["institutions"] },
  { label: "Crypto", path: "/dashboard/crypto", icon: Bitcoin, keywords: ["bitcoin", "ethereum"] },
  { label: "Equities", path: "/dashboard/stocks", icon: TrendingUp, keywords: ["stocks", "etf", "equity"] },
  { label: "Banks & Deposits", path: "/dashboard/cash", icon: Landmark, keywords: ["cash", "bank", "deposit", "savings"] },
  { label: "History", path: "/dashboard/history", icon: History, keywords: ["activity", "log", "audit"] },
  { label: "Diary", path: "/dashboard/diary", icon: BookOpen, keywords: ["notes", "journal"] },
  { label: "Settings", path: "/dashboard/settings", icon: Settings, keywords: ["preferences", "config"] },
];

const SHARE_PAGES = [
  { label: "Dashboard", pathSuffix: "", icon: LayoutDashboard, keywords: ["home", "overview"] },
  { label: "Crypto", pathSuffix: "/crypto", icon: Bitcoin, keywords: ["bitcoin", "ethereum"] },
  { label: "Equities", pathSuffix: "/stocks", icon: TrendingUp, keywords: ["stocks", "etf", "equity"] },
  { label: "Banks & Deposits", pathSuffix: "/cash", icon: Landmark, keywords: ["cash", "bank", "deposit"] },
];

const ACTIONS = [
  { label: "Add Crypto Asset", path: "/dashboard/crypto", icon: Plus, keywords: ["new", "create", "crypto"] },
  { label: "Add Stock/ETF", path: "/dashboard/stocks", icon: Plus, keywords: ["new", "create", "equity"] },
  { label: "Record Buy (Crypto)", path: "/dashboard/crypto", icon: TrendingUp, keywords: ["buy", "purchase"] },
  { label: "Record Buy (Stock)", path: "/dashboard/stocks", icon: TrendingUp, keywords: ["buy", "purchase"] },
  { label: "Transfer", path: "/dashboard", icon: ArrowRightLeft, keywords: ["move", "sell", "buy"] },
  { label: "Export Data", path: "/dashboard/settings", icon: Download, keywords: ["export", "backup", "csv", "json"] },
];

// ─── Formatting helpers ───────────────────────────────────

const _valueFmtCache = new Map<string, Intl.NumberFormat>();
function formatValue(value: number, currency: string): string {
  let fmt = _valueFmtCache.get(currency);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    _valueFmtCache.set(currency, fmt);
  }
  return fmt.format(value);
}

function formatChange(change?: number): string | null {
  if (change === undefined || change === null) return null;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(1)}%`;
}

function formatQuantity(qty: number): string {
  if (qty >= 1) return qty.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return qty.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

const _priceFmtCache = new Map<string, Intl.NumberFormat>();
function formatPrice(value: number, currency: string): string {
  // Cache key includes the decimal tier because max fraction digits depends on value magnitude
  const key = `${currency}:${value < 1 ? 6 : 2}`;
  let fmt = _priceFmtCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: value < 1 ? 6 : 2,
    });
    _priceFmtCache.set(key, fmt);
  }
  return fmt.format(value);
}

// ─── External search hook ─────────────────────────────────

interface ExternalResult {
  id: string;
  name: string;
  ticker: string;
  price?: number;
  icon?: string;
  type: "crypto" | "stock";
  detailPath: string;
}

function useExternalSearch(query: string, enabled: boolean) {
  const [results, setResults] = useState<ExternalResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || query.length < 3 || query.length > 100) {
      setResults([]);
      return;
    }

    setLoading(true);
    const timeout = setTimeout(async () => {
      try {
        const [cryptoRes, stockRes] = await Promise.all([
          fetch(`/api/crypto/search?q=${encodeURIComponent(query)}`).then((r) => r.json()),
          fetch(`/api/stocks/search?q=${encodeURIComponent(query)}`).then((r) => r.json()),
        ]);

        const mapped: ExternalResult[] = [
          ...cryptoRes.slice(0, 5).map((c: Record<string, unknown>) => ({
            id: c.id as string,
            name: c.name as string,
            ticker: ((c.symbol as string) ?? "").toUpperCase(),
            price: c.price_usd as number | undefined,
            icon: c.thumb as string | undefined,
            type: "crypto" as const,
            detailPath: "/dashboard/crypto",
          })),
          ...stockRes.slice(0, 5).map((s: Record<string, unknown>) => ({
            id: s.symbol as string,
            name: (s.shortname || s.longname || s.symbol) as string,
            ticker: s.symbol as string,
            price: s.price as number | undefined,
            icon: undefined,
            type: "stock" as const,
            detailPath: "/dashboard/stocks",
          })),
        ];
        setResults(mapped);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 500);

    return () => clearTimeout(timeout);
  }, [query, enabled]);

  return { results, loading };
}

// ─── Palette component ────────────────────────────────────

interface CommandPaletteProps {
  holdings: HoldingItem[];
  primaryCurrency: string;
  onClose: () => void;
}

export function CommandPalette({
  holdings,
  primaryCurrency,
  onClose,
}: CommandPaletteProps) {
  const router = useRouter();
  const { isReadOnly, shareToken } = useSharedView();
  const overlayRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");

  const [previewId, setPreviewId] = useState<string | null>(null);

  const { results: externalResults, loading: externalLoading } =
    useExternalSearch(search, !isReadOnly);

  // Build set of owned tickers for "Owned" badge on external results
  const ownedTickers = useMemo(() => {
    const set = new Set<string>();
    for (const h of holdings) {
      if (h.ticker) set.add(h.ticker.toUpperCase());
    }
    return set;
  }, [holdings]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const go = useCallback(
    (path: string) => {
      router.push(path);
      onClose();
    },
    [router, onClose],
  );

  // Build pages list based on context
  const pages = isReadOnly
    ? SHARE_PAGES.map((p) => ({
        ...p,
        path: `/share/${shareToken}${p.pathSuffix}`,
      }))
    : DASHBOARD_PAGES;

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="max-w-[640px] mx-auto mt-[15vh] sm:mt-[20vh] px-4">
        <Command
          className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden"
          loop
          filter={(value, search, keywords) => {
            if (!search) return 1;
            const s = search.toLowerCase();
            if (value.toLowerCase().includes(s)) return 1;
            if (keywords?.some((k) => k.toLowerCase().includes(s))) return 1;
            return 0;
          }}
        >
          {/* Input bar */}
          <div className="flex items-center gap-2 px-4 border-b border-zinc-800/50">
            <Search className="w-4 h-4 text-zinc-400 shrink-0" />
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder="Search holdings, pages, actions..."
              className="w-full py-3 bg-transparent text-base sm:text-sm text-zinc-100 placeholder:text-zinc-400 outline-none"
              autoFocus
            />
            <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-zinc-800 text-[10px] text-zinc-400 font-mono shrink-0 border border-zinc-700/50">
              ⌘K
            </kbd>
          </div>

          {/* Results list */}
          <Command.List className="max-h-[min(340px,60vh)] overflow-y-auto p-2">
            <Command.Empty className="py-6 text-center text-sm text-zinc-400">
              No results found.
            </Command.Empty>

            {/* ── Your Holdings ── */}
            {holdings.length > 0 && (
              <Command.Group heading="Your Holdings">
                {holdings.map((h) => {
                  const itemKey = `${h.type}-${h.id}`;
                  const isExpanded = previewId === itemKey;
                  const hasDetail = h.quantity !== undefined && h.pricePerUnit !== undefined;
                  return (
                    <Command.Item
                      key={itemKey}
                      value={`${h.name} ${h.ticker ?? ""}`}
                      onSelect={() => go(h.detailPath)}
                      className="flex flex-col px-3 py-2 rounded-lg text-sm cursor-pointer data-[selected=true]:bg-zinc-800 text-zinc-300 data-[selected=true]:text-zinc-100"
                    >
                      <div className="flex items-center gap-3 w-full">
                        {h.icon ? (
                          <Image
                            src={h.icon}
                            alt=""
                            width={20}
                            height={20}

                            className="w-5 h-5 rounded-full shrink-0"
                          />
                        ) : (
                          <div className="w-5 h-5 rounded-full bg-zinc-800 shrink-0 flex items-center justify-center text-[10px] text-zinc-400 font-medium">
                            {(h.ticker ?? h.name)[0]}
                          </div>
                        )}
                        <div className="flex-1 min-w-0 truncate">
                          <span>{h.name}</span>
                          {h.ticker && (
                            <span className="ml-1.5 text-xs text-zinc-400">
                              {h.ticker}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <div className="text-right tabular-nums">
                            <span className="text-xs text-zinc-400">
                              {formatValue(h.value, primaryCurrency)}
                            </span>
                            {formatChange(h.change24h) && (
                              <span
                                className={`ml-1.5 text-[10px] ${
                                  (h.change24h ?? 0) >= 0
                                    ? "text-emerald-400"
                                    : "text-red-400"
                                }`}
                              >
                                {formatChange(h.change24h)}
                              </span>
                            )}
                          </div>
                          {hasDetail && (
                            <button
                              type="button"
                              aria-label={isExpanded ? "Hide details" : "Show details"}
                              className="p-0.5 rounded hover:bg-zinc-700/50 text-zinc-400 hover:text-zinc-300 transition-colors"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setPreviewId(isExpanded ? null : itemKey);
                              }}
                            >
                              {isExpanded ? (
                                <ChevronUp className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                      {isExpanded && hasDetail && (
                        <div
                          className="mt-1.5 ml-8 text-[11px] text-zinc-400 space-y-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex justify-between">
                            <span>Quantity</span>
                            <span className="tabular-nums">{formatQuantity(h.quantity ?? 0)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>Price</span>
                            <span className="tabular-nums">{formatPrice(h.pricePerUnit ?? 0, primaryCurrency)}</span>
                          </div>
                          <div className="flex justify-between border-t border-zinc-800/50 pt-0.5">
                            <span className="text-zinc-400">Total</span>
                            <span className="tabular-nums text-zinc-400">{formatValue((h.quantity ?? 0) * (h.pricePerUnit ?? 0), primaryCurrency)}</span>
                          </div>
                        </div>
                      )}
                    </Command.Item>
                  );
                })}
              </Command.Group>
            )}

            {/* ── Pages ── */}
            <Command.Group heading="Pages">
              {pages.map((p) => {
                const Icon = p.icon;
                return (
                  <Command.Item
                    key={p.path}
                    value={p.label}
                    keywords={p.keywords}
                    onSelect={() => go(p.path)}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm cursor-pointer data-[selected=true]:bg-zinc-800 text-zinc-300 data-[selected=true]:text-zinc-100"
                  >
                    <Icon className="w-4 h-4 text-zinc-400 shrink-0" />
                    <span>{p.label}</span>
                  </Command.Item>
                );
              })}
            </Command.Group>

            {/* ── Actions (dashboard only) ── */}
            {!isReadOnly && (
              <Command.Group heading="Actions">
                {ACTIONS.map((a) => {
                  const Icon = a.icon;
                  return (
                    <Command.Item
                      key={a.label}
                      value={a.label}
                      keywords={a.keywords}
                      onSelect={() => go(a.path)}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm cursor-pointer data-[selected=true]:bg-zinc-800 text-zinc-300 data-[selected=true]:text-zinc-100"
                    >
                      <Icon className="w-4 h-4 text-zinc-400 shrink-0" />
                      <span>{a.label}</span>
                    </Command.Item>
                  );
                })}
              </Command.Group>
            )}

            {/* ── Add New Asset (external search, dashboard only) ── */}
            {!isReadOnly && search.length >= 3 && (
              <>
                {externalLoading && (
                  <div className="flex items-center justify-center gap-2 py-3 text-xs text-zinc-400">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Searching...
                  </div>
                )}
                {externalResults.length > 0 && (
                  <Command.Group heading="Add New Asset" forceMount>
                    {externalResults.map((r) => {
                      const isOwned = ownedTickers.has(r.ticker.toUpperCase());
                      return (
                        <Command.Item
                          key={`ext-${r.type}-${r.id}`}
                          value={`${r.name} ${r.ticker}`}
                          onSelect={() => go(r.detailPath)}
                          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm cursor-pointer data-[selected=true]:bg-zinc-800 text-zinc-300 data-[selected=true]:text-zinc-100"
                          forceMount
                        >
                          {r.icon ? (
                            <Image
                              src={r.icon}
                              alt=""
                              width={20}
                              height={20}
                              className="w-5 h-5 rounded-full shrink-0"
                            />
                          ) : (
                            <div className="w-5 h-5 rounded-full bg-zinc-800 shrink-0 flex items-center justify-center text-[10px] text-zinc-400 font-medium">
                              {r.ticker[0]}
                            </div>
                          )}
                          <div className="flex-1 min-w-0 truncate">
                            <span>{r.name}</span>
                            <span className="ml-1.5 text-xs text-zinc-400">
                              {r.ticker}
                            </span>
                            {isOwned && (
                              <span className="ml-1.5 text-[10px] text-teal-400 font-medium">
                                Owned
                              </span>
                            )}
                          </div>
                          {r.price !== undefined && (
                            <span className="text-xs text-zinc-400 tabular-nums shrink-0">
                              {formatPrice(r.price, "USD")}
                            </span>
                          )}
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                )}
              </>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
