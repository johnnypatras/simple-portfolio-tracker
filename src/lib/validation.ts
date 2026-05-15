/**
 * Input validation helpers for server actions.
 * All validators throw descriptive errors that surface in UI toasts.
 */

import { MAX_NAME_LENGTH } from "@/lib/constants";

const MAX_AMOUNT = 1_000_000_000; // 1 billion — sanity cap

export function validateAmount(n: number, label = "Amount"): void {
  if (!Number.isFinite(n)) throw new Error(`${label} must be a valid number`);
  if (n < 0) throw new Error(`${label} cannot be negative`);
  if (n > MAX_AMOUNT) throw new Error(`${label} is unreasonably large`);
}

export function validateQuantity(n: number, label = "Quantity"): void {
  if (!Number.isFinite(n)) throw new Error(`${label} must be a valid number`);
  if (n < 0) throw new Error(`${label} must not be negative`);
  if (n > MAX_AMOUNT) throw new Error(`${label} is unreasonably large`);
}

const CURRENCY_RE = /^[A-Z]{3}$/;

export function validateCurrency(s: string): void {
  if (!CURRENCY_RE.test(s)) {
    throw new Error(`Invalid currency code: "${s}" (expected 3-letter ISO 4217)`);
  }
}

export function validateName(s: string, maxLen = MAX_NAME_LENGTH, label = "Name"): void {
  const trimmed = s.trim();
  if (trimmed.length === 0) throw new Error(`${label} cannot be empty`);
  if (trimmed.length > maxLen) {
    throw new Error(`${label} is too long (max ${maxLen} characters)`);
  }
}

/**
 * Validate and normalize a tag array. Each tag is trimmed and must be
 * a non-empty string ≤ 50 chars. Returns the normalized array; empty
 * strings are filtered out. Throws on oversized or non-string elements.
 */
export function validateTags(tags: unknown, maxPerTag = 50, maxCount = 20): string[] {
  if (tags == null) return [];
  if (!Array.isArray(tags)) throw new Error("Tags must be an array");
  if (tags.length > maxCount) throw new Error(`Too many tags (max ${maxCount})`);
  const result: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string") throw new Error("Each tag must be a string");
    const trimmed = t.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > maxPerTag) {
      throw new Error(`Tag is too long (max ${maxPerTag} characters)`);
    }
    result.push(trimmed);
  }
  return result;
}

// CoinGecko IDs: lowercase alphanumeric, hyphens, digits (e.g., "bitcoin", "usd-coin", "0x-protocol")
const COINGECKO_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export function validateCoinGeckoId(s: string): void {
  if (!s || s.length > 100) throw new Error("CoinGecko ID is invalid");
  if (!COINGECKO_ID_RE.test(s)) {
    throw new Error(`CoinGecko ID contains invalid characters: "${s}"`);
  }
}

// Yahoo tickers: alphanumeric, dots, hyphens, carets, equals (e.g., "AAPL", "VUSA.AS", "^GSPC", "EURUSD=X")
const YAHOO_TICKER_RE = /^[A-Z0-9][A-Z0-9.^=-]*$/;

export function validateYahooTicker(s: string): void {
  if (!s || s.length > 20) throw new Error("Yahoo ticker is invalid");
  if (!YAHOO_TICKER_RE.test(s)) {
    throw new Error(`Yahoo ticker contains invalid characters: "${s}"`);
  }
}

export function validateDate(s: string, label = "Date"): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${label} must be YYYY-MM-DD format`);
  // Regex matches "2026-13-99" or "2026-02-30" — both are invalid calendar
  // dates. Parse and verify components round-trip to catch these.
  const [yStr, mStr, dStr] = s.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    throw new Error(`${label} is not a valid calendar date: "${s}"`);
  }
}

/**
 * Like `validateDate` but additionally rejects future dates. Use for fields
 * that have today-or-past semantics: NAV effective dates (fund letters are
 * always published for a date <= today), backdated trade dates, snapshot
 * dates, transfer effective dates. The comparison uses UTC midnight to match
 * the DATE column's storage semantics so a same-day-different-timezone entry
 * doesn't trip.
 */
export function validatePastOrTodayDate(s: string, label = "Date"): void {
  validateDate(s, label);
  const [yStr, mStr, dStr] = s.split("-");
  const inputMs = Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr));
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (inputMs > todayMs) {
    throw new Error(`${label} cannot be in the future: "${s}"`);
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUUID(s: string, label = "ID"): void {
  if (!UUID_RE.test(s)) {
    throw new Error(`${label} is not a valid UUID`);
  }
}

export function validateApy(n: number, label = "APY"): void {
  if (!Number.isFinite(n)) throw new Error(`${label} must be a valid number`);
  if (n < 0 || n > 100) throw new Error(`${label} must be between 0 and 100`);
}

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{10}$/;

export function validateIsin(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim().toUpperCase();
  if (!ISIN_RE.test(trimmed)) {
    throw new Error("ISIN must be 12 alphanumeric characters starting with a 2-letter country code");
  }
  return trimmed;
}

const ALLOWED_IMAGE_ORIGINS = new Set([
  "https://assets.coingecko.com",
  "https://coin-images.coingecko.com",
]);

export function validateImageUrl(s: string | null | undefined): string | null {
  if (!s) return null;
  try {
    const url = new URL(s);
    // Compare parsed `origin` (not `href.startsWith(...)`) to reject subdomain
    // spoofing like `https://assets.coingecko.com.evil.com/image.png`.
    // Also forbid non-https protocols (rejects javascript:, data:, etc.).
    if (url.protocol !== "https:") return null;
    if (!ALLOWED_IMAGE_ORIGINS.has(url.origin)) return null;
    return url.toString();
  } catch {
    return null;
  }
}
