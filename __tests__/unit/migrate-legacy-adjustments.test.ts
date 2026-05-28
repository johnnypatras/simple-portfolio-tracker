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
    hoisted.toggleActivityAdjustment.mockResolvedValue(undefined);
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
      errors: 0,
      details: [],
    });
    expect(hoisted.toggleActivityAdjustment).not.toHaveBeenCalled();
  });

  it("calls toggleActivityAdjustment(id, false) per row", async () => {
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
    expect(result.errors).toBe(0);
    expect(result.details).toHaveLength(3);
    expect(result.details[0]).toEqual({
      id: "id-1",
      entity_type: "crypto_position",
      entity_name: "BTC pos",
      status: "migrated",
    });
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
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Yahoo no price history"))
      .mockResolvedValueOnce(undefined);

    const result = await migrateLegacyAdjustmentFlags();

    expect(hoisted.toggleActivityAdjustment).toHaveBeenCalledTimes(3);
    expect(result.total_candidates).toBe(3);
    expect(result.migrated).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.details).toHaveLength(3);
    expect(result.details[0].status).toBe("migrated");
    expect(result.details[1]).toEqual({
      id: "id-2",
      entity_type: "stock_position",
      entity_name: "AAPL pos",
      status: "error",
      error_message: "Yahoo no price history",
    });
    expect(result.details[2].status).toBe("migrated");
  });

  it("captures non-Error thrown values as string error_message", async () => {
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
    expect(result.details[0].error_message).toBe("string error");
  });

  it("applies the EXACT filter (user, action=created, is_adjustment=true, transfer_group_id NULL, undone_at NULL, 6 entity types) + .order by created_at asc", async () => {
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
    const orderCalls = recorded.filter((c) => c.method === "order");
    expect(orderCalls).toHaveLength(1);
    expect(orderCalls[0].args).toEqual(["created_at", { ascending: true }]);
  });

  it("throws when the initial DB query fails", async () => {
    hoisted.mockClient = createMockClient([
      { data: null, error: { message: "DB unavailable" } },
    ]);
    await expect(migrateLegacyAdjustmentFlags()).rejects.toThrow("DB unavailable");
  });
});
