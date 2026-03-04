import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock next/server before importing the module under test
vi.mock("next/server", () => ({
  NextRequest: class {
    headers: Map<string, string>;
    constructor(url: string, opts?: { headers?: Record<string, string> }) {
      this.headers = new Map(Object.entries(opts?.headers ?? {}));
    }
  },
  NextResponse: {
    json(
      body: unknown,
      init?: { status?: number; headers?: Record<string, string> },
    ) {
      return {
        body,
        status: init?.status ?? 200,
        headers: init?.headers ?? {},
      };
    },
  },
}));

import { rateLimit } from "@/lib/rate-limit";

function makeReq(ip = "127.0.0.1") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require("next/server") as any;
  return new NextRequest("http://localhost/api/test", {
    headers: { "x-forwarded-for": ip },
  });
}

describe("rateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows first request", () => {
    const check = rateLimit({ windowMs: 60_000, max: 5 });
    expect(check(makeReq())).toBeNull();
  });

  it("allows requests within limit", () => {
    const check = rateLimit({ windowMs: 60_000, max: 3 });
    expect(check(makeReq())).toBeNull(); // 1
    expect(check(makeReq())).toBeNull(); // 2
    expect(check(makeReq())).toBeNull(); // 3
  });

  it("blocks request exceeding limit", () => {
    const check = rateLimit({ windowMs: 60_000, max: 2 });
    check(makeReq()); // 1
    check(makeReq()); // 2
    const result = check(makeReq()); // 3 — over limit
    expect(result).not.toBeNull();
    expect(result?.status).toBe(429);
  });

  it("allows requests after window slides", () => {
    const check = rateLimit({ windowMs: 60_000, max: 2 });
    check(makeReq()); // 1
    check(makeReq()); // 2
    expect(check(makeReq())).not.toBeNull(); // 3 — blocked

    // Advance time past the window
    vi.advanceTimersByTime(61_000);
    expect(check(makeReq())).toBeNull(); // allowed again
  });

  it("tracks different IPs independently", () => {
    const check = rateLimit({ windowMs: 60_000, max: 1 });
    expect(check(makeReq("1.1.1.1"))).toBeNull();
    expect(check(makeReq("2.2.2.2"))).toBeNull();
    expect(check(makeReq("1.1.1.1"))).not.toBeNull(); // blocked
    expect(check(makeReq("2.2.2.2"))).not.toBeNull(); // blocked
  });

  it("blocks concurrent burst exceeding limit", () => {
    const check = rateLimit({ windowMs: 60_000, max: 3 });
    const results = Array.from({ length: 6 }, () => check(makeReq()));
    const allowed = results.filter((r) => r === null).length;
    const blocked = results.filter((r) => r !== null).length;
    expect(allowed).toBe(3);
    expect(blocked).toBe(3);
  });
});
