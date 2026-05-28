import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Unit tests for activity-log.ts — toggleActivityAdjustment hardening
 * (audit H4 / M1 / M2) + computeDeltaFromSnapshots crypto source (audit H2).
 *
 * Strategy mirrors migrate-legacy-adjustments.test.ts: mock
 * createServerSupabaseClient + the price fetchers + captureAction so the real
 * server action runs fully offline. A recording mock query builder lets us
 * assert the exact UPDATE payload (and that the TOCTOU `.is("undone_at", null)`
 * guard is applied) plus prove that the idempotency / defense-in-depth guards
 * short-circuit before any UPDATE.
 */

// ─── Hoisted mock state ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  mockClient: null as ReturnType<typeof createMockClient> | null,
  fetchYahooDailyHistory: vi.fn(),
  fetchCoinHistory: vi.fn(),
  getFXRates: vi.fn(),
}));

// ─── Recording mock query builder ────────────────────────────────────────────
type FilterCall = { method: "eq" | "is"; args: unknown[] };

type FromCall = {
  table: string;
  /** Resolved value for `.single()` (select) or for awaiting the chain (update). */
  result: { data: unknown; error: unknown };
  filters: FilterCall[];
  updatePayload?: Record<string, unknown>;
  isUpdate: boolean;
};

function createQueryBuilder(call: FromCall) {
  const builder: Record<string, unknown> & PromiseLike<unknown> = {
    select: vi.fn().mockReturnThis(),
    update: vi.fn((payload: Record<string, unknown>) => {
      call.isUpdate = true;
      call.updatePayload = payload;
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
 * `responses` is an ordered list of { table, result } consumed FIFO across
 * `from()` calls. Each entry models one Supabase query in the action.
 */
function createMockClient(
  responses: Array<{ table: string; result: { data: unknown; error: unknown } }>,
  opts?: { user?: { id: string } | null },
) {
  let idx = 0;
  const fromCalls: FromCall[] = [];
  return {
    from: vi.fn((table: string) => {
      const resp = responses[idx] ?? { table, result: { data: null, error: null } };
      idx++;
      const call: FromCall = { table, result: resp.result, filters: [], isUpdate: false };
      fromCalls.push(call);
      return createQueryBuilder(call);
    }),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: opts?.user === undefined ? { id: "user-123" } : opts.user },
        error: null,
      }),
    },
    _fromCalls: fromCalls,
  };
}

// ─── Module mocks ────────────────────────────────────────────────────────────
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.mockClient),
}));

vi.mock("@/lib/prices/historical", () => ({
  fetchYahooDailyHistory: hoisted.fetchYahooDailyHistory,
}));

vi.mock("@/lib/prices/coingecko", () => ({
  fetchCoinHistory: hoisted.fetchCoinHistory,
}));

vi.mock("@/lib/prices/fx", () => ({
  getFXRates: hoisted.getFXRates,
}));

// captureAction just invokes the wrapped fn — bypassing Sentry (preserves wrap).
vi.mock("@/lib/actions/with-sentry", () => ({
  captureAction: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@sentry/nextjs", () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// ─── Import after mocks ──────────────────────────────────────────────────────
import {
  toggleActivityAdjustment,
  computeDeltaFromSnapshots,
} from "@/lib/actions/activity-log";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.getFXRates.mockResolvedValue({ EUR: 0.9 });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeDeltaFromSnapshots — crypto price source (H2)
// ─────────────────────────────────────────────────────────────────────────────
describe("computeDeltaFromSnapshots — crypto uses Yahoo as primary source (H2)", () => {
  it("fetches Yahoo {TICKER}-USD (NOT CoinGecko) for a backdated crypto lot", async () => {
    hoisted.fetchYahooDailyHistory.mockResolvedValue([
      { date: "2021-01-01", price: 30000 },
      { date: "2021-06-15", price: 35000 },
    ]);
    // Single crypto_assets lookup returning ticker + coingecko_id. The action
    // resolves its client via the mocked createServerSupabaseClient (no
    // override needed → exercises the default-client path).
    hoisted.mockClient = createMockClient([
      { table: "crypto_assets", result: { data: { coingecko_id: "bitcoin", ticker: "btc" }, error: null } },
    ]);

    const result = await computeDeltaFromSnapshots(
      "crypto_position",
      "created",
      "2021-06-15",
      null,
      { crypto_asset_id: "asset-1", quantity: 2 },
    );

    // Yahoo was called with the uppercased `${ticker}-USD` symbol + the txDate
    // as both start and end (the fetch layer pads the start edge internally).
    expect(hoisted.fetchYahooDailyHistory).toHaveBeenCalledWith("BTC-USD", "2021-06-15", "2021-06-15");
    // CoinGecko must NOT be hit when Yahoo returns a usable price.
    expect(hoisted.fetchCoinHistory).not.toHaveBeenCalled();
    // 2 qty × 35000 (walk-on-or-before lands on 2021-06-15) = 70000 USD.
    expect(result.usd).toBeCloseTo(70000, 2);
    // EUR mirror via mocked USD→EUR rate 0.9.
    expect(result.eur).toBeCloseTo(63000, 2);
  });

  it("falls back to CoinGecko only when Yahoo returns no data (obscure coin)", async () => {
    hoisted.fetchYahooDailyHistory.mockResolvedValue([]); // not on Yahoo
    hoisted.fetchCoinHistory.mockResolvedValue([
      { date: "2021-01-01", price: 5 },
      { date: "2021-06-15", price: 7 },
    ]);
    hoisted.mockClient = createMockClient([
      { table: "crypto_assets", result: { data: { coingecko_id: "obscure-coin", ticker: "obscr" }, error: null } },
    ]);

    const result = await computeDeltaFromSnapshots(
      "crypto_position",
      "created",
      "2021-06-15",
      null,
      { crypto_asset_id: "asset-1", quantity: 10 },
    );

    expect(hoisted.fetchYahooDailyHistory).toHaveBeenCalledWith("OBSCR-USD", "2021-06-15", "2021-06-15");
    expect(hoisted.fetchCoinHistory).toHaveBeenCalledWith("obscure-coin", expect.any(Number));
    // 10 qty × 7 = 70 USD via the CoinGecko fallback.
    expect(result.usd).toBeCloseTo(70, 2);
  });

  it("throws (no silent zero) when neither Yahoo nor CoinGecko has a positive price", async () => {
    hoisted.fetchYahooDailyHistory.mockResolvedValue([]);
    hoisted.fetchCoinHistory.mockResolvedValue([]);
    hoisted.mockClient = createMockClient([
      { table: "crypto_assets", result: { data: { coingecko_id: "ghost", ticker: "ghost" }, error: null } },
    ]);

    await expect(
      computeDeltaFromSnapshots(
        "crypto_position",
        "created",
        "2021-06-15",
        null,
        { crypto_asset_id: "asset-1", quantity: 1 },
      ),
    ).rejects.toThrow(/Refusing to write zero-valued delta/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toggleActivityAdjustment — guards (H4) + idempotency (M1) + TOCTOU (M2)
// ─────────────────────────────────────────────────────────────────────────────
describe("toggleActivityAdjustment — defense-in-depth guards (H4)", () => {
  it("throws on a transfer leg (transfer_group_id set) — never flips is_adjustment", async () => {
    const client = createMockClient([
      {
        table: "activity_log",
        result: {
          data: {
            id: VALID_UUID,
            entity_type: "crypto_position",
            action: "created",
            is_adjustment: true,
            transfer_group_id: "group-1",
            undone_at: null,
            before_snapshot: null,
            after_snapshot: { crypto_asset_id: "a1", quantity: 1 },
            created_at: "2024-01-01T00:00:00Z",
            effective_date: null,
          },
          error: null,
        },
      },
    ]);
    hoisted.mockClient = client;

    await expect(toggleActivityAdjustment(VALID_UUID, false)).rejects.toThrow(
      "Cannot toggle adjustment on transfer legs",
    );
    // Only the fetch happened — no UPDATE, no price fetch.
    expect(client._fromCalls.some((c) => c.isUpdate)).toBe(false);
    expect(hoisted.fetchYahooDailyHistory).not.toHaveBeenCalled();
  });

  it("throws on an undone row (undone_at set)", async () => {
    const client = createMockClient([
      {
        table: "activity_log",
        result: {
          data: {
            id: VALID_UUID,
            entity_type: "crypto_position",
            action: "created",
            is_adjustment: false,
            transfer_group_id: null,
            undone_at: "2024-02-02T00:00:00Z",
            before_snapshot: null,
            after_snapshot: { crypto_asset_id: "a1", quantity: 1 },
            created_at: "2024-01-01T00:00:00Z",
            effective_date: null,
          },
          error: null,
        },
      },
    ]);
    hoisted.mockClient = client;

    await expect(toggleActivityAdjustment(VALID_UUID, true)).rejects.toThrow(
      "Cannot toggle adjustment on undone entries",
    );
    expect(client._fromCalls.some((c) => c.isUpdate)).toBe(false);
  });
});

describe("toggleActivityAdjustment — idempotency no-op (M1)", () => {
  it("returns early WITHOUT an UPDATE or price fetch when the flag already matches", async () => {
    const client = createMockClient([
      {
        table: "activity_log",
        result: {
          data: {
            id: VALID_UUID,
            entity_type: "crypto_position",
            action: "created",
            is_adjustment: true, // already an adjustment
            transfer_group_id: null,
            undone_at: null,
            before_snapshot: null,
            after_snapshot: { crypto_asset_id: "a1", quantity: 1 },
            created_at: "2024-01-01T00:00:00Z",
            effective_date: null,
          },
          error: null,
        },
      },
    ]);
    hoisted.mockClient = client;

    // Toggle to the SAME value it already has.
    await expect(toggleActivityAdjustment(VALID_UUID, true)).resolves.toBeUndefined();

    // Exactly one `from()` (the row fetch). No UPDATE, no historical-price fetch.
    expect(client._fromCalls).toHaveLength(1);
    expect(client._fromCalls[0].isUpdate).toBe(false);
    expect(hoisted.fetchYahooDailyHistory).not.toHaveBeenCalled();
    expect(hoisted.getFXRates).not.toHaveBeenCalled();
  });
});

describe("toggleActivityAdjustment — TOCTOU guard on UPDATE (M2)", () => {
  it("applies `.is('undone_at', null)` on the UPDATE chain (plus id + user scoping)", async () => {
    hoisted.fetchYahooDailyHistory.mockResolvedValue([{ date: "2021-06-15", price: 30000 }]);
    const client = createMockClient([
      // 1) row fetch
      {
        table: "activity_log",
        result: {
          data: {
            id: VALID_UUID,
            entity_type: "crypto_position",
            action: "created",
            is_adjustment: false, // toggling ON → real change → proceeds
            transfer_group_id: null,
            undone_at: null,
            before_snapshot: null,
            after_snapshot: { crypto_asset_id: "a1", quantity: 1 },
            created_at: "2021-06-15T00:00:00Z",
            effective_date: "2021-06-15",
          },
          error: null,
        },
      },
      // 2) crypto_assets lookup inside computeDeltaFromSnapshots
      { table: "crypto_assets", result: { data: { coingecko_id: "bitcoin", ticker: "btc" }, error: null } },
      // 3) UPDATE
      { table: "activity_log", result: { data: null, error: null } },
    ]);
    hoisted.mockClient = client;

    await expect(toggleActivityAdjustment(VALID_UUID, true)).resolves.toBeUndefined();

    const updateCall = client._fromCalls.find((c) => c.isUpdate);
    expect(updateCall).toBeDefined();
    // The UPDATE payload flips the flag and writes a complete delta.
    expect(updateCall!.updatePayload!.is_adjustment).toBe(true);
    expect(updateCall!.updatePayload!.delta_status).toBe("complete");
    // Scoping + TOCTOU guard: .eq(id), .eq(user_id), .is(undone_at, null).
    expect(updateCall!.filters).toEqual([
      { method: "eq", args: ["id", VALID_UUID] },
      { method: "eq", args: ["user_id", "user-123"] },
      { method: "is", args: ["undone_at", null] },
    ]);
  });
});
