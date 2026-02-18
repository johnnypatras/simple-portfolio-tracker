"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { ColumnDef, ColumnConfigState } from "@/lib/column-config";

// ── Helpers ──────────────────────────────────────────────────

/** Extract the default visible keys (in definition order) from column defs */
function getDefaultVisibleKeys<T>(columns: ColumnDef<T>[]): string[] {
  return columns
    .filter((c) => !c.pinned && c.defaultVisible !== false)
    .map((c) => c.key);
}

/** Read + parse localStorage, returning null on any failure */
function readStorage(key: string): ColumnConfigState | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as ColumnConfigState;
  } catch {
    return null;
  }
}

/** Reconcile a saved config against current column defs.
 *  - Removes keys that no longer exist in defs
 *  - Appends new keys that weren't in the saved config
 *  - Invalidates if version has changed
 */
function reconcile<T>(
  saved: ColumnConfigState,
  columns: ColumnDef<T>[],
  version: number
): string[] {
  if (saved.version !== version) return getDefaultVisibleKeys(columns);

  const validKeys = new Set(columns.filter((c) => !c.pinned).map((c) => c.key));

  // Keep only keys that still exist
  const reconciled = saved.visibleKeys.filter((k) => validKeys.has(k));

  // Append any new keys not yet in the saved config
  const reconciledSet = new Set(reconciled);
  for (const col of columns) {
    if (!col.pinned && col.defaultVisible !== false && !reconciledSet.has(col.key)) {
      reconciled.push(col.key);
    }
  }

  return reconciled;
}

// ── Hook ─────────────────────────────────────────────────────

export interface UseColumnConfigReturn<T> {
  /** Fully ordered columns: pinned-left + user-visible + pinned-right */
  orderedColumns: ColumnDef<T>[];
  /** All non-pinned columns with their current visibility state */
  configurableColumns: { key: string; label: string; visible: boolean }[];
  /** Toggle a column's visibility */
  toggleColumn: (key: string) => void;
  /** Move a column up or down in the order */
  moveColumn: (key: string, direction: "up" | "down") => void;
  /** Reset to default column layout */
  resetToDefaults: () => void;
}

export function useColumnConfig<T>(
  storageKey: string,
  allColumns: ColumnDef<T>[],
  version: number
): UseColumnConfigReturn<T> {
  const defaults = useMemo(() => getDefaultVisibleKeys(allColumns), [allColumns]);

  // Start with defaults (SSR-safe)
  const [visibleKeys, setVisibleKeys] = useState<string[]>(defaults);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from localStorage on mount
  useEffect(() => {
    const saved = readStorage(storageKey);
    if (saved) {
      setVisibleKeys(reconcile(saved, allColumns, version));
    }
    setHydrated(true);
  }, [storageKey, allColumns, version]);

  // Persist to localStorage whenever visibleKeys change (after hydration)
  useEffect(() => {
    if (!hydrated) return;
    const state: ColumnConfigState = { version, visibleKeys };
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Storage full or unavailable — silently ignore
    }
  }, [storageKey, version, visibleKeys, hydrated]);

  // ── Derived: ordered columns ──────────────────────────────

  const orderedColumns = useMemo(() => {
    const pinnedLeft = allColumns.filter((c) => c.pinned === "left");
    const pinnedRight = allColumns.filter((c) => c.pinned === "right");
    const colMap = new Map(allColumns.map((c) => [c.key, c]));
    const middle = visibleKeys
      .map((k) => colMap.get(k))
      .filter((c): c is ColumnDef<T> => c != null && !c.pinned);
    return [...pinnedLeft, ...middle, ...pinnedRight];
  }, [allColumns, visibleKeys]);

  // ── Derived: configurable columns for the popover ─────────

  const configurableColumns = useMemo(() => {
    const visibleSet = new Set(visibleKeys);
    // Show in current user order, with hidden ones appended at the end
    const ordered: { key: string; label: string; visible: boolean }[] = [];
    const addedKeys = new Set<string>();

    // First: visible keys in their order
    for (const key of visibleKeys) {
      const col = allColumns.find((c) => c.key === key && !c.pinned);
      if (col) {
        ordered.push({ key: col.key, label: col.label, visible: true });
        addedKeys.add(col.key);
      }
    }

    // Then: hidden non-pinned keys in definition order
    for (const col of allColumns) {
      if (!col.pinned && !addedKeys.has(col.key)) {
        ordered.push({ key: col.key, label: col.label, visible: false });
      }
    }

    return ordered;
  }, [allColumns, visibleKeys]);

  // ── Actions ───────────────────────────────────────────────

  const toggleColumn = useCallback(
    (key: string) => {
      setVisibleKeys((prev) => {
        if (prev.includes(key)) {
          // Don't allow hiding the last visible column
          if (prev.length <= 1) return prev;
          return prev.filter((k) => k !== key);
        }
        // Add at the end
        return [...prev, key];
      });
    },
    []
  );

  const moveColumn = useCallback(
    (key: string, direction: "up" | "down") => {
      setVisibleKeys((prev) => {
        const idx = prev.indexOf(key);
        if (idx === -1) return prev;
        const targetIdx = direction === "up" ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= prev.length) return prev;

        const next = [...prev];
        [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];
        return next;
      });
    },
    []
  );

  const resetToDefaults = useCallback(() => {
    setVisibleKeys(defaults);
  }, [defaults]);

  return {
    orderedColumns,
    configurableColumns,
    toggleColumn,
    moveColumn,
    resetToDefaults,
  };
}
