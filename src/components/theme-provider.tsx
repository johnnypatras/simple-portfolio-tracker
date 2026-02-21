"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import { THEME_IDS } from "@/lib/themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="zinc-dark"
      themes={[...THEME_IDS]}
    >
      {children}
    </NextThemesProvider>
  );
}
