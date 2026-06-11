import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Unit tests for activity-log.ts — exportActivityLogsCsv (Task 9, original currency).
 *
 * Strategy mirrors toggle-activity-adjustment.test.ts: mock
 * createServerSupabaseClient so the real server action runs fully offline. A
 * recording mock query builder satisfies the fetchAllPaginated chain
 * (.select().eq().order().order().range() → thenable page) and lets us assert
 * the `.eq("user_id", …)` scoping.
 *
 * Coverage:
 *   - header row carries the two new trailing columns (Original Amount/Currency)
 *   - a row with originals emits the raw magnitude + ISO code
 *   - a row without originals emits empty strings (the `?? ""` nullable idiom)
 *   - the read is scoped to the authenticated user
 *   - unauthenticated → throws
 */

// ─── Hoisted mock state ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  mockClient: null as ReturnType<typeof createMockClient> | null,
}));

// ─── Recording mock query builder ────────────────────────────────────────────
type FilterCall = { method: "eq"; args: unknown[] };

function createMockClient(
  rows: unknown[],
  opts?: { user?: { id: string } | null },
) {
  const filters: FilterCall[] = [];
  const builder: Record<string, unknown> & PromiseLike<unknown> = {
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockReturnThis(),
    eq: vi.fn((...args: unknown[]) => {
      filters.push({ method: "eq", args });
      return builder;
    }),
    // fetchAllPaginated awaits the chain as a thenable resolving { data, error }.
    // A single short page (< pageSize) ends the pagination loop immediately.
    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve({ data: rows, error: null }).then(
        onfulfilled,
        onrejected,
      ) as PromiseLike<TResult1 | TResult2>;
    },
  };
  return {
    from: vi.fn(() => builder),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: opts?.user === undefined ? { id: "user-123" } : opts.user },
        error: null,
      }),
    },
    _filters: filters,
  };
}

// ─── Module mocks ────────────────────────────────────────────────────────────
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.mockClient),
}));

// ─── Import after mocks ──────────────────────────────────────────────────────
import { exportActivityLogsCsv } from "@/lib/actions/activity-log";

/** A full-enough activity_log Row for the CSV mapper + normalizeActivityLogRow. */
function makeLogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "log-1",
    user_id: "user-123",
    action: "created",
    entity_type: "crypto_position",
    entity_name: "Bitcoin",
    description: "Bought BTC",
    details: null,
    entity_id: "pos-1",
    entity_table: null,
    before_snapshot: null,
    after_snapshot: null,
    is_adjustment: false,
    is_yield: false,
    cashflow_user_set: false,
    delta_usd: null,
    delta_eur: null,
    delta_status: null,
    cashflow_amount_usd: null,
    cashflow_amount_eur: null,
    cashflow_asset_class: null,
    cashflow_status: null,
    transfer_group_id: null,
    split_from_id: null,
    split_direction: null,
    compensates_for: null,
    undone_at: null,
    effective_date: null,
    created_at: "2026-01-10T12:00:00Z",
    original_amount: null,
    original_currency: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("exportActivityLogsCsv — original amount/currency columns (Task 9)", () => {
  it("appends 'Original Amount' and 'Original Currency' to the header row", async () => {
    hoisted.mockClient = createMockClient([]);

    const csv = await exportActivityLogsCsv();
    const [header] = csv.split("\n");

    expect(header).toBe(
      "Date,Effective Date,Action,Type,Name,Description," +
        "Adjustment,Delta USD,Delta EUR," +
        "Transfer Group,Split From,Compensates For,Undone At," +
        "Original Amount,Original Currency",
    );
  });

  it("emits the original magnitude + ISO code when the row carries them", async () => {
    hoisted.mockClient = createMockClient([
      makeLogRow({ original_amount: 500.5, original_currency: "GBP" }),
    ]);

    const csv = await exportActivityLogsCsv();
    const lines = csv.split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      "2026-01-10T12:00:00.000Z,,created,crypto_position,Bitcoin,Bought BTC," +
        "No,,,,,,,500.5,GBP",
    );
  });

  it("emits empty strings for both columns when the originals are NULL", async () => {
    hoisted.mockClient = createMockClient([makeLogRow()]);

    const csv = await exportActivityLogsCsv();
    const lines = csv.split("\n");

    // Trailing two fields are empty (the `?? ""` nullable-column idiom).
    expect(lines[1].endsWith(",,")).toBe(true);
    expect(lines[1]).toBe(
      "2026-01-10T12:00:00.000Z,,created,crypto_position,Bitcoin,Bought BTC," +
        "No,,,,,,,,",
    );
  });

  it("scopes the read to the authenticated user", async () => {
    const client = createMockClient([]);
    hoisted.mockClient = client;

    await exportActivityLogsCsv();

    expect(client._filters).toEqual([
      { method: "eq", args: ["user_id", "user-123"] },
    ]);
  });

  it("throws when unauthenticated", async () => {
    hoisted.mockClient = createMockClient([], { user: null });

    await expect(exportActivityLogsCsv()).rejects.toThrow("Not authenticated");
  });
});
