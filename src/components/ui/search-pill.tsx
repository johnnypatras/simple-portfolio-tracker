"use client";

import { Search } from "lucide-react";
import { useCommandPalette } from "./command-palette-provider";

export function SearchPill() {
  const { setOpen } = useCommandPalette();

  return (
    <button
      onClick={() => setOpen(true)}
      className="flex items-center gap-1.5 px-2.5 py-1 bg-zinc-800/60 rounded-lg text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
    >
      <Search className="w-3 h-3" />
      <span className="hidden sm:inline">Search</span>
      <kbd className="hidden sm:inline-flex ml-0.5 text-[10px] text-zinc-600 font-mono">⌘K</kbd>
    </button>
  );
}
