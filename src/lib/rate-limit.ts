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
export function rateLimit({ windowMs, max }: RateLimitOptions) {
  const hits = new Map<string, number[]>();

  // Periodically purge stale entries to prevent memory leaks
  setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits) {
      const valid = timestamps.filter((t) => now - t < windowMs);
      if (valid.length === 0) hits.delete(key);
      else hits.set(key, valid);
    }
  }, 60_000).unref();

  return function check(req: NextRequest): NextResponse | null {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const now = Date.now();

    const timestamps = hits.get(ip) ?? [];
    const valid = timestamps.filter((t) => now - t < windowMs);
    valid.push(now);
    hits.set(ip, valid);

    if (valid.length > max) {
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
