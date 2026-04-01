// ─── Shared constants across the app ─────────────────────────

/** Valid theme identifiers — derived from themes.ts, shared by profile validation + import validation */
export { THEME_IDS as VALID_THEMES } from "@/lib/themes";

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

/** Maximum share/invite expiry in days (~10 years) */
export const MAX_SHARE_EXPIRY_DAYS = 3650;

/** Upper bound for paginated Supabase queries (prevents unbounded scans) */
export const MAX_QUERY_LIMIT = 10_000;

/** Snapshot comparison period labels for portfolio cards */
export const PERIOD_LABELS = {
  "24h": "vs yesterday",
  "7d": "vs 7 days ago",
  "30d": "vs 30 days ago",
  "1y": "vs 1 year ago",
} as const;

/** Valid entity type strings for activity log filtering */
export const VALID_ENTITY_TYPES = [
  "crypto_asset", "stock_asset", "wallet", "broker",
  "bank_account", "exchange_deposit", "crypto_position",
  "stock_position", "broker_deposit", "diary_entry", "goal_price",
  "trade_entry", "institution", "cash_account",
] as const;

/** Valid action strings for activity log filtering */
export const VALID_ACTIONS = ["created", "updated", "removed", "undone"] as const;
