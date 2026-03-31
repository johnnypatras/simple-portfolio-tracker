import { NextRequest, NextResponse } from "next/server";

interface RateLimitOptions {
  windowMs: number;
  max: number;
}

/**
 * In-memory sliding-window rate limiter keyed by client IP.
 * Returns a function that checks the limit and returns a 429 response
 * if exceeded, or null if the request is allowed.
 */
export function rateLimit({ windowMs, max }: RateLimitOptions): (req: NextRequest) => NextResponse | null {
  const hits = new Map<string, number[]>();
  let lastPurge = Date.now();

  return function check(req: NextRequest): NextResponse | null {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const now = Date.now();

    // Lazy purge: clean this key's stale entries
    const existing = hits.get(ip);
    if (existing) {
      const fresh = existing.filter((t) => now - t < windowMs);
      if (fresh.length === 0) hits.delete(ip);
      else hits.set(ip, fresh);
    }

    // Full purge every 60s (piggyback on check calls)
    if (now - lastPurge > 60_000) {
      lastPurge = now;
      for (const [key, ts] of hits) {
        const fresh = ts.filter((t) => now - t < windowMs);
        if (fresh.length === 0) hits.delete(key);
        else hits.set(key, fresh);
      }
    }

    const timestamps = hits.get(ip) ?? [];
    timestamps.push(now);
    hits.set(ip, timestamps);

    if (timestamps.length > max) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(windowMs / 1000)),
          },
        }
      );
    }

    return null;
  };
}
