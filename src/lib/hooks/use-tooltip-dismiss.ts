"use client";

import { useState, useRef, useCallback, useEffect } from "react";

/**
 * Manages a single open tooltip with mobile tap-to-toggle and outside-click dismiss.
 *
 * Desktop: CSS `group-hover/tip:block` still works via the ChangeTooltip component.
 * Mobile:  tap toggles open/close; tapping outside dismisses.
 *
 * Returns:
 *  - openTooltip: the currently open tooltip id (or null)
 *  - tooltipRef:  attach to the `<span>` wrapping the active tooltip
 *  - toggleTooltip: onClick handler for the tooltip trigger
 */
export function useTooltipDismiss() {
  const [openTooltip, setOpenTooltip] = useState<string | null>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);

  const toggleTooltip = useCallback((id: string, e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpenTooltip((prev) => (prev === id ? null : id));
  }, []);

  useEffect(() => {
    if (!openTooltip) return;
    const onPointerDown = (e: PointerEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target as Node)) {
        setOpenTooltip(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openTooltip]);

  return { openTooltip, tooltipRef, toggleTooltip } as const;
}
