"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { DEFAULT_THEME } from "@/lib/themes";

/**
 * Syncs the user's Supabase profile theme with next-themes on mount.
 *
 * next-themes owns localStorage for flash-free page loads.
 * Supabase owns the persistent, cross-device source of truth.
 *
 * On mount: if the server-fetched profile theme differs from the
 * current next-themes value, we push the profile theme into next-themes.
 * This handles the case where a user changes theme on device A,
 * then opens device B — the profile wins over stale localStorage.
 */
export function ThemeSync({ profileTheme }: { profileTheme: string | null }) {
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    const target = profileTheme ?? DEFAULT_THEME;
    if (theme !== target) {
      setTheme(target);
    }
  }, [profileTheme]); // eslint-disable-line react-hooks/exhaustive-deps
  // ^ Intentionally omit theme/setTheme — we only want to sync on mount
  // and when the profile changes, not on every local theme toggle.

  return null;
}
