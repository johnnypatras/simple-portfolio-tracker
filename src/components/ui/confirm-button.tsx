"use client";

import { useState, useRef, useEffect } from "react";
import { Check, X } from "lucide-react";

interface ConfirmButtonProps {
  onConfirm: (opts?: { isAdjustment: boolean }) => void;
  confirmLabel?: string;
  /** Tailwind classes for the confirm label text (default: "text-red-400") */
  confirmLabelClassName?: string;
  children: React.ReactNode;
  className?: string;
  title?: string;
  /** Accessible name for the trigger button; falls back to `title` when omitted. */
  ariaLabel?: string;
  /** Show an "Adj" checkbox in the confirming state */
  showAdjustmentCheckbox?: boolean;
}

/**
 * Two-click confirmation button. First click shows "Delete?" with
 * confirm (✓) / cancel (✕). Second click executes the action.
 * Auto-dismisses after 3 seconds or on outside click.
 */
export function ConfirmButton({
  onConfirm,
  confirmLabel = "Delete?",
  confirmLabelClassName = "text-red-400",
  children,
  className = "",
  title,
  ariaLabel,
  showAdjustmentCheckbox,
}: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const [adjChecked, setAdjChecked] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Auto-dismiss after 3s
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(timer);
  }, [confirming]);

  // Click outside to dismiss
  useEffect(() => {
    if (!confirming) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setConfirming(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [confirming]);

  if (confirming) {
    return (
      <div ref={wrapperRef} className="flex items-center gap-1">
        <span
          className={`text-[10px] font-medium whitespace-nowrap ${confirmLabelClassName}`}
        >
          {confirmLabel}
        </span>
        {showAdjustmentCheckbox && (
          <label className="flex items-center gap-1 cursor-pointer select-none" title="Not a real transaction — portfolio balance correction">
            <input
              type="checkbox"
              checked={adjChecked}
              onChange={(e) => setAdjChecked(e.target.checked)}
              className="w-3 h-3 accent-amber-500"
            />
            <span className="text-[10px] text-zinc-400">Adj.</span>
          </label>
        )}
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            onConfirm(showAdjustmentCheckbox ? { isAdjustment: adjChecked } : undefined);
            setAdjChecked(false);
          }}
          aria-label="Confirm"
          className="p-1.5 min-w-6 min-h-6 rounded text-emerald-400 hover:bg-emerald-500/15 transition-colors"
          title="Confirm"
        >
          <Check aria-hidden="true" className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => { setConfirming(false); setAdjChecked(false); }}
          aria-label="Cancel"
          className="p-1.5 min-w-6 min-h-6 rounded text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          title="Cancel"
        >
          <X aria-hidden="true" className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className={className}
      title={title}
      aria-label={ariaLabel ?? title}
    >
      {children}
    </button>
  );
}
