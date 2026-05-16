"use client";

import { Search } from "lucide-react";
import { useCommandPalette } from "./command-palette-provider";

export function SearchPill() {
  const { setOpen } = useCommandPalette();

  return (
    <button
      onClick={() => setOpen(true)}
      aria-label="Search"
      className="flex items-center gap-1.5 px-2.5 py-1 bg-zinc-800/60 rounded-lg text-xs text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
    >
      <Search aria-hidden="true" className="w-3 h-3" />
      <span className="hidden sm:inline">Search</span>
      <kbd className="hidden sm:inline-flex px-1 py-0.5 rounded bg-zinc-700/50 border border-zinc-600/50 text-[10px] text-zinc-300 font-mono">⌘K</kbd>
    </button>
  );
}
