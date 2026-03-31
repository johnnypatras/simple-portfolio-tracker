import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Unit tests for the DB-only deriveCashFlows() function in benchmark.ts.
 *
 * Strategy: mock `createServerSupabaseClient` and `createAdminClient` to return
 * fake Supabase clients with controlled query results. Because deriveCashFlows is
 * wrapped in React.cache(), we re-import the module per test via vi.isolateModules()
 * to reset cache state between tests.
 *
 * Mocked modules:
 *   - @/lib/supabase/server → createServerSupabaseClient returning a mock client
 *   - @/lib/supabase/admin → createAdminClient returning a mock client
 *   - next/cache → stub revalidatePath (avoids import errors from "use server")
 *   - react → cache() is replaced with an identity pass-through so each test
 *     gets a fresh (non-memoised) function call
 */

// ─── Hoisted mock state ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  mockClient: null as ReturnType<typeof createMockClient> | null,
}));

// ─── Mock helpers ────────────────────────────────────────────────────────────

/**
 * Creates a fake Supabase query builder that returns preset results.
 *
 * The Supabase client chain looks like:
 *   supabase.from("activity_log")
 *     .select(...)
 *     .eq(...)
 *     .is(...)
 *     .or(...)
 *     .order(...)
 *     .limit(...)  → Promise<{ data, error }>
 *
 * For count queries the chain ends at .or(...) / .eq(...) and resolves to
 *   { count: number }.
 *
 * We model this as a single chainable object where all builder methods return
 * `this` and the object itself is thenable (`.then` / `await` resolves).
 */
function createQueryBuilder(resolveValue: unknown) {
  const builder: Record<string, unknown> & PromiseLike<unknown> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(resolveValue).then(onfulfilled, onrejected) as PromiseLike<TResult1 | TResult2>;
    },
  };
  return builder;
}

/**
 * Builds a mock Supabase client whose `.from()` call dispatches to per-call
 * query builders controlled by the `fromCalls` queue.  Each element of the
 * queue is a preset result for one successive `.from()` invocation.
 *
 * Call order in deriveCashFlows (no userId):
 *   1. main query  → { data: rows[], error: null | Error }
 *   2. pendingQuery → { count: number }
 *   3. failedQuery  → { count: number }
 */
function createMockClient(
  fromCalls: unknown[]
) {
  let callIndex = 0;
  return {
    from: vi.fn(() => {
      const result = fromCalls[callIndex] ?? { data: [], error: null };
      callIndex++;
      return createQueryBuilder(result);
    }),
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: "test-user-id" } } }),
    },
  };
}

// ─── Module mocks (hoisted before imports) ───────────────────────────────────
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // Strip React.cache() memoisation so each test gets a fresh invocation.
    cache: (fn: (...args: unknown[]) => unknown) => fn,
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.mockClient),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => hoisted.mockClient),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import { deriveCashFlows } from "@/lib/actions/benchmark";

// ─── Tests ───────────────────────────────────────────────────────────────────
describe("deriveCashFlows (DB-only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Maps DB rows to CashFlowEvent array ───────────────────────────────
  describe("row mapping", () => {
    it("extracts date from ISO timestamp", async () => {
      hoisted.mockClient = createMockClient([
        {
          data: [
            {
              created_at: "2024-06-15T10:23:45.000Z",
              cashflow_amount_usd: 1000,
              cashflow_amount_eur: null,
              cashflow_asset_class: "crypto",
              entity_name: "BTC",
            },
          ],
          error: null,
        },
        { count: 0 },
        { count: 0 },
      ]);

      const result = await deriveCashFlows();

      expect(result.events).toHaveLength(1);
      expect(result.events[0].date).toBe("2024-06-15");
    });

    it("maps cashflow_amount_usd to amount_usd", async () => {
      hoisted.mockClient = createMockClient([
        {
          data: [
            {
              created_at: "2024-01-01T00:00:00.000Z",
              cashflow_amount_usd: 5000,
              cashflow_amount_eur: null,
              cashflow_asset_class: "stocks",
              entity_name: "AAPL",
            },
          ],
          error: null,
        },
        { count: 0 },
        { count: 0 },
      ]);

      const result = await deriveCashFlows();

      expect(result.events[0].amount_usd).toBe(5000);
    });

    it("maps cashflow_amount_eur when present", async () => {
      hoisted.mockClient = createMockClient([
        {
          data: [
            {
              created_at: "2024-03-10T12:00:00.000Z",
              cashflow_amount_usd: 1080,
              cashflow_amount_eur: 1000,
              cashflow_asset_class: "cash",
              entity_name: "Alpha Bank",
            },
          ],
          error: null,
        },
        { count: 0 },
        { count: 0 },
      ]);

      const result = await deriveCashFlows();

      expect(result.events[0].amount_eur).toBe(1000);
    });

    it("sets amount_eur to undefined when null in DB", async () => {
      hoisted.mockClient = createMockClient([
        {
          data: [
            {
              created_at: "2024-03-10T12:00:00.000Z",
              cashflow_amount_usd: 500,
              cashflow_amount_eur: null,
              cashflow_asset_class: "crypto",
              entity_name: "ETH",
            },
          ],
          error: null,
        },
        { count: 0 },
        { count: 0 },
      ]);

      const result = await deriveCashFlows();

      expect(result.events[0].amount_eur).toBeUndefined();
    });

    it("carries asset_class through from DB row", async () => {
      hoisted.mockClient = createMockClient([
        {
          data: [
            {
              created_at: "2024-05-20T08:00:00.000Z",
              cashflow_amount_usd: 2000,
              cashflow_amount_eur: 1850,
              cashflow_asset_class: "stocks",
              entity_name: "MSFT",
            },
          ],
          error: null,
        },
        { count: 0 },
        { count: 0 },
      ]);

      const result = await deriveCashFlows();

      expect(result.events[0].asset_class).toBe("stocks");
    });

    it("carries entity_name through from DB row", async () => {
      hoisted.mockClient = createMockClient([
        {
          data: [
            {
              created_at: "2024-05-20T08:00:00.000Z",
              cashflow_amount_usd: 2000,
              cashflow_amount_eur: 1850,
              cashflow_asset_class: "cash",
              entity_name: "Revolut EUR",
            },
          ],
          error: null,
        },
        { count: 0 },
        { count: 0 },
      ]);

      const result = await deriveCashFlows();

      expect(result.events[0].entity_name).toBe("Revolut EUR");
    });

    it("sets asset_class to undefined when null in DB", async () => {
      hoisted.mockClient = createMockClient([
        {
          data: [
            {
              created_at: "2024-05-20T08:00:00.000Z",
              cashflow_amount_usd: 100,
              cashflow_amount_eur: null,
              cashflow_asset_class: null,
              entity_name: null,
            },
          ],
          error: null,
        },
        { count: 0 },
        { count: 0 },
      ]);

      const result = await deriveCashFlows();

      expect(result.events[0].asset_class).toBeUndefined();
      expect(result.events[0].entity_name).toBeUndefined();
    });

    it("maps multiple rows preserving order", async () => {
      hoisted.mockClient = createMockClient([
        {
          data: [
            {
              created_at: "2023-01-01T00:00:00.000Z",
              cashflow_amount_usd: 1000,
              cashflow_amount_eur: 920,
              cashflow_asset_class: "crypto",
              entity_name: "BTC",
            },
            {
              created_at: "2023-06-01T00:00:00.000Z",
              cashflow_amount_usd: -500,
              cashflow_amount_eur: -460,
              cashflow_asset_class: "crypto",
              entity_name: "ETH",
            },
            {
              created_at: "2024-01-15T00:00:00.000Z",
              cashflow_amount_usd: 2500,
              cashflow_amount_eur: 2300,
              cashflow_asset_class: "stocks",
              entity_name: "AAPL",
            },
          ],
          error: null,
        },
        { count: 0 },
        { count: 0 },
      ]);

      const result = await deriveCashFlows();

      expect(result.events).toHaveLength(3);
      expect(result.events[0].date).toBe("2023-01-01");
      expect(result.events[1].date).toBe("2023-06-01");
      expect(result.events[2].date).toBe("2024-01-15");
      expect(result.events[1].amount_usd).toBe(-500);
    });
  });

  // ── 2. Returns empty events on main query error ───────────────────────────
  describe("error handling", () => {
    it("returns empty events when main query fails", async () => {
      // When the main query errors, count queries are never called.
      // Provide only 1 result for the from() call.
      hoisted.mockClient = createMockClient([
        { data: null, error: { message: "connection refused" } },
      ]);

      const result = await deriveCashFlows();

      expect(result.events).toEqual([]);
      expect(result.pendingCount).toBe(0);
      expect(result.failedCount).toBe(0);
    });

    it("returns zero counts when count queries return null count", async () => {
      hoisted.mockClient = createMockClient([
        {
          data: [],
          error: null,
        },
        { count: null },
        { count: null },
      ]);

      const result = await deriveCashFlows();

      expect(result.pendingCount).toBe(0);
      expect(result.failedCount).toBe(0);
    });
  });

  // ── 3. Returns pending/failed counts ─────────────────────────────────────
  describe("status counts", () => {
    it("reflects pending count from DB", async () => {
      hoisted.mockClient = createMockClient([
        { data: [], error: null },
        { count: 3 },
        { count: 0 },
      ]);

      const result = await deriveCashFlows();

      expect(result.pendingCount).toBe(3);
      expect(result.failedCount).toBe(0);
    });

    it("reflects failed count from DB", async () => {
      hoisted.mockClient = createMockClient([
        { data: [], error: null },
        { count: 0 },
        { count: 7 },
      ]);

      const result = await deriveCashFlows();

      expect(result.pendingCount).toBe(0);
      expect(result.failedCount).toBe(7);
    });

    it("reflects both pending and failed counts simultaneously", async () => {
      hoisted.mockClient = createMockClient([
        { data: [], error: null },
        { count: 2 },
        { count: 5 },
      ]);

      const result = await deriveCashFlows();

      expect(result.pendingCount).toBe(2);
      expect(result.failedCount).toBe(5);
    });
  });

  // ── 4. Handles empty result set ──────────────────────────────────────────
  describe("empty result set", () => {
    it("returns empty events array when no rows match", async () => {
      hoisted.mockClient = createMockClient([
        { data: [], error: null },
        { count: 0 },
        { count: 0 },
      ]);

      const result = await deriveCashFlows();

      expect(result.events).toEqual([]);
      expect(result.events).toHaveLength(0);
    });

    it("returns zero counts when no rows match", async () => {
      hoisted.mockClient = createMockClient([
        { data: [], error: null },
        { count: 0 },
        { count: 0 },
      ]);

      const result = await deriveCashFlows();

      expect(result.pendingCount).toBe(0);
      expect(result.failedCount).toBe(0);
    });

    it("returns correct shape with all-zero values", async () => {
      hoisted.mockClient = createMockClient([
        { data: [], error: null },
        { count: 0 },
        { count: 0 },
      ]);

      const result = await deriveCashFlows();

      expect(result).toEqual({ events: [], pendingCount: 0, failedCount: 0 });
    });
  });

  // ── 5. userId path uses createAdminClient ────────────────────────────────
  describe("userId parameter", () => {
    it("uses admin client when userId is provided", async () => {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const { createServerSupabaseClient } = await import("@/lib/supabase/server");

      hoisted.mockClient = createMockClient([
        { data: [], error: null },
        { count: 0 },
        { count: 0 },
      ]);

      await deriveCashFlows("00000000-0000-4000-8000-000000000001");

      expect(createAdminClient).toHaveBeenCalled();
      expect(createServerSupabaseClient).not.toHaveBeenCalled();
    });

    it("uses server client when userId is not provided", async () => {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const { createServerSupabaseClient } = await import("@/lib/supabase/server");

      hoisted.mockClient = createMockClient([
        { data: [], error: null },
        { count: 0 },
        { count: 0 },
      ]);

      await deriveCashFlows();

      expect(createServerSupabaseClient).toHaveBeenCalled();
      expect(createAdminClient).not.toHaveBeenCalled();
    });

    it("still returns correct events when userId is provided", async () => {
      hoisted.mockClient = createMockClient([
        {
          data: [
            {
              created_at: "2024-07-04T14:00:00.000Z",
              cashflow_amount_usd: 9000,
              cashflow_amount_eur: 8300,
              cashflow_asset_class: "crypto",
              entity_name: "SOL",
            },
          ],
          error: null,
        },
        { count: 1 },
        { count: 0 },
      ]);

      const result = await deriveCashFlows("00000000-0000-4000-8000-000000000002");

      expect(result.events).toHaveLength(1);
      expect(result.events[0].date).toBe("2024-07-04");
      expect(result.events[0].amount_usd).toBe(9000);
      expect(result.pendingCount).toBe(1);
    });
  });
});
