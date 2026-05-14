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

/** Upper bound for full snapshot history queries (dashboards, share, export) */
export const MAX_SNAPSHOTS_LIMIT = 100_000;

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
  "manual_nav_update",
] as const;

/** Valid action strings for activity log filtering */
export const VALID_ACTIONS = ["created", "updated", "removed", "undone"] as const;

/** Valid wallet_type strings (matches TypeScript union + DB CHECK) */
export const VALID_WALLET_TYPES = ["custodial", "non_custodial"] as const;

/** Maximum length for user-supplied free-text label fields (chain, network, subcategory, etc.) */
export const MAX_LABEL_LENGTH = 50;

/** Maximum length for user-supplied name fields (entity names, asset names) */
export const MAX_NAME_LENGTH = 100;

/** Maximum length for trade/diary notes */
export const MAX_NOTES_LENGTH = 2000;

/** Maximum length for diary entry content */
export const MAX_DIARY_CONTENT_LENGTH = 50_000;

/**
 * Maximum length for `manual_nav_updates.note` (provenance text like
 * "Q1 2026 fund letter"). Shorter than MAX_NOTES_LENGTH (2000) because NAV
 * notes are intentionally brief metadata, not free-form trade-style notes.
 * Enforced by validateName at server-action boundary AND by DB CHECK in
 * migration 018.
 */
export const MAX_NAV_NOTE_LENGTH = 500;

/**
 * Days threshold for surfacing a manual NAV as "stale" — used by the
 * StaleNavBanner, the per-row staleness label in stock-columns, and the
 * UpdateNavModal header. Quarterly NAV publishing cadence implies
 * ~90 days between updates; 45 fires the warning when a NAV is meaningfully
 * overdue without being a hair-trigger.
 */
export const STALE_NAV_DAYS_THRESHOLD = 45;

/**
 * Current backup schema version emitted by export.
 * v5 (2026-05) — adds `manualNavUpdates` array + `kind` field on stockAssets.
 * v4 — adds `network` field on crypto_positions.
 * v3 — unified `cashAccounts` (replaces legacy bankAccounts/exchangeDeposits/brokerDeposits).
 * v1/v2 — legacy split-cash schema.
 */
export const CURRENT_BACKUP_VERSION = 5 as const;
export const SUPPORTED_BACKUP_VERSIONS = [1, 2, 3, 4, 5] as const;
export type SupportedBackupVersion = (typeof SUPPORTED_BACKUP_VERSIONS)[number];

/** Minimum backup schema version that uses unified cash_accounts (v1/v2 use legacy arrays) */
export const UNIFIED_CASH_MIN_VERSION = 3 as const;

/** Default page size for the activity log listing. */
export const ACTIVITY_LOG_DEFAULT_LIMIT = 50;

/** Hard cap on activity log page size — prevents runaway `?limit=1000000` queries. */
export const ACTIVITY_LOG_MAX_LIMIT = 500;

/**
 * Minimum absolute value (in base currency) to surface in crypto/stocks/cash
 * breakdown tooltips. Entries below this are noise — filtered to keep the
 * tooltip readable. Applies to dashboard-changes, dashboard-insights, and
 * the comparison delta helper.
 */
export const MIN_BREAKDOWN_DISPLAY_VALUE = 0.5;
