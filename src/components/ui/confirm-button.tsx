"use client";

import { useState, useRef, useEffect } from "react";
import { Check, X } from "lucide-react";

interface ConfirmButtonProps {
  onConfirm: () => void;
  confirmLabel?: string;
  /** Tailwind classes for the confirm label text (default: "text-red-400") */
  confirmLabelClassName?: string;
  children: React.ReactNode;
  className?: string;
  title?: string;
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
}: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false);
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
        <button
          onClick={() => {
            setConfirming(false);
            onConfirm();
          }}
          className="p-1 rounded text-emerald-400 hover:bg-emerald-500/15 transition-colors"
          title="Confirm"
        >
          <Check className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          title="Cancel"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <button onClick={() => setConfirming(true)} className={className} title={title}>
      {children}
    </button>
  );
}
