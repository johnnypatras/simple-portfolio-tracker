// ─── Theme system ───────────────────────────────────────────

export type ThemeId =
  | "zinc-dark"
  | "slate-dark"
  | "neutral-dark"
  | "oxocarbon"
  | "gruvbox"
  | "dim"
  | "light"
  | "warm-light";

export type ThemeGroup = "dark" | "dim" | "light";

export interface ThemeDefinition {
  id: ThemeId;
  label: string;
  description: string;
  group: ThemeGroup;
  /** Hex swatches for the visual preview cards in settings */
  preview: {
    bg: string;
    card: string;
    text: string;
    accent: string;
  };
}

export const THEME_IDS: ThemeId[] = [
  "zinc-dark",
  "slate-dark",
  "neutral-dark",
  "oxocarbon",
  "gruvbox",
  "dim",
  "light",
  "warm-light",
];

export const THEMES: ThemeDefinition[] = [
  {
    id: "zinc-dark",
    label: "Zinc",
    description: "Cool dark (default)",
    group: "dark",
    preview: { bg: "#18181b", card: "#27272a", text: "#fafafa", accent: "#3b82f6" },
  },
  {
    id: "slate-dark",
    label: "Slate",
    description: "Blue-tinted midnight",
    group: "dark",
    preview: { bg: "#0f172a", card: "#1e293b", text: "#f8fafc", accent: "#3b82f6" },
  },
  {
    id: "neutral-dark",
    label: "Neutral",
    description: "Pure black, OLED",
    group: "dark",
    preview: { bg: "#000000", card: "#171717", text: "#fafafa", accent: "#3b82f6" },
  },
  {
    id: "oxocarbon",
    label: "Oxocarbon",
    description: "IBM Carbon-inspired",
    group: "dark",
    preview: { bg: "#161616", card: "#262626", text: "#f2f4f8", accent: "#78a9ff" },
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    description: "Retro warm contrast",
    group: "dark",
    preview: { bg: "#1d2021", card: "#3c3836", text: "#ebdbb2", accent: "#fabd2f" },
  },
  {
    id: "dim",
    label: "Dim",
    description: "Softer contrast",
    group: "dim",
    preview: { bg: "#2e2e32", card: "#3a3a3f", text: "#e4e4e7", accent: "#3b82f6" },
  },
  {
    id: "light",
    label: "Light",
    description: "Clean and bright",
    group: "light",
    preview: { bg: "#fafafa", card: "#ffffff", text: "#18181b", accent: "#2563eb" },
  },
  {
    id: "warm-light",
    label: "Warm",
    description: "Paper-like warmth",
    group: "light",
    preview: { bg: "#f5efe6", card: "#fdfbf7", text: "#2c2216", accent: "#2563eb" },
  },
];

export const DEFAULT_THEME: ThemeId = "zinc-dark";
