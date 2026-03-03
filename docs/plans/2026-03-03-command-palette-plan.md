# Command Palette (Cmd+K) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a global Cmd+K command palette for instant search across portfolio holdings, page navigation, app actions, and external asset discovery.

**Architecture:** Provider + palette two-file architecture. `CommandPaletteProvider` wraps dashboard and share layouts, managing open/close state and storing portfolio holdings pushed up by pages via `RegisterHoldings`. `CommandPalette` receives data as props (no circular imports), renders a fixed overlay with `cmdk` for keyboard nav and filtering. External search debounces to existing `/api/crypto/search` + `/api/stocks/search` routes.

**Tech Stack:** `cmdk` (~3KB), React context, Next.js App Router, Lucide icons, existing CoinGecko/Yahoo search APIs.

**Design doc:** `docs/plans/2026-03-03-command-palette-design.md`

---

### Task 1: Install cmdk + add HoldingItem type

**Files:**
- Modify: `package.json` (via npm install)
- Modify: `src/lib/types.ts`

**Step 1: Install cmdk**

```bash
npm install cmdk
```

**Step 2: Add HoldingItem type**

Add at end of `src/lib/types.ts` (after the `TransferResult` type):

```ts
// ─── Command Palette ─────────────────────────────────────

/** Flat portfolio item for command palette search. */
export interface HoldingItem {
  id: string;
  type: "crypto" | "stock" | "bank" | "exchange_deposit" | "broker_deposit";
  name: string;
  ticker?: string;
  value: number;
  change24h?: number;
  icon?: string | null;
  detailPath: string;
}
```

**Step 3: Verify**

```bash
npm run build
```

Expected: clean build, no errors.

**Step 4: Commit**

```bash
git add package.json package-lock.json src/lib/types.ts
git commit -m "feat(palette): install cmdk, add HoldingItem type"
```

---

### Task 2: Create CommandPaletteProvider

**Files:**
- Create: `src/components/ui/command-palette-provider.tsx`

**Step 1: Create the provider**

```tsx
"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import type { HoldingItem } from "@/lib/types";
import { CommandPalette } from "./command-palette";

interface CommandPaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  holdings: HoldingItem[];
  setHoldings: (items: HoldingItem[]) => void;
  primaryCurrency: string;
}

const CommandPaletteContext = createContext<CommandPaletteState>({
  open: false,
  setOpen: () => {},
  holdings: [],
  setHoldings: () => {},
  primaryCurrency: "EUR",
});

export function CommandPaletteProvider({
  primaryCurrency,
  children,
}: {
  primaryCurrency: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);

  // Cmd+K / Ctrl+K keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <CommandPaletteContext.Provider
      value={{ open, setOpen, holdings, setHoldings, primaryCurrency }}
    >
      {children}
      {open && (
        <CommandPalette
          holdings={holdings}
          primaryCurrency={primaryCurrency}
          onClose={() => setOpen(false)}
        />
      )}
    </CommandPaletteContext.Provider>
  );
}

export function useCommandPalette() {
  return useContext(CommandPaletteContext);
}

/**
 * Client component rendered by server pages to push holdings into the palette context.
 * Holdings persist in state across page navigations (no cleanup on unmount),
 * so Cmd+K works even on pages that don't render this component (e.g. Settings).
 */
export function RegisterHoldings({ holdings }: { holdings: HoldingItem[] }) {
  const { setHoldings } = useCommandPalette();
  useEffect(() => {
    setHoldings(holdings);
  }, [holdings, setHoldings]);
  return null;
}
```

**Step 2: Verify** — Build will fail because `CommandPalette` doesn't exist yet. That's expected. Move to Task 3.

---

### Task 3: Create CommandPalette — shell with Pages + Actions

**Files:**
- Create: `src/components/ui/command-palette.tsx`

This task creates the full palette component with local groups (Pages, Actions) and styling. Holdings group and external search are added in later tasks.

**Step 1: Create the palette**

```tsx
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
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

function formatValue(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatChange(change?: number): string | null {
  if (change === undefined || change === null) return null;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(1)}%`;
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
    if (!enabled || query.length < 3) {
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

  const { results: externalResults, loading: externalLoading } =
    useExternalSearch(search, !isReadOnly);

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
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="max-w-[640px] mx-auto mt-[15vh] sm:mt-[20vh] px-4">
        <Command
          className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden"
          loop
        >
          {/* Input bar */}
          <div className="flex items-center gap-2 px-4 border-b border-zinc-800/50">
            <Search className="w-4 h-4 text-zinc-500 shrink-0" />
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder="Search holdings, pages, actions..."
              className="w-full py-3 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 outline-none"
              autoFocus
            />
            <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-zinc-800 text-[10px] text-zinc-500 font-mono shrink-0 border border-zinc-700/50">
              ⌘K
            </kbd>
          </div>

          {/* Results list */}
          <Command.List className="max-h-[min(340px,60vh)] overflow-y-auto p-2">
            <Command.Empty className="py-6 text-center text-sm text-zinc-500">
              No results found.
            </Command.Empty>

            {/* ── Your Holdings ── */}
            {holdings.length > 0 && (
              <Command.Group heading="Your Holdings">
                {holdings.map((h) => (
                  <Command.Item
                    key={`${h.type}-${h.id}`}
                    value={`${h.name} ${h.ticker ?? ""}`}
                    onSelect={() => go(h.detailPath)}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm cursor-pointer data-[selected=true]:bg-zinc-800 text-zinc-300 data-[selected=true]:text-zinc-100"
                  >
                    {h.icon ? (
                      <img
                        src={h.icon}
                        alt=""
                        className="w-5 h-5 rounded-full shrink-0"
                      />
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-zinc-800 shrink-0 flex items-center justify-center text-[10px] text-zinc-500 font-medium">
                        {(h.ticker ?? h.name)[0]}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <span className="truncate">{h.name}</span>
                      {h.ticker && (
                        <span className="ml-1.5 text-xs text-zinc-500">
                          {h.ticker}
                        </span>
                      )}
                    </div>
                    <div className="text-right shrink-0 tabular-nums">
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
                  </Command.Item>
                ))}
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
                    <Icon className="w-4 h-4 text-zinc-500 shrink-0" />
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
                      <Icon className="w-4 h-4 text-zinc-500 shrink-0" />
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
                  <div className="flex items-center justify-center gap-2 py-3 text-xs text-zinc-500">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Searching...
                  </div>
                )}
                {externalResults.length > 0 && (
                  <Command.Group heading="Add New Asset" forceMount>
                    {externalResults.map((r) => (
                      <Command.Item
                        key={`ext-${r.type}-${r.id}`}
                        value={`${r.name} ${r.ticker}`}
                        onSelect={() => go(r.detailPath)}
                        className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm cursor-pointer data-[selected=true]:bg-zinc-800 text-zinc-300 data-[selected=true]:text-zinc-100"
                        forceMount
                      >
                        {r.icon ? (
                          <img
                            src={r.icon}
                            alt=""
                            className="w-5 h-5 rounded-full shrink-0"
                          />
                        ) : (
                          <div className="w-5 h-5 rounded-full bg-zinc-800 shrink-0 flex items-center justify-center text-[10px] text-zinc-500 font-medium">
                            {r.ticker[0]}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <span className="truncate">{r.name}</span>
                          <span className="ml-1.5 text-xs text-zinc-500">
                            {r.ticker}
                          </span>
                        </div>
                        {r.price !== undefined && (
                          <span className="text-xs text-zinc-400 tabular-nums shrink-0">
                            ${r.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </span>
                        )}
                      </Command.Item>
                    ))}
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
```

**Step 2: Verify**

```bash
npm run build
```

Expected: clean build. The palette and provider compile but aren't rendered yet.

**Step 3: Commit**

```bash
git add src/components/ui/command-palette.tsx src/components/ui/command-palette-provider.tsx
git commit -m "feat(palette): create provider and palette components"
```

---

### Task 4: Wire into dashboard layout + add search pill

**Files:**
- Modify: `src/app/dashboard/layout.tsx:1-47`
- Create: `src/components/ui/search-pill.tsx`

**Step 1: Create the SearchPill component**

Create `src/components/ui/search-pill.tsx`:

```tsx
"use client";

import { Search } from "lucide-react";
import { useCommandPalette } from "./command-palette-provider";

export function SearchPill() {
  const { setOpen } = useCommandPalette();

  return (
    <button
      onClick={() => setOpen(true)}
      className="flex items-center gap-1.5 px-2.5 py-1 bg-zinc-800/60 rounded-lg text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
    >
      <Search className="w-3 h-3" />
      <span className="hidden sm:inline">Search</span>
      <kbd className="hidden sm:inline-flex ml-0.5 text-[10px] text-zinc-600 font-mono">⌘K</kbd>
    </button>
  );
}
```

On mobile: only the search icon (saves space). On desktop: "Search ⌘K". Uses the same `bg-zinc-800/60 rounded-lg` as CurrencyToggle for visual consistency.

**Step 2: Update dashboard layout**

In `src/app/dashboard/layout.tsx`, add imports (after existing imports):

```ts
import { CommandPaletteProvider } from "@/components/ui/command-palette-provider";
import { SearchPill } from "@/components/ui/search-pill";
```

Replace the return block to wrap with provider and add the search pill next to CurrencyToggle:

```tsx
return (
  <SidebarProvider>
    <CommandPaletteProvider primaryCurrency={profile?.primary_currency ?? "EUR"}>
      <ThemeSync profileTheme={profile?.theme ?? null} />
      <div className="flex min-h-screen">
        <Sidebar email={user.email ?? ""} />
        <main className="flex-1 min-w-0 lg:ml-0">
          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8 overflow-x-hidden">
            <div className="absolute top-6 right-4 sm:right-6 lg:right-8 z-10 flex items-center gap-2">
              <SearchPill />
              <CurrencyToggle
                initialCurrency={profile?.primary_currency ?? "EUR"}
              />
            </div>
            {children}
          </div>
        </main>
      </div>
    </CommandPaletteProvider>
  </SidebarProvider>
);
```

Key changes: (1) `CommandPaletteProvider` wraps inside `SidebarProvider`, (2) the absolute-positioned div becomes `flex items-center gap-2` to hold both SearchPill and CurrencyToggle side by side.

**Step 3: Verify**

```bash
npm run build
```

Expected: clean build. Cmd+K opens the palette on any dashboard page. Clicking the search pill also opens it. Palette shows Pages and Actions groups.

**Step 4: Commit**

```bash
git add src/app/dashboard/layout.tsx src/components/ui/search-pill.tsx
git commit -m "feat(palette): wire into dashboard layout, add search pill trigger"
```

---

### Task 5: Register holdings in dashboard page

**Files:**
- Modify: `src/app/dashboard/page.tsx:1-210`

**Step 1: Add imports**

At the top of `src/app/dashboard/page.tsx`, add:

```ts
import { RegisterHoldings } from "@/components/ui/command-palette-provider";
import type { HoldingItem } from "@/lib/types";
```

**Step 2: Build holdings array**

After the `pastSnapshots` definition (around line 166, before the `return`) add:

```ts
// ── Build flat holdings for command palette search ─────
const paletteHoldings: HoldingItem[] = [
  ...cryptoAssets.map((a) => {
    const price = cryptoPrices[a.coingecko_id];
    const totalQty = a.positions.reduce((s, p) => s + p.quantity, 0);
    const valueUsd = (price?.usd ?? 0) * totalQty;
    return {
      id: a.id,
      type: "crypto" as const,
      name: a.name,
      ticker: a.ticker.toUpperCase(),
      value: valueUsd * (fxRates["USD"] ?? 1),
      change24h: price?.usd_24h_change,
      icon: a.image_url,
      detailPath: "/dashboard/crypto",
    };
  }),
  ...stockAssets.map((a) => {
    const tick = a.yahoo_ticker || a.ticker;
    const price = stockPrices[tick];
    const totalQty = a.positions.reduce((s, p) => s + p.quantity, 0);
    const valueNative = (price?.price ?? 0) * totalQty;
    return {
      id: a.id,
      type: "stock" as const,
      name: a.name,
      ticker: a.ticker,
      value: valueNative * (fxRates[price?.currency ?? a.currency] ?? 1),
      change24h: price?.change24h,
      detailPath: "/dashboard/stocks",
    };
  }),
  ...bankAccounts.map((a) => ({
    id: a.id,
    type: "bank" as const,
    name: `${a.name} (${a.currency})`,
    value: a.balance * (fxRates[a.currency] ?? 1),
    detailPath: "/dashboard/cash",
  })),
  ...exchangeDeposits.map((d) => ({
    id: d.id,
    type: "exchange_deposit" as const,
    name: `${d.wallet_name} ${d.currency}`,
    value: d.amount * (fxRates[d.currency] ?? 1),
    detailPath: "/dashboard/cash",
  })),
  ...brokerDeposits.map((d) => ({
    id: d.id,
    type: "broker_deposit" as const,
    name: `${d.broker_name} ${d.currency}`,
    value: d.amount * (fxRates[d.currency] ?? 1),
    detailPath: "/dashboard/cash",
  })),
];
```

**Step 3: Render RegisterHoldings**

Inside the return JSX, add `<RegisterHoldings>` as the first child of the outer `<div>`:

```tsx
return (
  <div>
    <RegisterHoldings holdings={paletteHoldings} />
    <div className="mb-8">
      {/* ... existing content ... */}
```

**Step 4: Verify**

```bash
npm run build
```

Expected: clean build. Cmd+K on the dashboard shows "Your Holdings" group with all crypto assets, stocks, bank accounts, and deposits, each with name, ticker, value, and 24h change.

**Step 5: Commit**

```bash
git add src/app/dashboard/page.tsx
git commit -m "feat(palette): register portfolio holdings for search"
```

---

### Task 6: Share page integration

**Files:**
- Modify: `src/app/share/[token]/layout.tsx:1-53`
- Modify: `src/app/share/[token]/page.tsx:1-165`

**Step 1: Update share layout profile query**

In `src/app/share/[token]/layout.tsx`, change the profile select (line ~24) to include `primary_currency`:

```ts
.select("display_name, theme, primary_currency")
```

Add import:

```ts
import { CommandPaletteProvider } from "@/components/ui/command-palette-provider";
```

Wrap content with provider (inside `<SharedViewProvider>`, around everything else):

```tsx
return (
  <SharedViewProvider ownerName={ownerName} scope={share.scope} shareToken={token}>
    <CommandPaletteProvider primaryCurrency={profile?.primary_currency ?? "EUR"}>
      <ThemeSync profileTheme={profile?.theme ?? null} />
      <div className="min-h-screen bg-zinc-950 text-zinc-100">
        <ComparisonTrigger
          token={token}
          scope={share.scope}
          ownerName={ownerName}
          isAuthenticated={!!session}
        >
          <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8 overflow-x-hidden">
            {children}
          </main>
        </ComparisonTrigger>
      </div>
    </CommandPaletteProvider>
  </SharedViewProvider>
);
```

**Step 2: Register holdings in share page**

In `src/app/share/[token]/page.tsx`, add imports:

```ts
import { RegisterHoldings } from "@/components/ui/command-palette-provider";
import type { HoldingItem } from "@/lib/types";
```

After `pastSnapshots` (around line 128), build the holdings array. Same as dashboard but with share-scoped paths:

```ts
const paletteHoldings: HoldingItem[] = [
  ...cryptoAssets.map((a) => {
    const price = cryptoPrices[a.coingecko_id];
    const totalQty = a.positions.reduce((s, p) => s + p.quantity, 0);
    const valueUsd = (price?.usd ?? 0) * totalQty;
    return {
      id: a.id,
      type: "crypto" as const,
      name: a.name,
      ticker: a.ticker.toUpperCase(),
      value: valueUsd * (fxRates["USD"] ?? 1),
      change24h: price?.usd_24h_change,
      icon: a.image_url,
      detailPath: `/share/${token}/crypto`,
    };
  }),
  ...stockAssets.map((a) => {
    const tick = a.yahoo_ticker || a.ticker;
    const price = stockPrices[tick];
    const totalQty = a.positions.reduce((s, p) => s + p.quantity, 0);
    const valueNative = (price?.price ?? 0) * totalQty;
    return {
      id: a.id,
      type: "stock" as const,
      name: a.name,
      ticker: a.ticker,
      value: valueNative * (fxRates[price?.currency ?? a.currency] ?? 1),
      change24h: price?.change24h,
      detailPath: `/share/${token}/stocks`,
    };
  }),
  ...bankAccounts.map((a) => ({
    id: a.id,
    type: "bank" as const,
    name: `${a.name} (${a.currency})`,
    value: a.balance * (fxRates[a.currency] ?? 1),
    detailPath: `/share/${token}/cash`,
  })),
  ...exchangeDeposits.map((d) => ({
    id: d.id,
    type: "exchange_deposit" as const,
    name: `${d.wallet_name} ${d.currency}`,
    value: d.amount * (fxRates[d.currency] ?? 1),
    detailPath: `/share/${token}/cash`,
  })),
  ...brokerDeposits.map((d) => ({
    id: d.id,
    type: "broker_deposit" as const,
    name: `${d.broker_name} ${d.currency}`,
    value: d.amount * (fxRates[d.currency] ?? 1),
    detailPath: `/share/${token}/cash`,
  })),
];
```

Add `<RegisterHoldings>` as first child in the return:

```tsx
return (
  <div>
    <RegisterHoldings holdings={paletteHoldings} />
    <div className="mb-8">
      {/* ... existing content ... */}
```

**Step 3: Verify**

```bash
npm run build
```

Expected: clean build. Share pages have Cmd+K with Holdings + Pages (share routes only). No Actions or External search groups on share pages.

**Step 4: Commit**

```bash
git add "src/app/share/[token]/layout.tsx" "src/app/share/[token]/page.tsx"
git commit -m "feat(palette): add command palette to share pages"
```

---

### Task 7: Styling refinements for cmdk

**Files:**
- Modify: `src/components/ui/command-palette.tsx` (already created, minor tweaks if needed)

cmdk renders with `[cmdk-*]` data attributes. The component already uses inline Tailwind classes. This task handles any styling issues discovered during Task 4-6 verification.

**Step 1: Add global cmdk CSS overrides**

If cmdk's default group heading styles need overriding, add to `src/app/globals.css`:

```css
[cmdk-group-heading] {
  @apply text-xs text-zinc-500 uppercase tracking-wider px-3 py-1.5 select-none;
}

[cmdk-separator] {
  @apply h-px bg-zinc-800/50 mx-2 my-1;
}
```

**Step 2: Verify visual consistency**

```bash
npm run build
```

Manually check: dark theme consistency (zinc-900 background, zinc-800 borders), group headers match `text-xs text-zinc-500 uppercase tracking-wider` convention, selected item has `bg-zinc-800` highlight.

**Step 3: Commit**

```bash
git add src/app/globals.css src/components/ui/command-palette.tsx
git commit -m "feat(palette): styling refinements"
```

---

### Task 8: Final build verification + commit

**Step 1: Full build**

```bash
npm run build 2>&1 | tail -20
npm run lint 2>&1 | tail -10
```

Expected: 0 errors, 0 warnings.

**Step 2: Manual verification checklist**

- [ ] Cmd+K / Ctrl+K opens palette on all dashboard pages
- [ ] Cmd+K opens palette on share pages
- [ ] Typing filters Holdings, Pages, Actions instantly
- [ ] Arrow keys navigate between results
- [ ] Enter selects and navigates to the correct page
- [ ] Escape closes the palette
- [ ] Click outside closes the palette
- [ ] Share pages: no Actions group, no external search, share routes
- [ ] External search fires after 500ms with 3+ chars (dashboard only)
- [ ] Search pill (top-right, next to CurrencyToggle) opens the palette
- [ ] Mobile: overlay covers full screen, scrollable results

**Step 3: Final commit (if any uncommitted changes)**

```bash
git add -A
git commit -m "feat: global search command palette (Cmd+K)"
```

---

## Future Enhancements (not in this plan)

- **Auto-open Add modals:** External search results navigate to detail pages. Future: pass `?addAsset=id` URL param to auto-open Add Crypto/Stock modal pre-filled.
- **Recent/frequent items:** Track and surface recently visited pages or searched assets.
- **Fuzzy matching:** cmdk supports custom filter functions for fuzzy matching beyond substring.
- **Inline asset preview:** Show mini-chart or price sparkline in search results.
