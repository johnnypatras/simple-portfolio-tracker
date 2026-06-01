import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Unit tests for migrate-legacy-adjustments.ts.
 *
 * Strategy: mock `createServerSupabaseClient` + `toggleActivityAdjustment`
 * + `captureAction` so we can verify the query filter and the per-row loop
 * without touching real Supabase. The mock query builder records each
 * filter call so we can assert the EXACT filter shape — protecting against
 * the regression where `transfer_group_id IS NULL` was omitted and
 * transfer destinations got swept into the migration.
 */

// ─── Hoisted mock state ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  mockClient: null as ReturnType<typeof createMockClient> | null,
  toggleActivityAdjustment: vi.fn(),
  revalidateDashboard: vi.fn(),
}));

// ─── Mock query builder that records filter calls ────────────────────────────
type FilterCall = {
  method: "eq" | "is" | "in" | "order";
  args: unknown[];
};

function createQueryBuilder(
  resolveValue: { data: unknown; error: unknown },
  recorded: FilterCall[],
) {
  const builder: Record<string, unknown> & PromiseLike<unknown> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn((...args: unknown[]) => {
      recorded.push({ method: "eq", args });
      return builder;
    }),
    is: vi.fn((...args: unknown[]) => {
      recorded.push({ method: "is", args });
      return builder;
    }),
    in: vi.fn((...args: unknown[]) => {
      recorded.push({ method: "in", args });
      return builder;
    }),
    order: vi.fn((...args: unknown[]) => {
      recorded.push({ method: "order", args });
      return builder;
    }),
    range: vi.fn().mockReturnThis(),
    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(resolveValue).then(onfulfilled, onrejected) as PromiseLike<
        TResult1 | TResult2
      >;
    },
  };
  return builder;
}

function createMockClient(
  fromCalls: Array<{ data: unknown; error: unknown }>,
  opts?: { user?: { id: string } | null },
) {
  let callIndex = 0;
  const recorded: FilterCall[][] = [];
  return {
    from: vi.fn(() => {
      const result = fromCalls[callIndex] ?? { data: null, error: null };
      const calls: FilterCall[] = [];
      recorded.push(calls);
      callIndex++;
      return createQueryBuilder(result, calls);
    }),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: opts?.user === undefined ? { id: "user-123" } : opts.user },
        error: null,
      }),
    },
    _recorded: recorded,
  };
}

// ─── Module mocks ────────────────────────────────────────────────────────────
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.mockClient),
}));

vi.mock("@/lib/actions/activity-log", () => ({
  toggleActivityAdjustment: hoisted.toggleActivityAdjustment,
}));

vi.mock("@/lib/actions/revalidate", () => ({
  revalidateDashboard: hoisted.revalidateDashboard,
}));

// captureAction just invokes the wrapped fn — bypassing Sentry.
vi.mock("@/lib/actions/with-sentry", () => ({
  captureAction: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));

// Stub Sentry — addBreadcrumb + captureException are called inside the action.
vi.mock("@sentry/nextjs", () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────
import {
  migrateLegacyAdjustmentFlags,
  previewLegacyAdjustmentMigration,
} from "@/lib/actions/migrate-legacy-adjustments";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("previewLegacyAdjustmentMigration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when no authenticated user", async () => {
    hoisted.mockClient = createMockClient([], { user: null });
    await expect(previewLegacyAdjustmentMigration()).rejects.toThrow("Not authenticated");
  });

  it("returns count + by_entity_type breakdown", async () => {
    hoisted.mockClient = createMockClient([
      {
        data: [
          { entity_type: "crypto_position" },
          { entity_type: "crypto_position" },
          { entity_type: "stock_position" },
          { entity_type: "cash_account" },
        ],
        error: null,
      },
    ]);
    const result = await previewLegacyAdjustmentMigration();
    expect(result.count).toBe(4);
    expect(result.by_entity_type).toEqual({
      crypto_position: 2,
      stock_position: 1,
      cash_account: 1,
    });
  });

  it("returns 0/{} when no candidates", async () => {
    hoisted.mockClient = createMockClient([{ data: [], error: null }]);
    const result = await previewLegacyAdjustmentMigration();
    expect(result.count).toBe(0);
    expect(result.by_entity_type).toEqual({});
  });

  it("throws when the DB query fails", async () => {
    hoisted.mockClient = createMockClient([
      { data: null, error: { message: "connection lost" } },
    ]);
    await expect(previewLegacyAdjustmentMigration()).rejects.toThrow("connection lost");
  });

  it("applies the EXACT filter (user, action=created, is_adjustment=true, transfer_group_id NULL, undone_at NULL, 6 entity types)", async () => {
    const mock = createMockClient([{ data: [], error: null }]);
    hoisted.mockClient = mock;
    await previewLegacyAdjustmentMigration();

    const recorded = mock._recorded[0];
    // .eq calls: user_id, action, is_adjustment
    const eqCalls = recorded.filter((c) => c.method === "eq");
    expect(eqCalls).toEqual([
      { method: "eq", args: ["user_id", "user-123"] },
      { method: "eq", args: ["action", "created"] },
      { method: "eq", args: ["is_adjustment", true] },
    ]);
    // .is calls: transfer_group_id NULL, undone_at NULL — CRITICAL filter
    const isCalls = recorded.filter((c) => c.method === "is");
    expect(isCalls).toEqual([
      { method: "is", args: ["transfer_group_id", null] },
      { method: "is", args: ["undone_at", null] },
    ]);
    // .in: 6 entity types
    const inCalls = recorded.filter((c) => c.method === "in");
    expect(inCalls).toHaveLength(1);
    expect(inCalls[0].args[0]).toBe("entity_type");
    expect(inCalls[0].args[1]).toEqual([
      "crypto_position",
      "stock_position",
      "cash_account",
      "bank_account",
      "exchange_deposit",
      "broker_deposit",
    ]);
  });
});

describe("migrateLegacyAdjustmentFlags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // toggleActivityAdjustment returns { status, changed } (R2-4/F3).
    // A successful real toggle-OFF lands status 'complete', changed true.
    hoisted.toggleActivityAdjustment.mockResolvedValue({ status: "complete", changed: true });
  });

  it("throws when no authenticated user", async () => {
    hoisted.mockClient = createMockClient([], { user: null });
    await expect(migrateLegacyAdjustmentFlags()).rejects.toThrow("Not authenticated");
  });

  it("returns empty result when no candidates", async () => {
    hoisted.mockClient = createMockClient([{ data: [], error: null }]);
    const result = await migrateLegacyAdjustmentFlags();
    expect(result).toEqual({
      total_candidates: 0,
      migrated: 0,
      pending: 0,
      skipped: 0,
      errors: 0,
      remaining: 0,
      details: [],
    });
    expect(hoisted.toggleActivityAdjustment).not.toHaveBeenCalled();
    expect(hoisted.revalidateDashboard).not.toHaveBeenCalled();
  });

  it("calls toggleActivityAdjustment(id, false) per row; successes are counted (not enumerated) and remaining=0", async () => {
    hoisted.mockClient = createMockClient([
      {
        data: [
          { id: "id-1", entity_type: "crypto_position", entity_name: "BTC pos" },
          { id: "id-2", entity_type: "stock_position", entity_name: "AAPL pos" },
          { id: "id-3", entity_type: "cash_account", entity_name: "EUR cash" },
        ],
        error: null,
      },
    ]);
    const result = await migrateLegacyAdjustmentFlags();

    expect(hoisted.toggleActivityAdjustment).toHaveBeenCalledTimes(3);
    expect(hoisted.toggleActivityAdjustment).toHaveBeenNthCalledWith(1, "id-1", false);
    expect(hoisted.toggleActivityAdjustment).toHaveBeenNthCalledWith(2, "id-2", false);
    expect(hoisted.toggleActivityAdjustment).toHaveBeenNthCalledWith(3, "id-3", false);

    expect(result.total_candidates).toBe(3);
    expect(result.migrated).toBe(3);
    // All three priced cleanly ('complete') → none pending.
    expect(result.pending).toBe(0);
    // All three were real flips by this run → none skipped.
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    // Budget was never hit (loop ran to completion) → no un-attempted rows.
    expect(result.remaining).toBe(0);
    // details holds ERROR rows only — successful migrations are counted, not listed.
    expect(result.details).toHaveLength(0);
    expect(hoisted.revalidateDashboard).toHaveBeenCalledOnce();
  });

  it("counts a row whose toggle returns 'pending' in BOTH migrated and the pending subset (R2-4)", async () => {
    hoisted.mockClient = createMockClient([
      {
        data: [
          { id: "id-1", entity_type: "crypto_position", entity_name: "BTC pos" },
          { id: "id-2", entity_type: "stock_position", entity_name: "AAPL pos" },
          { id: "id-3", entity_type: "cash_account", entity_name: "EUR cash" },
        ],
        error: null,
      },
    ]);
    // Row 2's price fetch failed inside toggleActivityAdjustment: the flag
    // flipped (no throw) but cashflow_status landed 'pending'. The other two
    // priced cleanly ('complete').
    hoisted.toggleActivityAdjustment
      .mockResolvedValueOnce({ status: "complete", changed: true })
      .mockResolvedValueOnce({ status: "pending", changed: true })
      .mockResolvedValueOnce({ status: "complete", changed: true });

    const result = await migrateLegacyAdjustmentFlags();

    expect(hoisted.toggleActivityAdjustment).toHaveBeenCalledTimes(3);
    expect(result.total_candidates).toBe(3);
    // All three flags flipped → all three migrated (pending is a SUBSET, not
    // a separate bucket — the row IS migrated, just not yet benchmark-visible).
    expect(result.migrated).toBe(3);
    expect(result.pending).toBe(1);
    // All three were real flips → none skipped.
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.remaining).toBe(0);
    // Pending is NOT an error — no details, no error tally.
    expect(result.details).toHaveLength(0);
    // Rows migrated → revalidation still fires.
    expect(hoisted.revalidateDashboard).toHaveBeenCalledOnce();
  });

  it("counts a no-op idempotent return (changed:false) as skipped, NOT migrated (F3 inflation guard)", async () => {
    hoisted.mockClient = createMockClient([
      {
        data: [{ id: "id-1", entity_type: "cash_account", entity_name: "EUR cash" }],
        error: null,
      },
    ]);
    // A concurrent run already flipped this row → toggleActivityAdjustment's M1
    // early-return reports the row's current status with changed:false. This run
    // did NOT perform the flip, so it must land in `skipped`, never `migrated` —
    // otherwise two concurrent runs would both claim it and the counts inflate
    // beyond total_candidates (the F3 count-inflation race).
    hoisted.toggleActivityAdjustment.mockResolvedValueOnce({ status: "complete", changed: false });

    const result = await migrateLegacyAdjustmentFlags();
    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.pending).toBe(0);
    expect(result.errors).toBe(0);
    // The four counts still partition the candidate set exactly.
    expect(result.remaining).toBe(0);
    expect(result.total_candidates).toBe(1);
  });

  it("per-row error does not abort loop — other rows still migrate", async () => {
    hoisted.mockClient = createMockClient([
      {
        data: [
          { id: "id-1", entity_type: "crypto_position", entity_name: "BTC pos" },
          { id: "id-2", entity_type: "stock_position", entity_name: "AAPL pos" },
          { id: "id-3", entity_type: "cash_account", entity_name: "EUR cash" },
        ],
        error: null,
      },
    ]);
    // Middle row fails — the loop must not abort.
    hoisted.toggleActivityAdjustment
      .mockResolvedValueOnce({ status: "complete", changed: true })
      .mockRejectedValueOnce(new Error("Yahoo no price history"))
      .mockResolvedValueOnce({ status: "complete", changed: true });

    const result = await migrateLegacyAdjustmentFlags();

    expect(hoisted.toggleActivityAdjustment).toHaveBeenCalledTimes(3);
    expect(result.total_candidates).toBe(3);
    expect(result.migrated).toBe(2);
    // A thrown row is an error, NOT a pending (pending = flag flipped but
    // unpriced; error = flag never flipped).
    expect(result.pending).toBe(0);
    // No idempotency no-ops in this run → none skipped.
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(1);
    // All 3 attempted → no un-attempted rows, even though one errored.
    expect(result.remaining).toBe(0);
    // details holds the single ERROR row only — entity context, no raw error.
    expect(result.details).toHaveLength(1);
    expect(result.details[0]).toEqual({
      id: "id-2",
      entity_type: "stock_position",
      entity_name: "AAPL pos",
    });
  });

  it("does NOT leak raw error text into details for non-Error throws (raw error → Sentry only)", async () => {
    hoisted.mockClient = createMockClient([
      {
        data: [{ id: "id-1", entity_type: "crypto_position", entity_name: "BTC pos" }],
        error: null,
      },
    ]);
    // Toggle throws a non-Error value (e.g. a string from a deep callee).
    hoisted.toggleActivityAdjustment.mockRejectedValueOnce("string error");
    const result = await migrateLegacyAdjustmentFlags();
    expect(result.errors).toBe(1);
    expect(result.details).toHaveLength(1);
    // Only entity context is exposed — no error_message / status field.
    expect(result.details[0]).toEqual({
      id: "id-1",
      entity_type: "crypto_position",
      entity_name: "BTC pos",
    });
  });

  it("applies the EXACT filter (user, action=created, is_adjustment=true, transfer_group_id NULL, undone_at NULL, 6 entity types) + .order by created_at asc, id asc", async () => {
    const mock = createMockClient([{ data: [], error: null }]);
    hoisted.mockClient = mock;
    await migrateLegacyAdjustmentFlags();

    const recorded = mock._recorded[0];
    const eqCalls = recorded.filter((c) => c.method === "eq");
    expect(eqCalls).toEqual([
      { method: "eq", args: ["user_id", "user-123"] },
      { method: "eq", args: ["action", "created"] },
      { method: "eq", args: ["is_adjustment", true] },
    ]);
    const isCalls = recorded.filter((c) => c.method === "is");
    expect(isCalls).toEqual([
      { method: "is", args: ["transfer_group_id", null] },
      { method: "is", args: ["undone_at", null] },
    ]);
    const inCalls = recorded.filter((c) => c.method === "in");
    expect(inCalls).toHaveLength(1);
    expect(inCalls[0].args[0]).toBe("entity_type");
    expect(inCalls[0].args[1]).toEqual([
      "crypto_position",
      "stock_position",
      "cash_account",
      "bank_account",
      "exchange_deposit",
      "broker_deposit",
    ]);
    // created_at + id tiebreaker (R2-6) — id is the stable secondary sort that
    // prevents a row from being skipped across a page boundary when many bulk-
    // imported rows share an identical created_at.
    const orderCalls = recorded.filter((c) => c.method === "order");
    expect(orderCalls).toEqual([
      { method: "order", args: ["created_at", { ascending: true }] },
      { method: "order", args: ["id", { ascending: true }] },
    ]);
  });

  it("throws when the initial DB query fails", async () => {
    hoisted.mockClient = createMockClient([
      { data: null, error: { message: "DB unavailable" } },
    ]);
    await expect(migrateLegacyAdjustmentFlags()).rejects.toThrow("DB unavailable");
  });

  it("stops attempting rows once the time budget fires and reports un-attempted rows via `remaining`", async () => {
    hoisted.mockClient = createMockClient([
      {
        data: [
          { id: "id-1", entity_type: "crypto_position", entity_name: "BTC pos" },
          { id: "id-2", entity_type: "stock_position", entity_name: "AAPL pos" },
          { id: "id-3", entity_type: "cash_account", entity_name: "EUR cash" },
        ],
        error: null,
      },
    ]);

    // Drive the wall-clock deterministically. Call sequence inside the action:
    //   1) startedAt              → 0
    //   2) iter-1 budget check    → 10        (under 40_000 → row 1 runs)
    //   3) iter-2 budget check    → 60_000    (over budget → break before row 2)
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(60_000);

    try {
      const result = await migrateLegacyAdjustmentFlags();

      // Only the first row was attempted before the budget fired.
      expect(hoisted.toggleActivityAdjustment).toHaveBeenCalledTimes(1);
      expect(hoisted.toggleActivityAdjustment).toHaveBeenCalledWith("id-1", false);
      expect(result.total_candidates).toBe(3);
      expect(result.migrated).toBe(1);
      expect(result.pending).toBe(0);
      // The one attempted row was a real flip → none skipped.
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(0);
      // 2 rows were never attempted → reported for manual Continue.
      expect(result.remaining).toBe(2);
      // 1 migrated → revalidation still fires.
      expect(hoisted.revalidateDashboard).toHaveBeenCalledOnce();
    } finally {
      nowSpy.mockRestore();
    }
  });
});
