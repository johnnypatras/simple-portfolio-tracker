"use client";

import { useState, useRef, useEffect } from "react";
import { Settings2, ChevronUp, ChevronDown } from "lucide-react";

interface ColumnSettingsPopoverProps {
  columns: { key: string; label: string; visible: boolean }[];
  onToggle: (key: string) => void;
  onMove: (key: string, direction: "up" | "down") => void;
  onReset: () => void;
}

export function ColumnSettingsPopover({
  columns,
  onToggle,
  onMove,
  onReset,
}: ColumnSettingsPopoverProps) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Focus popover when opened
  useEffect(() => {
    if (open) {
      popoverRef.current?.focus();
    }
  }, [open]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  // Find first/last visible column indices for disabling arrows
  const visibleColumns = columns.filter((c) => c.visible);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((prev) => !prev)}
        className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
        title="Configure columns"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Column settings"
      >
        <Settings2 className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Column settings"
          tabIndex={-1}
          className="absolute left-0 top-full mt-1 z-50 w-56 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl focus:outline-none"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-800/50">
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
              Columns
            </span>
            <button
              type="button"
              onClick={() => {
                onReset();
              }}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              Reset
            </button>
          </div>

          {/* Column list */}
          <div className="py-1">
            {columns.map((col) => {
              const visibleIdx = visibleColumns.findIndex(
                (v) => v.key === col.key
              );
              const isFirst = visibleIdx === 0;
              const isLast = visibleIdx === visibleColumns.length - 1;

              return (
                <div
                  key={col.key}
                  className="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-800/50 transition-colors"
                >
                  {/* Checkbox */}
                  <label className="flex items-center gap-2 flex-1 cursor-pointer min-w-0">
                    <input
                      type="checkbox"
                      checked={col.visible}
                      onChange={() => onToggle(col.key)}
                      className="w-3.5 h-3.5 accent-blue-500 shrink-0"
                    />
                    <span
                      className={`text-sm truncate ${
                        col.visible ? "text-zinc-200" : "text-zinc-400"
                      }`}
                    >
                      {col.label}
                    </span>
                  </label>

                  {/* Reorder arrows (only for visible columns) */}
                  {col.visible && (
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => onMove(col.key, "up")}
                        disabled={isFirst}
                        aria-label={`Move ${col.label} up`}
                        className="p-0.5 rounded text-zinc-400 hover:text-zinc-300 disabled:text-zinc-700 disabled:cursor-not-allowed transition-colors"
                        title="Move up"
                      >
                        <ChevronUp className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onMove(col.key, "down")}
                        disabled={isLast}
                        aria-label={`Move ${col.label} down`}
                        className="p-0.5 rounded text-zinc-400 hover:text-zinc-300 disabled:text-zinc-700 disabled:cursor-not-allowed transition-colors"
                        title="Move down"
                      >
                        <ChevronDown className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
