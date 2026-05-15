import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Unit tests for manual-nav.ts server actions.
 *
 * Strategy: mock createServerSupabaseClient + createStockAsset +
 * activity-log + validation + revalidate so we can exercise the
 * server action's branching logic without touching real Supabase.
 *
 * Each test sets `hoisted.mockClient` to a fresh mock whose `.from()`
 * calls return results from a positional `fromCalls` array — the
 * test reads almost like the runtime trace of the action.
 */

// ─── Hoisted mock state ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  mockClient: null as ReturnType<typeof createMockClient> | null,
  createStockAsset: vi.fn(),
  logActivity: vi.fn(),
  captureAction: vi.fn(),
  revalidateDashboard: vi.fn(),
  validateUUID: vi.fn(),
  validateAmount: vi.fn(),
  validatePastOrTodayDate: vi.fn(),
  validateName: vi.fn(),
  formatCurrency: vi.fn((n: number, c: string) => `${c} ${n.toFixed(2)}`),
}));

// ─── Mock helpers ────────────────────────────────────────────────────────────
function createQueryBuilder(resolveValue: unknown) {
  const builder: Record<string, unknown> & PromiseLike<unknown> = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
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

vi.mock("@/lib/actions/stocks", () => ({
  createStockAsset: hoisted.createStockAsset,
}));

vi.mock("@/lib/actions/revalidate", () => ({
  revalidateDashboard: hoisted.revalidateDashboard,
}));

vi.mock("@/lib/actions/activity-log", () => ({
  logActivity: hoisted.logActivity,
}));

// captureAction wraps the body; here we just invoke it inline so the action
// behaves identically without Sentry instrumentation.
vi.mock("@/lib/actions/with-sentry", () => ({
  captureAction: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/format", () => ({
  formatCurrency: hoisted.formatCurrency,
}));

vi.mock("@/lib/validation", () => ({
  validateUUID: hoisted.validateUUID,
  validateAmount: hoisted.validateAmount,
  validatePastOrTodayDate: hoisted.validatePastOrTodayDate,
  validateName: hoisted.validateName,
}));

// ─── Import after mocks ─────────────────────────────────────────────────────
import {
  addManualNavAsset,
  upsertManualNav,
  deleteManualNav,
} from "@/lib/actions/manual-nav";

// ─── Tests ──────────────────────────────────────────────────────────────────

const ASSET_ID = "11111111-2222-3333-4444-555555555555";
const NAV_ROW_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const VALID_INPUT = {
  ticker: "ENXF",
  name: "EQT Nexus ELTIF",
  currency: "EUR",
  category: "private_equity" as const,
  subtype: "ELTIF",
};

describe("addManualNavAsset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.createStockAsset.mockResolvedValue(ASSET_ID);
  });

  it("throws when no authenticated user", async () => {
    hoisted.mockClient = createMockClient([], { user: null });
    await expect(addManualNavAsset(VALID_INPUT)).rejects.toThrow("Not authenticated");
  });

  it("forces kind='manual' and yahoo_ticker=null regardless of input.kind", async () => {
    hoisted.mockClient = createMockClient([]);
    await addManualNavAsset({ ...VALID_INPUT, kind: "yahoo", yahoo_ticker: "FAKE" });
    expect(hoisted.createStockAsset).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "manual", yahoo_ticker: null }),
      expect.any(Object),
    );
  });

  it("returns the created assetId when no initialNav provided", async () => {
    hoisted.mockClient = createMockClient([]);
    const result = await addManualNavAsset(VALID_INPUT);
    expect(result).toBe(ASSET_ID);
    expect(hoisted.revalidateDashboard).toHaveBeenCalled();
  });

  it("verifies asset kind before inserting initialNav (rejects yahoo reuse)", async () => {
    // createStockAsset may return existing asset_id on unique-violation reuse.
    // If the existing asset is kind='yahoo', NAV insert would silently corrupt.
    hoisted.mockClient = createMockClient([
      { data: { kind: "yahoo" }, error: null }, // select kind
    ]);
    await expect(
      addManualNavAsset(VALID_INPUT, {
        initialNav: { nav: 105.5, effectiveDate: "2026-05-01" },
      }),
    ).rejects.toThrow(/already exists as a Yahoo-priced asset/);
  });

  it("inserts initialNav row + logs activity with NAV row PK as entity_id", async () => {
    hoisted.mockClient = createMockClient([
      { data: { kind: "manual" }, error: null }, // select kind
      { data: { id: NAV_ROW_ID }, error: null }, // insert .select("id").single()
    ]);
    await addManualNavAsset(VALID_INPUT, {
      initialNav: { nav: 105.5, effectiveDate: "2026-05-01", note: " Q1 fund letter " },
    });
    // Validators were called for the initial NAV fields
    expect(hoisted.validateAmount).toHaveBeenCalledWith(105.5, "Initial NAV");
    expect(hoisted.validatePastOrTodayDate).toHaveBeenCalledWith("2026-05-01", "Initial NAV effective date");
    expect(hoisted.validateName).toHaveBeenCalledWith(" Q1 fund letter ", 500, "Note");
    expect(hoisted.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "created",
        entity_type: "manual_nav_update",
        // PK of the manual_nav_updates row, NOT the parent asset_id.
        // Matches upsertManualNav's convention.
        entity_id: NAV_ROW_ID,
        entity_table: "manual_nav_updates",
      }),
    );
  });

  it("throws when initialNav.nav <= 0", async () => {
    hoisted.mockClient = createMockClient([
      { data: { kind: "manual" }, error: null },
    ]);
    await expect(
      addManualNavAsset(VALID_INPUT, {
        initialNav: { nav: -1, effectiveDate: "2026-05-01" },
      }),
    ).rejects.toThrow("Initial NAV must be positive");
  });

  it("throws when verification select fails", async () => {
    hoisted.mockClient = createMockClient([
      { data: null, error: { message: "connection lost", code: "PGRST500" } },
    ]);
    await expect(
      addManualNavAsset(VALID_INPUT, {
        initialNav: { nav: 100, effectiveDate: "2026-05-01" },
      }),
    ).rejects.toThrow(/Failed to verify asset kind/);
  });

  it("throws when NAV insert fails (partial-state recovery message)", async () => {
    hoisted.mockClient = createMockClient([
      { data: { kind: "manual" }, error: null },
      { data: null, error: { message: "constraint violation", code: "23514" } },
    ]);
    await expect(
      addManualNavAsset(VALID_INPUT, {
        initialNav: { nav: 100, effectiveDate: "2026-05-01" },
      }),
    ).rejects.toThrow(/Failed to seed initial NAV/);
  });
});

describe("upsertManualNav", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when no authenticated user", async () => {
    hoisted.mockClient = createMockClient([], { user: null });
    await expect(
      upsertManualNav({ asset_id: ASSET_ID, effective_date: "2026-05-01", nav: 100 }),
    ).rejects.toThrow("Not authenticated");
  });

  it("validates inputs (UUID, date, amount, note length)", async () => {
    hoisted.mockClient = createMockClient([
      { data: { ticker: "ENXF", currency: "EUR", kind: "manual" }, error: null },
      { data: null, error: null },
      { data: { id: NAV_ROW_ID }, error: null },
    ]);
    await upsertManualNav({
      asset_id: ASSET_ID,
      effective_date: "2026-05-01",
      nav: 105.5,
      note: "Q1 fund letter",
    });
    expect(hoisted.validateUUID).toHaveBeenCalledWith(ASSET_ID, "Asset ID");
    expect(hoisted.validatePastOrTodayDate).toHaveBeenCalledWith("2026-05-01", "Effective date");
    expect(hoisted.validateAmount).toHaveBeenCalledWith(105.5, "NAV");
    expect(hoisted.validateName).toHaveBeenCalledWith("Q1 fund letter", 500, "Note");
  });

  it("throws 'Asset not found' on PGRST116 (no row) — no 'or not yours' leak", async () => {
    hoisted.mockClient = createMockClient([
      { data: null, error: { code: "PGRST116", message: "No rows" } },
    ]);
    await expect(
      upsertManualNav({ asset_id: ASSET_ID, effective_date: "2026-05-01", nav: 100 }),
    ).rejects.toThrow(/^Asset not found$/);
  });

  it("throws generic DB error on non-PGRST116 select failure", async () => {
    hoisted.mockClient = createMockClient([
      { data: null, error: { code: "PGRST500", message: "internal server error" } },
    ]);
    await expect(
      upsertManualNav({ asset_id: ASSET_ID, effective_date: "2026-05-01", nav: 100 }),
    ).rejects.toThrow(/Failed to load asset/);
  });

  it("rejects when target asset is kind='yahoo'", async () => {
    hoisted.mockClient = createMockClient([
      { data: { ticker: "AAPL", currency: "USD", kind: "yahoo" }, error: null },
    ]);
    await expect(
      upsertManualNav({ asset_id: ASSET_ID, effective_date: "2026-05-01", nav: 100 }),
    ).rejects.toThrow("Cannot record NAV for a Yahoo-priced asset");
  });

  it("logs action='created' when no existing NAV row", async () => {
    hoisted.mockClient = createMockClient([
      { data: { ticker: "ENXF", currency: "EUR", kind: "manual" }, error: null },
      { data: null, error: null }, // maybeSingle returns null → no existing
      { data: { id: NAV_ROW_ID }, error: null }, // upsert
    ]);
    await upsertManualNav({ asset_id: ASSET_ID, effective_date: "2026-05-01", nav: 100 });
    expect(hoisted.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "created",
        entity_id: NAV_ROW_ID, // PK of NAV row, not asset_id
        entity_table: "manual_nav_updates",
      }),
    );
  });

  it("logs action='updated' when an existing NAV row is found", async () => {
    hoisted.mockClient = createMockClient([
      { data: { ticker: "ENXF", currency: "EUR", kind: "manual" }, error: null },
      { data: { id: NAV_ROW_ID, nav: 100 }, error: null }, // existing
      { data: { id: NAV_ROW_ID }, error: null }, // upsert
    ]);
    await upsertManualNav({ asset_id: ASSET_ID, effective_date: "2026-05-01", nav: 110 });
    expect(hoisted.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "updated",
        entity_id: NAV_ROW_ID,
        before_snapshot: { id: NAV_ROW_ID, nav: 100 },
      }),
    );
  });

  it("throws when upsert fails", async () => {
    hoisted.mockClient = createMockClient([
      { data: { ticker: "ENXF", currency: "EUR", kind: "manual" }, error: null },
      { data: null, error: null },
      { data: null, error: { message: "upsert failed", code: "23505" } },
    ]);
    await expect(
      upsertManualNav({ asset_id: ASSET_ID, effective_date: "2026-05-01", nav: 100 }),
    ).rejects.toThrow(/Failed to record NAV/);
  });

  it("throws when nav <= 0", async () => {
    hoisted.mockClient = createMockClient([]);
    await expect(
      upsertManualNav({ asset_id: ASSET_ID, effective_date: "2026-05-01", nav: 0 }),
    ).rejects.toThrow("NAV must be positive");
  });
});

describe("deleteManualNav", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when no authenticated user", async () => {
    hoisted.mockClient = createMockClient([], { user: null });
    await expect(
      deleteManualNav({ asset_id: ASSET_ID, effective_date: "2026-05-01" }),
    ).rejects.toThrow("Not authenticated");
  });

  it("throws 'NAV entry not found' when probe returns no row", async () => {
    hoisted.mockClient = createMockClient([
      { data: null, error: null }, // maybeSingle → no row
    ]);
    await expect(
      deleteManualNav({ asset_id: ASSET_ID, effective_date: "2026-05-01" }),
    ).rejects.toThrow("NAV entry not found");
  });

  it("throws generic DB error when probe fails (not 'not found')", async () => {
    hoisted.mockClient = createMockClient([
      { data: null, error: { message: "connection lost", code: "PGRST500" } },
    ]);
    await expect(
      deleteManualNav({ asset_id: ASSET_ID, effective_date: "2026-05-01" }),
    ).rejects.toThrow(/Failed to load NAV entry/);
  });

  it("deletes the row and logs action='removed'", async () => {
    hoisted.mockClient = createMockClient([
      { data: { id: NAV_ROW_ID, nav: 100, note: "Q1" }, error: null }, // probe
      { data: { ticker: "ENXF", currency: "EUR" }, error: null }, // asset
      { data: null, error: null }, // delete
    ]);
    await deleteManualNav({ asset_id: ASSET_ID, effective_date: "2026-05-01" });
    expect(hoisted.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "removed",
        entity_type: "manual_nav_update",
        entity_id: NAV_ROW_ID,
        before_snapshot: { id: NAV_ROW_ID, nav: 100, note: "Q1" },
      }),
    );
    expect(hoisted.revalidateDashboard).toHaveBeenCalled();
  });

  it("throws when delete itself fails", async () => {
    hoisted.mockClient = createMockClient([
      { data: { id: NAV_ROW_ID, nav: 100, note: null }, error: null },
      { data: { ticker: "ENXF", currency: "EUR" }, error: null },
      { data: null, error: { message: "delete failed", code: "PGRST500" } },
    ]);
    await expect(
      deleteManualNav({ asset_id: ASSET_ID, effective_date: "2026-05-01" }),
    ).rejects.toThrow(/Failed to delete NAV/);
  });

  it("validates inputs before any DB call", async () => {
    hoisted.mockClient = createMockClient([
      { data: { id: NAV_ROW_ID, nav: 100, note: null }, error: null },
      { data: { ticker: "ENXF", currency: "EUR" }, error: null },
      { data: null, error: null },
    ]);
    await deleteManualNav({ asset_id: ASSET_ID, effective_date: "2026-05-01" });
    expect(hoisted.validateUUID).toHaveBeenCalledWith(ASSET_ID, "Asset ID");
    expect(hoisted.validatePastOrTodayDate).toHaveBeenCalledWith("2026-05-01", "Effective date");
  });

  it("throws generic DB error when the asset-lookup query fails (between NAV probe and delete)", async () => {
    // The action probes the NAV row, then loads the asset for activity-log
    // entity_name + currency. If that asset lookup hits a real DB error
    // (not no-rows), the user should see "Failed to load asset", not the
    // generic delete-failed message that would come if we proceeded.
    hoisted.mockClient = createMockClient([
      { data: { id: NAV_ROW_ID, nav: 100, note: null }, error: null }, // NAV probe ok
      { data: null, error: { message: "connection lost", code: "PGRST500" } }, // asset lookup fails
    ]);
    await expect(
      deleteManualNav({ asset_id: ASSET_ID, effective_date: "2026-05-01" }),
    ).rejects.toThrow(/Failed to load asset/);
  });
});

describe("upsertManualNav — additional coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when the existing-row probe (middle query) fails", async () => {
    // Source order: select asset (ok) → maybeSingle for existing row (fail)
    // → upsert (never reached). Tests the middle-query failure branch.
    hoisted.mockClient = createMockClient([
      { data: { ticker: "ENXF", currency: "EUR", kind: "manual" }, error: null },
      { data: null, error: { message: "timeout", code: "PGRST500" } },
    ]);
    await expect(
      upsertManualNav({ asset_id: ASSET_ID, effective_date: "2026-05-01", nav: 100 }),
    ).rejects.toThrow(/Failed to check existing NAV/);
  });
});

describe("addManualNavAsset — note handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.createStockAsset.mockResolvedValue(ASSET_ID);
  });

  it("skips validateName when note is empty string (no-op)", async () => {
    hoisted.mockClient = createMockClient([
      { data: { kind: "manual" }, error: null },
      { data: { id: NAV_ROW_ID }, error: null }, // insert .select("id").single()
    ]);
    await addManualNavAsset(VALID_INPUT, {
      initialNav: { nav: 100, effectiveDate: "2026-05-01", note: "" },
    });
    // Empty string is falsy in the `if (note)` guard → validateName not called.
    expect(hoisted.validateName).not.toHaveBeenCalled();
  });

  it("skips validateName when note is undefined", async () => {
    hoisted.mockClient = createMockClient([
      { data: { kind: "manual" }, error: null },
      { data: { id: NAV_ROW_ID }, error: null }, // insert .select("id").single()
    ]);
    await addManualNavAsset(VALID_INPUT, {
      initialNav: { nav: 100, effectiveDate: "2026-05-01" },
    });
    expect(hoisted.validateName).not.toHaveBeenCalled();
  });
});
