const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Wrapper around fetch that aborts after a timeout.
 * Prevents Vercel 10s function timeout from killing the entire render
 * when an upstream API (CoinGecko, Yahoo, Frankfurter) is slow or unresponsive.
 */
export async function fetchWithTimeout(
  url: string | URL | Request,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
