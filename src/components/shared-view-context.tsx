"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ShareScope } from "@/lib/actions/shares";

interface SharedViewState {
  /** True when viewing someone else's portfolio (share link) */
  isReadOnly: boolean;
  /** Display name or email of the portfolio owner */
  ownerName: string;
  /** What sections the viewer can access */
  scope: ShareScope;
  /** Share token for constructing links (e.g. /share/[token]/crypto) */
  shareToken?: string;
}

const SharedViewContext = createContext<SharedViewState>({
  isReadOnly: false,
  ownerName: "",
  scope: "full",
});

export function SharedViewProvider({
  ownerName,
  scope,
  shareToken,
  children,
}: {
  ownerName: string;
  scope: ShareScope;
  shareToken: string;
  children: ReactNode;
}) {
  return (
    <SharedViewContext.Provider value={{ isReadOnly: true, ownerName, scope, shareToken }}>
      {children}
    </SharedViewContext.Provider>
  );
}

/** Hook to check if we're in a shared (read-only) view. */
export function useSharedView() {
  return useContext(SharedViewContext);
}
