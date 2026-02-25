"use client";

import { useState, type ReactNode } from "react";
import type { ShareScope } from "@/lib/actions/shares";
import { SharedNavBar } from "@/components/shared-nav-bar";
import { ComparisonWidget } from "./comparison-widget";

interface ComparisonTriggerProps {
  token: string;
  scope: ShareScope;
  ownerName: string;
  isAuthenticated: boolean;
  children: ReactNode;
}

/**
 * Client wrapper that owns the comparison widget open/close state
 * and coordinates the SharedNavBar "Compare" button with the widget.
 */
export function ComparisonTrigger({
  token,
  scope,
  ownerName,
  isAuthenticated,
  children,
}: ComparisonTriggerProps) {
  const [compareOpen, setCompareOpen] = useState(false);

  return (
    <>
      <SharedNavBar
        token={token}
        scope={scope}
        ownerName={ownerName}
        isAuthenticated={isAuthenticated}
        onCompareClick={isAuthenticated ? () => setCompareOpen(true) : undefined}
      />
      {children}
      {isAuthenticated && (
        <ComparisonWidget
          token={token}
          ownerName={ownerName}
          isOpen={compareOpen}
          onClose={() => setCompareOpen(false)}
        />
      )}
    </>
  );
}
