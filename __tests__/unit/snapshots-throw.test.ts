import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for saveSnapshot() error propagation in snapshots.ts.
 *
 * Verifies that a DB upsert failure throws instead of silently swallowing
 * the error (behavior introduced during the audit).
 */

// ─── Hoisted mock state ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({ testClient: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.testClient),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Sentry is a side-effect in saveSnapshot — stub it out
vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
}));

// ─── Import after mocks ──────────────────────────────────────────────────────
import { saveSnapshot } from "@/lib/actions/snapshots";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal valid snapshot payload — component sum matches total. */
const VALID_PAYLOAD = {
  totalValueUsd: 10000,
  totalValueEur: 9200,
  cryptoValueUsd: 5000,
  stocksValueUsd: 3000,
  cashValueUsd: 2000,
  cryptoValueEur: 4600,
  stocksValueEur: 2760,
  cashValueEur: 1840,
  stocksHomeCurrencyEur: 2760,
  cashHomeCurrencyEur: 1840,
};

/**
 * Builds a minimal fake Supabase client where:
 * - auth.getUser() resolves to a logged-in user
 * - the first .from() call (previous snapshot fetch) returns the given prev data
 * - the second .from() call (upsert) returns the given result
 */
function makeClient(
  upsertResult: { error: { message: string } | null },
  prevSnapshotData: { total_value_usd: number; snapshot_date: string } | null = null
) {
  let callIndex = 0;

  const prevSnapshotBuilder = {
    select: vi.fn().mockReturnThis(),
    // .eq("user_id", user.id) added in audit R1 Phase 4 for defense-in-depth
    eq: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: prevSnapshotData, error: null }),
  };

  const upsertBuilder = {
    upsert: vi.fn().mockResolvedValue(upsertResult),
  };

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user1" } },
        error: null,
      }),
    },
    from: vi.fn(() => {
      const index = callIndex++;
      // call 0: .from("portfolio_snapshots").select(...).lt(...).order(...).limit(...).maybeSingle()
      // call 1: .from("portfolio_snapshots").upsert(...)
      return index === 0 ? prevSnapshotBuilder : upsertBuilder;
    }),
    prevSnapshotBuilder,
    upsertBuilder,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("saveSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws with the DB error message when upsert fails", async () => {
    hoisted.testClient = makeClient({
      error: { message: "DB error" },
    });

    await expect(saveSnapshot(VALID_PAYLOAD)).rejects.toThrow("DB error");
  });

  it("throws an Error instance (not a raw string)", async () => {
    hoisted.testClient = makeClient({
      error: { message: "connection timeout" },
    });

    await expect(saveSnapshot(VALID_PAYLOAD)).rejects.toBeInstanceOf(Error);
  });

  it("error message includes 'Failed to save snapshot'", async () => {
    hoisted.testClient = makeClient({
      error: { message: "unique constraint violated" },
    });

    await expect(saveSnapshot(VALID_PAYLOAD)).rejects.toThrow(
      "Failed to save snapshot"
    );
  });

  it("resolves without throwing when upsert succeeds", async () => {
    hoisted.testClient = makeClient({ error: null });

    await expect(saveSnapshot(VALID_PAYLOAD)).resolves.toBeUndefined();
  });

  it("returns early without DB call when user is null", async () => {
    const client = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: null,
        }),
      },
      from: vi.fn(),
    };
    hoisted.testClient = client;

    await expect(saveSnapshot(VALID_PAYLOAD)).resolves.toBeUndefined();
    expect(client.from).not.toHaveBeenCalled();
  });

  it("skips upsert when totalValueUsd=0 and a previous non-zero snapshot exists", async () => {
    const prevSnapshot = {
      total_value_usd: 50000,
      snapshot_date: "2025-01-01",
    };
    const client = makeClient({ error: null }, prevSnapshot);
    hoisted.testClient = client;

    const zeroPayload = {
      ...VALID_PAYLOAD,
      totalValueUsd: 0,
      totalValueEur: 0,
      cryptoValueUsd: 0,
      stocksValueUsd: 0,
      cashValueUsd: 0,
      cryptoValueEur: 0,
      stocksValueEur: 0,
      cashValueEur: 0,
      stocksHomeCurrencyEur: 0,
      cashHomeCurrencyEur: 0,
    };

    await expect(saveSnapshot(zeroPayload)).resolves.toBeUndefined();

    // The first .from() call (maybeSingle) must have been made to check prev snapshot
    expect(client.prevSnapshotBuilder.maybeSingle).toHaveBeenCalled();
    // The second .from() call (upsert) must NOT have been reached
    expect(client.upsertBuilder.upsert).not.toHaveBeenCalled();
  });
});
