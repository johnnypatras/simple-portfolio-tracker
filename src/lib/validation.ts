/**
 * Input validation helpers for server actions.
 * All validators throw descriptive errors that surface in UI toasts.
 */

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

export function validateName(s: string, maxLen = 100, label = "Name"): void {
  const trimmed = s.trim();
  if (trimmed.length === 0) throw new Error(`${label} cannot be empty`);
  if (trimmed.length > maxLen) {
    throw new Error(`${label} is too long (max ${maxLen} characters)`);
  }
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
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUUID(s: string, label = "ID"): void {
  if (!UUID_RE.test(s)) {
    throw new Error(`${label} is not a valid UUID`);
  }
}
