import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Unit tests for /api/health (src/app/api/health/route.ts).
 *
 * The route uses createAdminClient to run 3 parallel probes:
 *   1. portfolio_snapshots ORDER BY created_at DESC LIMIT 1 .single()
 *   2. manual_nav_updates SELECT id LIMIT 1
 *   3. RPC get_latest_manual_navs_at(p_as_of, p_user_id)
 *
 * Strategy: mock `createAdminClient` to return a fake client whose `.from()`
 * and `.rpc()` chains return preset results. Inspect the NextResponse body
 * to assert the route's branching logic.
 */

// ─── Hoisted mock state ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  // Result for each probe — set per-test. `null` error means success.
  snapshotResult: { data: null as { snapshot_date: string; created_at: string } | null, error: null as { message: string } | null },
  navTableResult: { data: null as Array<{ id: string }> | null, error: null as { message: string } | null },
  navRpcResult: { data: null as Array<unknown> | null, error: null as { message: string } | null },
}));

// ─── Mock query/RPC chain ────────────────────────────────────────────────────
function chain(resolveValue: unknown) {
  const obj: Record<string, unknown> & PromiseLike<unknown> = {
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockReturnThis(),
    abortSignal: vi.fn().mockReturnThis(),
    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(resolveValue).then(onfulfilled, onrejected) as PromiseLike<TResult1 | TResult2>;
    },
  };
  return obj;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === "portfolio_snapshots") return chain(hoisted.snapshotResult);
      if (table === "manual_nav_updates") return chain(hoisted.navTableResult);
      return chain({ data: null, error: null });
    }),
    rpc: vi.fn(() => chain(hoisted.navRpcResult)),
  })),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────
import { GET } from "@/app/api/health/route";

// ─── Helpers ────────────────────────────────────────────────────────────────
async function parseBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const FRESH_SNAPSHOT = {
  snapshot_date: new Date().toISOString().split("T")[0],
  // 5h ago — within the 26h threshold
  created_at: new Date(Date.now() - 5 * 3_600_000).toISOString(),
};
const STALE_SNAPSHOT = {
  snapshot_date: new Date(Date.now() - 30 * 3_600_000).toISOString().split("T")[0],
  // 30h ago — past the 26h threshold
  created_at: new Date(Date.now() - 30 * 3_600_000).toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.snapshotResult = { data: FRESH_SNAPSHOT, error: null };
  hoisted.navTableResult = { data: [], error: null };
  hoisted.navRpcResult = { data: [], error: null };
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("/api/health — happy path", () => {
  it("returns status='ok' with all probes healthy and fresh snapshot", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await parseBody(res);
    expect(body.status).toBe("ok");
    expect(body.snapshotStale).toBe(false);
    expect(body.navPipeline).toBe("ok");
    expect(body.navTable).toBe("ok");
    expect(body.navRpc).toBe("ok");
    expect(body.snapshotAgeHours).toBe(5);
    expect(body.snapshotDate).toBe(FRESH_SNAPSHOT.snapshot_date);
  });

  it("computes snapshotAgeHours from created_at, NOT snapshot_date (PR #80 fix)", async () => {
    // Snapshot covering yesterday's date but written 2h ago — the PR #80
    // regression we fixed. snapshot_date-based age would report ~24h+;
    // created_at-based age reports 2h.
    hoisted.snapshotResult = {
      data: {
        snapshot_date: new Date(Date.now() - 24 * 3_600_000).toISOString().split("T")[0],
        created_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      },
      error: null,
    };
    const res = await GET();
    const body = await parseBody(res);
    expect(body.snapshotAgeHours).toBe(2);
    expect(body.snapshotStale).toBe(false);
  });
});

describe("/api/health — staleness threshold", () => {
  it("returns status='warning' + snapshotStale=true when age > 26h", async () => {
    hoisted.snapshotResult = { data: STALE_SNAPSHOT, error: null };
    const res = await GET();
    expect(res.status).toBe(200); // staleness is a warning, not a failure
    const body = await parseBody(res);
    expect(body.status).toBe("warning");
    expect(body.snapshotStale).toBe(true);
    expect(body.snapshotAgeHours).toBe(30);
  });
});

describe("/api/health — primary probe failure (503)", () => {
  it("returns 503 + status='degraded' when snapshot probe errors", async () => {
    hoisted.snapshotResult = { data: null, error: { message: "connection lost" } };
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await parseBody(res);
    expect(body.status).toBe("degraded");
    expect(body.error).toBe("db_query_failed");
  });
});

describe("/api/health — NAV pipeline degradation", () => {
  it("status='warning' + navPipeline='degraded' when manual_nav_updates probe fails (snapshot still healthy)", async () => {
    hoisted.navTableResult = { data: null, error: { message: "permission denied" } };
    const res = await GET();
    // Critical isolation property: NAV degradation does NOT 503 the route —
    // the snapshot pipeline is still healthy so 503 would mislead operators.
    expect(res.status).toBe(200);
    const body = await parseBody(res);
    expect(body.status).toBe("warning");
    expect(body.navPipeline).toBe("degraded");
    expect(body.navTable).toBe("degraded");
    expect(body.navRpc).toBe("ok");
    // The snapshot signal must stay clean and visible.
    expect(body.snapshotStale).toBe(false);
  });

  it("navPipeline='degraded' when only the RPC probe fails", async () => {
    hoisted.navRpcResult = { data: null, error: { message: "function does not exist" } };
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await parseBody(res);
    expect(body.status).toBe("warning");
    expect(body.navTable).toBe("ok");
    expect(body.navRpc).toBe("degraded");
  });

  it("navPipeline='ok' when both NAV probes succeed (even with empty results)", async () => {
    // Empty arrays/results from the probes are NOT failures — proves the
    // table and RPC are accessible, just no data for the sentinel user.
    hoisted.navTableResult = { data: [], error: null };
    hoisted.navRpcResult = { data: [], error: null };
    const res = await GET();
    const body = await parseBody(res);
    expect(body.navPipeline).toBe("ok");
  });
});
