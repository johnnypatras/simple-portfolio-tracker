import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Unit tests for the optimistic-concurrency guard in stocks.ts
 * `upsertStockPosition`.
 *
 * Same hazard as crypto positions: every write computes an ABSOLUTE new
 * quantity from a value read earlier, so two concurrent same-user writes
 * would clobber each other. The fix gates each share UPDATE on the EXACT
 * quantity just read (`.eq("quantity", before.quantity).select("id")`); 0
 * matched rows → a clean retryable throw.
 */

// ─── Hoisted mock state ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  mockClient: null as ReturnType<typeof createMockClient> | null,
  logActivity: vi.fn(),
  toUsdAndEur: vi.fn(),
  revalidateDashboard: vi.fn(),
}));

// ─── Mock helpers ────────────────────────────────────────────────────────────
function createQueryBuilder(resolveValue: unknown) {
  const builder: Record<string, unknown> & PromiseLike<unknown> = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    single: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockReturnThis(),
    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(resolveValue).then(onfulfilled, onrejected) as PromiseLike<TResult1 | TResult2>;
    },
  };
  return builder;
}

function createMockClient(fromCalls: unknown[], opts?: { user?: { id: string } | null }) {
  let callIndex = 0;
  return {
    from: vi.fn(() => {
      const result = fromCalls[callIndex] ?? { data: null, error: null };
      callIndex++;
      return createQueryBuilder(result);
    }),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: opts?.user === undefined ? { id: "user-123" } : opts.user },
        error: null,
      }),
    },
  };
}

// ─── Module mocks ────────────────────────────────────────────────────────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.mockClient),
}));

vi.mock("@/lib/actions/revalidate", () => ({
  revalidateDashboard: hoisted.revalidateDashboard,
}));

vi.mock("@/lib/actions/activity-log", () => ({
  logActivity: hoisted.logActivity,
  toUsdAndEur: hoisted.toUsdAndEur,
}));

vi.mock("@/lib/actions/with-sentry", () => ({
  captureAction: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/stock-categories", () => ({
  normalizeCategory: vi.fn((c: string) => c),
}));

vi.mock("@/lib/validation", () => ({
  validateQuantity: vi.fn(),
  validateUUID: vi.fn(),
  validateYahooTicker: vi.fn(),
  validateName: vi.fn(),
  validateIsin: vi.fn((v: string | null) => v),
  validateTags: vi.fn((t: string[]) => t ?? []),
  validateCurrency: vi.fn(),
  validateAmount: vi.fn(),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────
import { upsertStockPosition } from "@/lib/actions/stocks";

const ASSET_ID = "11111111-2222-3333-4444-555555555555";
const BROKER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("stocks upsertStockPosition — optimistic concurrency (quantity guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws the retry message when the guarded UPDATE matches 0 rows (positive-qty path)", async () => {
    // Trace: fetch asset (ticker) → fetch `before` (qty 50) → guarded UPDATE →
    // .select("id") returns [] because a concurrent writer changed it first.
    hoisted.mockClient = createMockClient([
      { data: { ticker: "AAPL" }, error: null }, // asset
      { data: { id: "pos-1", quantity: 50 }, error: null }, // before
      { data: [], error: null }, // guarded UPDATE → 0 rows
    ]);

    await expect(
      upsertStockPosition({ stock_asset_id: ASSET_ID, broker_id: BROKER_ID, quantity: 10 }),
    ).rejects.toThrow("This position changed while saving — please retry.");
  });

  it("filters on the EXACT quantity just read (.eq('quantity', before.quantity))", async () => {
    hoisted.mockClient = createMockClient([
      { data: { ticker: "AAPL" }, error: null }, // asset
      { data: { id: "pos-1", quantity: 12.34567891 }, error: null }, // before
      { data: [{ id: "pos-1" }], error: null }, // UPDATE → 1 row
      { data: { id: "pos-1", quantity: 20 }, error: null }, // after
    ]);

    await upsertStockPosition({ stock_asset_id: ASSET_ID, broker_id: BROKER_ID, quantity: 20 });

    // 3rd from() call (index 2) is the guarded UPDATE.
    const updateBuilder = hoisted.mockClient!.from.mock.results[2]?.value as {
      eq: ReturnType<typeof vi.fn>;
    };
    expect(updateBuilder.eq).toHaveBeenCalledWith("quantity", 12.34567891);
  });

  it("happy path: a matched row resolves and logs activity", async () => {
    hoisted.mockClient = createMockClient([
      { data: { ticker: "AAPL" }, error: null }, // asset
      { data: { id: "pos-1", quantity: 50 }, error: null }, // before
      { data: [{ id: "pos-1" }], error: null }, // UPDATE → 1 row
      { data: { id: "pos-1", quantity: 60 }, error: null }, // after
    ]);

    await expect(
      upsertStockPosition({ stock_asset_id: ASSET_ID, broker_id: BROKER_ID, quantity: 60 }),
    ).resolves.toBeUndefined();
    expect(hoisted.logActivity).toHaveBeenCalled();
  });

  it("throws the retry message when the soft-delete-at-zero guarded UPDATE matches 0 rows", async () => {
    // quantity <= 0 path: fetch asset → fetch `existing` (qty 50) → guarded
    // soft-delete UPDATE → .select("id") returns [] (concurrent change).
    hoisted.mockClient = createMockClient([
      { data: { ticker: "AAPL" }, error: null }, // asset
      { data: { id: "pos-1", quantity: 50 }, error: null }, // existing
      { data: [], error: null }, // guarded soft-delete → 0 rows
    ]);

    await expect(
      upsertStockPosition({ stock_asset_id: ASSET_ID, broker_id: BROKER_ID, quantity: 0 }),
    ).rejects.toThrow("This position changed while saving — please retry.");
  });
});
