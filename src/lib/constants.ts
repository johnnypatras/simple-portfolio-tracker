// ─── Shared constants across the app ─────────────────────────

/** Responsive column visibility: breakpoint → Tailwind class for table cells */
export const HIDDEN_BELOW: Record<string, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
};

/** Default country code for new institutions / bank accounts */
export const DEFAULT_COUNTRY = "GR";

/** Default wallet type for new wallets */
export const DEFAULT_WALLET_TYPE = "custodial" as const;

/** Fetch all snapshots (pass to getSnapshots for export/full-history) */
export const ALL_SNAPSHOTS_DAYS = 99999;

/** Snapshot comparison period labels for portfolio cards */
export const PERIOD_LABELS = {
  "24h": "vs yesterday",
  "7d": "vs 7 days ago",
  "30d": "vs 30 days ago",
  "1y": "vs 1 year ago",
} as const;
