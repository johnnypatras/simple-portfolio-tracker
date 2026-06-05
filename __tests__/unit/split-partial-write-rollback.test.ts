import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Unit test for splits.ts — splitActivityEntry partial-write rollback (audit H2).
 *
 * The split is two non-atomic statements: INSERT children, then UPDATE the parent
 * to undone. If the parent-undo UPDATE fails after the children INSERT succeeded,
 * the parent stays live (undone_at NULL) AND its children are live →
 * deriveCashFlows double-counts the entry on every render, forever, with no
 * signal (captureAction only fires on throw; splitActivityEntry returns
 * {success:false} on this path). The fix issues a best-effort DELETE of the
 * children scoped by (split_from_id, user_id) and captures to Sentry.
 *
 * Strategy mirrors toggle-activity-adjustment.test.ts: a recording mock query
 * builder + mocked createServerSupabaseClient + with-sentry + @sentry/nextjs so
 * the real server action runs fully offline. The builder records filters and the
 * insert/delete payloads so we can assert the rollback ran with the right scope.
 */

// ─── Hoisted mock state ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  mockClient: null as ReturnType<typeof createMockClient> | null,
  captureException: vi.fn(),
  revalidateDashboard: vi.fn(),
}));

// ─── Recording mock query builder ────────────────────────────────────────────
type FilterCall = { method: "eq" | "is"; args: unknown[] };

type FromCall = {
  table: string;
  result: { data: unknown; error: unknown };
  filters: FilterCall[];
  insertPayload?: unknown;
  isInsert: boolean;
  isUpdate: boolean;
  isDelete: boolean;
};

function createQueryBuilder(call: FromCall) {
  const builder: Record<string, unknown> & PromiseLike<unknown> = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn((payload: unknown) => {
      call.isInsert = true;
      call.insertPayload = payload;
      return builder;
    }),
    update: vi.fn(() => {
      call.isUpdate = true;
      return builder;
    }),
    delete: vi.fn(() => {
      call.isDelete = true;
      return builder;
    }),
    eq: vi.fn((...args: unknown[]) => {
      call.filters.push({ method: "eq", args });
      return builder;
    }),
    is: vi.fn((...args: unknown[]) => {
      call.filters.push({ method: "is", args });
      return builder;
    }),
    single: vi.fn(() => Promise.resolve(call.result)),
    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(call.result).then(onfulfilled, onrejected) as PromiseLike<
        TResult1 | TResult2
      >;
    },
  };
  return builder;
}

/**
 * `responses` is consumed FIFO across `from()` calls — each entry models one
 * Supabase statement the action issues (parent fetch → children insert →
 * parent-undo update → rollback delete).
 */
function createMockClient(
  responses: Array<{ table: string; result: { data: unknown; error: unknown } }>,
) {
  let idx = 0;
  const fromCalls: FromCall[] = [];
  return {
    from: vi.fn((table: string) => {
      const resp = responses[idx] ?? { table, result: { data: null, error: null } };
      idx++;
      const call: FromCall = {
        table,
        result: resp.result,
        filters: [],
        isInsert: false,
        isUpdate: false,
        isDelete: false,
      };
      fromCalls.push(call);
      return createQueryBuilder(call);
    }),
    auth: {
      getUser: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: "user-123" } }, error: null }),
    },
    _fromCalls: fromCalls,
  };
}

// ─── Module mocks ────────────────────────────────────────────────────────────
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.mockClient),
}));

vi.mock("@/lib/actions/revalidate", () => ({
  revalidateDashboard: hoisted.revalidateDashboard,
}));

// captureAction just invokes the wrapped fn (preserves the action's own return).
vi.mock("@/lib/actions/with-sentry", () => ({
  captureAction: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));

// toUsdAndEur / computeDeltaFromSnapshots are imported by splits.ts; the no-cost
// path below never calls them, but the import must resolve.
vi.mock("@/lib/actions/activity-log", () => ({
  toUsdAndEur: vi.fn(),
  computeDeltaFromSnapshots: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: hoisted.captureException,
  addBreadcrumb: vi.fn(),
  captureMessage: vi.fn(),
}));

// ─── Import after mocks ──────────────────────────────────────────────────────
import { splitActivityEntry } from "@/lib/actions/splits";
import type { SplitLeg } from "@/lib/types";

const PARENT_ID = "11111111-1111-4111-8111-111111111111";

/** A live, splittable BUY parent: 10 units acquired (qty 0 → 10), cashflow set,
 *  cashflow_status complete, no transfer/split/compensation flags. */
function liveBuyParent() {
  return {
    id: PARENT_ID,
    user_id: "user-123",
    action: "created",
    entity_type: "crypto_position",
    entity_id: "pos-1",
    entity_table: "crypto_positions",
    entity_name: "SplitCoin",
    is_adjustment: false,
    is_yield: false,
    transfer_group_id: null,
    split_from_id: null,
    compensates_for: null,
    undone_at: null,
    delta_status: null,
    cashflow_status: "complete",
    cashflow_user_set: false,
    cashflow_amount_usd: 1000,
    cashflow_amount_eur: 900,
    cashflow_asset_class: "crypto",
    delta_usd: null,
    delta_eur: null,
    before_snapshot: { quantity: 0 },
    after_snapshot: { quantity: 10 },
    details: null,
    effective_date: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

// Two no-cost legs summing to the parent's 10 units (avoids the toUsdAndEur path).
const LEGS: SplitLeg[] = [
  { quantity: 6, effective_date: "2026-01-10" },
  { quantity: 4, effective_date: "2026-01-20" },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("splitActivityEntry — parent-undo failure rolls back children + captures to Sentry (H2)", () => {
  it("deletes the inserted children (scoped by split_from_id + user_id) and captures when the parent-undo UPDATE fails", async () => {
    const client = createMockClient([
      // 1) parent fetch — a live, splittable buy.
      { table: "activity_log", result: { data: liveBuyParent(), error: null } },
      // 2) children INSERT — succeeds.
      { table: "activity_log", result: { data: null, error: null } },
      // 3) parent-undo UPDATE — FAILS (the partial-write window).
      { table: "activity_log", result: { data: null, error: { message: "undo write failed" } } },
      // 4) rollback DELETE — succeeds.
      { table: "activity_log", result: { data: null, error: null } },
    ]);
    hoisted.mockClient = client;

    const result = await splitActivityEntry(PARENT_ID, LEGS);

    // Contract: {success:false} — never throws a new shape from this branch.
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Failed to mark parent as undone/);

    // The INSERT happened (children were created), then the UPDATE, then the
    // rollback DELETE — four statements total.
    const insert = client._fromCalls.find((c) => c.isInsert);
    const del = client._fromCalls.find((c) => c.isDelete);
    expect(insert).toBeDefined();
    expect(del).toBeDefined();

    // Rollback DELETE is scoped EXACTLY by (split_from_id = parentId, user_id).
    expect(del!.filters).toEqual([
      { method: "eq", args: ["split_from_id", PARENT_ID] },
      { method: "eq", args: ["user_id", "user-123"] },
    ]);

    // The double-count was signaled to Sentry with the action/phase tags + context.
    expect(hoisted.captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = hoisted.captureException.mock.calls[0];
    expect((err as Error).message).toMatch(/parent-undo failed after children inserted/);
    expect(ctx).toMatchObject({
      tags: { action: "splits.splitActivityEntry", phase: "parent-undo" },
      extra: { parentId: PARENT_ID, childCount: LEGS.length },
    });

    // A failed split must NOT revalidate (no successful mutation occurred).
    expect(hoisted.revalidateDashboard).not.toHaveBeenCalled();
  });

  it("still captures (recording the rollback error) and returns {success:false} when the rollback DELETE itself fails", async () => {
    const client = createMockClient([
      { table: "activity_log", result: { data: liveBuyParent(), error: null } },
      { table: "activity_log", result: { data: null, error: null } }, // insert ok
      { table: "activity_log", result: { data: null, error: { message: "undo write failed" } } }, // undo fails
      { table: "activity_log", result: { data: null, error: { message: "rollback delete failed" } } }, // rollback fails too
    ]);
    hoisted.mockClient = client;

    const result = await splitActivityEntry(PARENT_ID, LEGS);

    expect(result.success).toBe(false);
    // Sentry still fires — and the rollback error is carried in extra so the
    // orphaned-children state is operator-visible.
    expect(hoisted.captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = hoisted.captureException.mock.calls[0];
    expect((err as Error).message).toMatch(/rollback failed/);
    expect(ctx).toMatchObject({
      extra: { parentId: PARENT_ID, rollbackError: "rollback delete failed" },
    });
  });

  it("does NOT roll back or capture on the happy path (children insert + parent-undo both succeed)", async () => {
    const client = createMockClient([
      { table: "activity_log", result: { data: liveBuyParent(), error: null } },
      { table: "activity_log", result: { data: null, error: null } }, // insert ok
      { table: "activity_log", result: { data: null, error: null } }, // undo ok
    ]);
    hoisted.mockClient = client;

    const result = await splitActivityEntry(PARENT_ID, LEGS);

    expect(result.success).toBe(true);
    // No DELETE issued, no Sentry capture; the success path revalidates.
    expect(client._fromCalls.some((c) => c.isDelete)).toBe(false);
    expect(hoisted.captureException).not.toHaveBeenCalled();
    expect(hoisted.revalidateDashboard).toHaveBeenCalledTimes(1);
  });
});
