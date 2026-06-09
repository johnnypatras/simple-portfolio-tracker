"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import type { PendingAddAsset } from "@/lib/types";

/**
 * Shared client store handing a NEW-asset palette selection to the destination
 * page's `AddAssetManager`. The command palette `setPending(...)` then navigates;
 * the matching page's table reads `pending` and opens the manager pre-picked,
 * which consumes it via `clear()` exactly once. The default value is a no-op so
 * `useAddAssetContext()` is safe to call outside a provider (e.g. the tables
 * render in tests without one) — absent a provider, `pending` is always null and
 * nothing auto-opens.
 */
interface AddAssetState {
  pending: PendingAddAsset | null;
  setPending: (p: PendingAddAsset) => void;
  clear: () => void;
}

const AddAssetContext = createContext<AddAssetState>({
  pending: null,
  setPending: () => {},
  clear: () => {},
});

export function AddAssetProvider({ children }: { children: ReactNode }) {
  const [pending, setPendingRaw] = useState<PendingAddAsset | null>(null);

  const setPending = useCallback((p: PendingAddAsset) => setPendingRaw(p), []);
  const clear = useCallback(() => setPendingRaw(null), []);

  const value = useMemo(
    () => ({ pending, setPending, clear }),
    [pending, setPending, clear],
  );

  return <AddAssetContext.Provider value={value}>{children}</AddAssetContext.Provider>;
}

export function useAddAssetContext() {
  return useContext(AddAssetContext);
}
