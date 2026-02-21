"use client";

import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { THEMES, DEFAULT_THEME, type ThemeId } from "@/lib/themes";
import { updateProfile } from "@/lib/actions/profile";

// Detect client-side mount without triggering setState-in-effect lint rule
const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * Visual theme picker — 3×2 grid of swatch cards.
 * Clicking a card instantly applies the theme (via next-themes)
 * and persists the choice to the user's Supabase profile.
 */
export function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  async function handleSelect(id: ThemeId) {
    setTheme(id);
    try {
      await updateProfile({ theme: id });
    } catch {
      // Silently fail — theme is already applied locally.
      // It'll be out of sync with Supabase, but next login will correct it.
    }
  }

  const activeTheme = (mounted ? theme : undefined) ?? DEFAULT_THEME;

  return (
    <div>
      <label className="block text-sm text-zinc-400 mb-3">Theme</label>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-w-md">
        {THEMES.map((t) => {
          const isActive = activeTheme === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => handleSelect(t.id)}
              className={`group relative rounded-lg border-2 p-3 text-left transition-all ${
                isActive
                  ? "border-blue-500 ring-1 ring-blue-500/30"
                  : "border-zinc-800 hover:border-zinc-600"
              }`}
            >
              {/* Mini swatch preview */}
              <div
                className="rounded-md mb-2 p-2 flex items-center gap-1.5"
                style={{ backgroundColor: t.preview.bg }}
              >
                {/* Simulated card */}
                <div
                  className="w-full h-5 rounded"
                  style={{ backgroundColor: t.preview.card }}
                >
                  <div className="flex items-center gap-1 px-1.5 pt-1">
                    <div
                      className="w-3 h-1.5 rounded-sm"
                      style={{ backgroundColor: t.preview.text, opacity: 0.7 }}
                    />
                    <div
                      className="w-1.5 h-1.5 rounded-full ml-auto"
                      style={{ backgroundColor: t.preview.accent }}
                    />
                  </div>
                </div>
              </div>

              {/* Label */}
              <p className="text-xs font-medium text-zinc-200">{t.label}</p>
              <p className="text-[10px] text-zinc-500 leading-tight">
                {t.description}
              </p>

              {/* Active indicator */}
              {isActive && (
                <div className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-blue-500" />
              )}
            </button>
          );
        })}
      </div>

      <p className="text-xs text-zinc-600 mt-2">
        Applies instantly across all pages
      </p>
    </div>
  );
}
