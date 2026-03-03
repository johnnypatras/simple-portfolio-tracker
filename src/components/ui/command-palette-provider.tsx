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

const HOLDINGS_CACHE_KEY = "cmd-palette-holdings";

function readCachedHoldings(): HoldingItem[] {
  try {
    const raw = localStorage.getItem(HOLDINGS_CACHE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as HoldingItem[];
  } catch {
    return [];
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
  const [holdings, setHoldingsRaw] = useState<HoldingItem[]>([]);

  // Hydrate holdings: localStorage first (instant), then API if cache is empty
  useEffect(() => {
    const cached = readCachedHoldings();
    if (cached.length > 0) {
      setHoldingsRaw(cached);
      return;
    }
    // No cache — fetch from API (first-ever visit, cleared storage, etc.)
    fetch("/api/holdings")
      .then((r) => (r.ok ? r.json() : []))
      .then((items: HoldingItem[]) => {
        if (items.length > 0) {
          setHoldingsRaw(items);
          try {
            localStorage.setItem(HOLDINGS_CACHE_KEY, JSON.stringify(items));
          } catch { /* quota exceeded */ }
        }
      })
      .catch(() => {});
  }, []);

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
