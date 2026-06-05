import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Unit tests for the optimistic-concurrency guard in crypto.ts `upsertPosition`.
 *
 * Every position write computes an ABSOLUTE new quantity from a value read
 * earlier (addTransaction's outer read, a transfer leg, an editor). Two
 * concurrent same-user writes (double-click, second tab) would each read the
 * same starting quantity and clobber each other — e.g. two 80-unit withdrawals
 * from 100 both writing 20, withdrawing 160 in total. The fix gates each
 * position UPDATE on the EXACT quantity just read
 * (`.eq("quantity", before.quantity).select("id")`); 0 matched rows → a clean
 * retryable throw.
 *
 * Strategy mirrors manual-nav-actions.test.ts: mock createServerSupabaseClient
 * with a positional `fromCalls` array so the test reads like the runtime trace.
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

// captureAction wraps the body; invoke it inline (no Sentry instrumentation).
vi.mock("@/lib/actions/with-sentry", () => ({
  captureAction: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/prices/coingecko", () => ({
  getCoinImage: vi.fn(async () => null),
}));

vi.mock("@/lib/cashflow", () => ({
  isStablecoin: vi.fn(() => false),
}));

// Pass-through validators (validation is exercised elsewhere).
vi.mock("@/lib/validation", () => ({
  validateQuantity: vi.fn(),
  validateUUID: vi.fn(),
  validateCoinGeckoId: vi.fn(),
  validateName: vi.fn(),
  validateImageUrl: vi.fn((u: string | null) => u),
  validateApy: vi.fn(),
  validateAmount: vi.fn(),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────
import { upsertPosition } from "@/lib/actions/crypto";

const ASSET_ID = "11111111-2222-3333-4444-555555555555";
const WALLET_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("crypto upsertPosition — optimistic concurrency (quantity guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws the retry message when the guarded UPDATE matches 0 rows (positive-qty path)", async () => {
    // Trace: fetch asset (ticker/subcategory) → fetch `before` (qty 100) →
    // guarded UPDATE → .select("id") returns [] because a concurrent writer
    // already changed the quantity.
    hoisted.mockClient = createMockClient([
      { data: { ticker: "BTC", subcategory: null }, error: null }, // asset
      { data: { id: "pos-1", quantity: 100 }, error: null }, // before
      { data: [], error: null }, // guarded UPDATE → 0 rows
    ]);

    await expect(
      upsertPosition({ crypto_asset_id: ASSET_ID, wallet_id: WALLET_ID, quantity: 20 }),
    ).rejects.toThrow("This position changed while saving — please retry.");
  });

  it("filters on the EXACT quantity just read (.eq('quantity', before.quantity))", async () => {
    hoisted.mockClient = createMockClient([
      { data: { ticker: "BTC", subcategory: null }, error: null }, // asset
      { data: { id: "pos-1", quantity: 0.123456789012345678 }, error: null }, // before
      { data: [{ id: "pos-1" }], error: null }, // UPDATE → 1 row
      { data: { id: "pos-1", quantity: 5 }, error: null }, // after
    ]);

    await upsertPosition({ crypto_asset_id: ASSET_ID, wallet_id: WALLET_ID, quantity: 5 });

    // 3rd from() call (index 2) is the guarded UPDATE.
    const updateBuilder = hoisted.mockClient!.from.mock.results[2]?.value as {
      eq: ReturnType<typeof vi.fn>;
    };
    expect(updateBuilder.eq).toHaveBeenCalledWith("quantity", 0.123456789012345678);
  });

  it("happy path: a matched row resolves and logs activity", async () => {
    hoisted.mockClient = createMockClient([
      { data: { ticker: "BTC", subcategory: null }, error: null }, // asset
      { data: { id: "pos-1", quantity: 100 }, error: null }, // before
      { data: [{ id: "pos-1" }], error: null }, // UPDATE → 1 row
      { data: { id: "pos-1", quantity: 120 }, error: null }, // after
    ]);

    await expect(
      upsertPosition({ crypto_asset_id: ASSET_ID, wallet_id: WALLET_ID, quantity: 120 }),
    ).resolves.toBeUndefined();
    expect(hoisted.logActivity).toHaveBeenCalled();
  });

  it("throws the retry message when the soft-delete-at-zero guarded UPDATE matches 0 rows", async () => {
    // quantity <= 0 path: fetch asset → fetch `existing` (qty 100) → guarded
    // soft-delete UPDATE → .select("id") returns [] (concurrent change).
    hoisted.mockClient = createMockClient([
      { data: { ticker: "BTC", subcategory: null }, error: null }, // asset
      { data: { id: "pos-1", quantity: 100 }, error: null }, // existing
      { data: [], error: null }, // guarded soft-delete → 0 rows
    ]);

    await expect(
      upsertPosition({ crypto_asset_id: ASSET_ID, wallet_id: WALLET_ID, quantity: 0 }),
    ).rejects.toThrow("This position changed while saving — please retry.");
  });
});
