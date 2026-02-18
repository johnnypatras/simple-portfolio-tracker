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
        className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
        title="Configure columns"
      >
        <Settings2 className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-full mt-1 z-50 w-56 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-800/50">
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
              Columns
            </span>
            <button
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
            {columns.map((col, idx) => {
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
                      className="w-3.5 h-3.5 rounded border-zinc-700 bg-zinc-950 text-blue-500 focus:ring-blue-500/30 focus:ring-offset-0 shrink-0"
                    />
                    <span
                      className={`text-sm truncate ${
                        col.visible ? "text-zinc-200" : "text-zinc-500"
                      }`}
                    >
                      {col.label}
                    </span>
                  </label>

                  {/* Reorder arrows (only for visible columns) */}
                  {col.visible && (
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={() => onMove(col.key, "up")}
                        disabled={isFirst}
                        className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 disabled:text-zinc-700 disabled:cursor-not-allowed transition-colors"
                        title="Move up"
                      >
                        <ChevronUp className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => onMove(col.key, "down")}
                        disabled={isLast}
                        className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 disabled:text-zinc-700 disabled:cursor-not-allowed transition-colors"
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
