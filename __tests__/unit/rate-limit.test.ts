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

import { NextRequest } from "next/server";
import { rateLimit } from "@/lib/rate-limit";

function makeReq(ip = "127.0.0.1") {
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

  it("returns Retry-After header when rate limited", () => {
    const check = rateLimit({ windowMs: 120_000, max: 1 });
    check(makeReq()); // 1 — allowed
    const result = check(makeReq()); // 2 — blocked
    expect(result).not.toBeNull();
    expect(result?.headers).toBeDefined();
    expect((result as { headers: Record<string, string> }).headers["Retry-After"]).toBe(
      String(Math.ceil(120_000 / 1000)),
    );
  });

  it("requests with no x-forwarded-for share the 'unknown' bucket", () => {
    const check = rateLimit({ windowMs: 60_000, max: 1 });
    const noIpReq = () =>
      new NextRequest("http://localhost/api/test", { headers: {} });
    expect(check(noIpReq())).toBeNull(); // 1 — allowed
    expect(check(noIpReq())).not.toBeNull(); // 2 — blocked (same "unknown" bucket)
  });

  it("multi-IP header uses only first IP for bucketing", () => {
    const check = rateLimit({ windowMs: 60_000, max: 1 });
    const multiIpReq = () =>
      new NextRequest("http://localhost/api/test", {
        headers: { "x-forwarded-for": "10.0.0.1, 192.168.1.1" },
      });
    expect(check(multiIpReq())).toBeNull(); // 1 — allowed
    expect(check(multiIpReq())).not.toBeNull(); // 2 — blocked (keyed on "10.0.0.1")
    // Different first IP should be a separate bucket
    const differentFirstIp = new NextRequest("http://localhost/api/test", {
      headers: { "x-forwarded-for": "10.0.0.2, 192.168.1.1" },
    });
    expect(check(differentFirstIp)).toBeNull(); // allowed — different bucket
  });
});
