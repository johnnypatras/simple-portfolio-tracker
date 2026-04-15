"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import type { HoldingItem } from "@/lib/types";
import { CommandPalette } from "./command-palette";

export const HOLDINGS_CACHE_KEY = "cmd-palette-holdings";

function readCachedHoldings(): { items: HoldingItem[]; wasEmpty: boolean } {
  try {
    const raw = localStorage.getItem(HOLDINGS_CACHE_KEY);
    if (!raw) return { items: [], wasEmpty: true };
    const items = JSON.parse(raw) as HoldingItem[];
    return { items, wasEmpty: items.length === 0 };
  } catch {
    return { items: [], wasEmpty: true };
  }
}

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
  const [{ items: initialItems, wasEmpty: cacheWasEmpty }] = useState(readCachedHoldings);
  const [holdings, setHoldingsRaw] = useState<HoldingItem[]>(initialItems);

  // If localStorage was empty on mount, fetch from API (first-ever visit, cleared storage)
  useEffect(() => {
    if (!cacheWasEmpty) return;
    fetch("/api/holdings")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: unknown) => {
        const items = Array.isArray(data)
          ? (data as HoldingItem[]).filter((x) => x && typeof x.id === "string" && typeof x.type === "string")
          : [];
        if (items.length > 0) {
          setHoldingsRaw(items);
          try {
            localStorage.setItem(HOLDINGS_CACHE_KEY, JSON.stringify(items));
          } catch { /* quota exceeded */ }
        }
      })
      .catch((err) => {
        console.warn("[command-palette] Holdings refresh failed:", err instanceof Error ? err.message : err);
      });
  }, [cacheWasEmpty]);

  const setHoldings = useCallback((items: HoldingItem[]) => {
    setHoldingsRaw(items);
    try {
      localStorage.setItem(HOLDINGS_CACHE_KEY, JSON.stringify(items));
    } catch { /* quota exceeded — stale cache is acceptable */ }
  }, []);

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
 * Holdings are cached in localStorage so they survive sub-page refreshes
 * (e.g. refreshing on /dashboard/crypto still populates "Your Holdings").
 */
export function RegisterHoldings({ holdings }: { holdings: HoldingItem[] }) {
  const { setHoldings } = useCommandPalette();
  useEffect(() => {
    setHoldings(holdings);
  }, [holdings, setHoldings]);
  return null;
}
