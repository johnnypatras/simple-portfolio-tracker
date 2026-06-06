import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Cost-currency boundary tests for all FIVE cost write sites.
 *
 * `cost.currency` is typed `CostCurrency` ("EUR" | "USD"), but server actions
 * are direct POST endpoints — a crafted body can carry `currency: "GBP"`. A cost
 * is stored as a dual EUR+USD pair; a third currency has no column, so the
 * `else` branch at each write would file the raw GBP magnitude under the USD
 * column → an internally-inconsistent dual-currency cost that silently corrupts
 * P&L. `validateBaseCurrency` (REAL here, not mocked) must reject it BEFORE the
 * FX call (`toUsdAndEur`) so no wrong value is ever derived or written.
 *
 * Each site gets: (1) GBP rejected, asserting toUsdAndEur was NEVER called, and
 * (2) a "USD" happy path proving the guard does not over-reject.
 *
 * Harness mirrors crypto-position-concurrency.test.ts: a positional `fromCalls`
 * mock client, real validation, mocked FX/Sentry/cache.
 */

// ─── Hoisted mock state ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  mockClient: null as ReturnType<typeof createMockClient> | null,
  logActivity: vi.fn(),
  toUsdAndEur: vi.fn(async () => ({ usd: 0, eur: 0 })),
  computeDeltaFromSnapshots: vi.fn(async () => ({ usd: 0, eur: 0 })),
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
    in: vi.fn().mockReturnThis(),
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
  computeDeltaFromSnapshots: hoisted.computeDeltaFromSnapshots,
}));

vi.mock("@/lib/actions/with-sentry", () => ({
  captureAction: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/prices/coingecko", () => ({ getCoinImage: vi.fn(async () => null) }));
vi.mock("@/lib/cashflow", () => ({
  isStablecoin: vi.fn(() => false),
  classifyAssetClass: vi.fn(() => "crypto"),
  CASHFLOW_PRODUCING_ENTITY_TYPES: ["crypto_position", "stock_position", "cash_account"],
}));
vi.mock("@/lib/stock-categories", () => ({ normalizeCategory: vi.fn((c: string) => c) }));

// NOTE: @/lib/validation is intentionally NOT mocked — validateBaseCurrency must
// run for real so the GBP rejection is exercised at the true boundary.

// ─── Import after mocks ─────────────────────────────────────────────────────
import { upsertPosition } from "@/lib/actions/crypto";
import { upsertStockPosition } from "@/lib/actions/stocks";
import { splitActivityEntry } from "@/lib/actions/splits";
import { addTransaction, editTransaction } from "@/lib/actions/transactions";

const ASSET_ID = "11111111-2222-3333-4444-555555555555";
const WALLET_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const BROKER_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const ENTRY_ID = "cccccccc-dddd-eeee-ffff-000000000000";

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.toUsdAndEur.mockResolvedValue({ usd: 0, eur: 0 });
  hoisted.computeDeltaFromSnapshots.mockResolvedValue({ usd: 0, eur: 0 });
});

describe("crypto.upsertPosition — cost currency boundary", () => {
  it("rejects a GBP cost BEFORE any FX call", async () => {
    hoisted.mockClient = createMockClient([]);
    await expect(
      upsertPosition(
        { crypto_asset_id: ASSET_ID, wallet_id: WALLET_ID, quantity: 5 },
        { cost: { amount: 100, currency: "GBP" as unknown as "EUR" } },
      ),
    ).rejects.toThrow("Cost currency must be EUR or USD");
    expect(hoisted.toUsdAndEur).not.toHaveBeenCalled();
  });

  it("accepts a USD cost (no over-reject)", async () => {
    hoisted.toUsdAndEur.mockResolvedValue({ usd: 100, eur: 92 });
    hoisted.mockClient = createMockClient([
      { data: { ticker: "BTC", subcategory: null }, error: null }, // asset
      { data: null, error: null }, // before (none → insert path)
      { data: null, error: null }, // insert
      { data: { id: "pos-1", quantity: 5 }, error: null }, // after
    ]);
    await expect(
      upsertPosition(
        { crypto_asset_id: ASSET_ID, wallet_id: WALLET_ID, quantity: 5 },
        { cost: { amount: 100, currency: "USD" } },
      ),
    ).resolves.toBeUndefined();
    expect(hoisted.toUsdAndEur).toHaveBeenCalledTimes(1);
  });
});

describe("stocks.upsertStockPosition — cost currency boundary", () => {
  it("rejects a GBP cost BEFORE any FX call", async () => {
    hoisted.mockClient = createMockClient([]);
    await expect(
      upsertStockPosition(
        { stock_asset_id: ASSET_ID, broker_id: BROKER_ID, quantity: 5 },
        { cost: { amount: 100, currency: "GBP" as unknown as "EUR" } },
      ),
    ).rejects.toThrow("Cost currency must be EUR or USD");
    expect(hoisted.toUsdAndEur).not.toHaveBeenCalled();
  });

  it("accepts a USD cost (no over-reject)", async () => {
    hoisted.toUsdAndEur.mockResolvedValue({ usd: 100, eur: 92 });
    hoisted.mockClient = createMockClient([
      { data: { ticker: "AAPL" }, error: null }, // asset
      { data: null, error: null }, // before (none → insert path)
      { data: null, error: null }, // insert
      { data: { id: "pos-1", quantity: 5 }, error: null }, // after
    ]);
    await expect(
      upsertStockPosition(
        { stock_asset_id: ASSET_ID, broker_id: BROKER_ID, quantity: 5 },
        { cost: { amount: 100, currency: "USD" } },
      ),
    ).resolves.toBeUndefined();
    expect(hoisted.toUsdAndEur).toHaveBeenCalledTimes(1);
  });
});

describe("transactions.addTransaction — cost currency boundary", () => {
  it("rejects a GBP cost BEFORE any FX call", async () => {
    hoisted.mockClient = createMockClient([]);
    await expect(
      addTransaction(
        { class: "crypto", assetId: ASSET_ID },
        {
          type: "buy",
          quantity: 5,
          walletId: WALLET_ID,
          cost: { amount: 100, currency: "GBP" as unknown as "EUR" },
        },
      ),
    ).rejects.toThrow("Cost currency must be EUR or USD");
    expect(hoisted.toUsdAndEur).not.toHaveBeenCalled();
  });

  it("accepts a USD cost (no over-reject)", async () => {
    hoisted.toUsdAndEur.mockResolvedValue({ usd: 100, eur: 92 });
    // addTransaction reads the current crypto qty, then calls upsertPosition.
    // from() trace: readCryptoQty (maybeSingle) → upsertPosition asset →
    // before → insert → after.
    hoisted.mockClient = createMockClient([
      { data: null, error: null }, // readCryptoQty → 0 (first buy)
      { data: { ticker: "BTC", subcategory: null }, error: null }, // asset
      { data: null, error: null }, // before
      { data: null, error: null }, // insert
      { data: { id: "pos-1", quantity: 5 }, error: null }, // after
    ]);
    await expect(
      addTransaction(
        { class: "crypto", assetId: ASSET_ID },
        {
          type: "buy",
          quantity: 5,
          walletId: WALLET_ID,
          cost: { amount: 100, currency: "USD" },
        },
      ),
    ).resolves.toBeUndefined();
    expect(hoisted.toUsdAndEur).toHaveBeenCalled();
  });
});

describe("transactions.editTransaction — cost currency boundary", () => {
  it("rejects a GBP cost BEFORE any FX call", async () => {
    hoisted.mockClient = createMockClient([]);
    await expect(
      editTransaction(ENTRY_ID, { cost: { amount: 100, currency: "GBP" as unknown as "EUR" } }),
    ).rejects.toThrow("Cost currency must be EUR or USD");
    expect(hoisted.toUsdAndEur).not.toHaveBeenCalled();
  });

  it("accepts a USD cost (no over-reject)", async () => {
    hoisted.toUsdAndEur.mockResolvedValue({ usd: 100, eur: 92 });
    // editTransaction fetches the row, runs guards, then derives FX + UPDATE.
    const row = {
      id: ENTRY_ID,
      entity_type: "crypto_position",
      action: "updated",
      is_yield: false,
      is_adjustment: false,
      transfer_group_id: null,
      split_from_id: null,
      undone_at: null,
      compensates_for: null,
      effective_date: "2026-01-01",
      created_at: "2026-01-01T00:00:00Z",
      cashflow_amount_usd: 50,
      cashflow_amount_eur: 46,
      delta_usd: null,
      delta_eur: null,
      before_snapshot: null,
      after_snapshot: { crypto_asset_id: ASSET_ID },
    };
    hoisted.mockClient = createMockClient([
      { data: row, error: null }, // fetch row
      { data: { subcategory: null }, error: null }, // crypto_assets stablecoin lookup
      { data: null, error: null }, // UPDATE
    ]);
    const res = await editTransaction(ENTRY_ID, { cost: { amount: 100, currency: "USD" } });
    expect(res.success).toBe(true);
    expect(hoisted.toUsdAndEur).toHaveBeenCalledTimes(1);
  });
});

describe("splits.splitActivityEntry — per-leg cost currency boundary", () => {
  const parent = {
    id: ENTRY_ID,
    action: "created",
    entity_type: "crypto_position",
    entity_id: "pos-1",
    entity_table: "crypto_positions",
    entity_name: "BTC",
    undone_at: null,
    split_from_id: null,
    compensates_for: null,
    transfer_group_id: null,
    is_adjustment: false,
    is_yield: false,
    cashflow_user_set: false,
    cashflow_status: "complete",
    delta_status: null,
    cashflow_amount_usd: 100,
    cashflow_amount_eur: 92,
    cashflow_asset_class: "crypto",
    delta_usd: null,
    delta_eur: null,
    before_snapshot: null,
    after_snapshot: { quantity: 10 },
    details: null,
  };

  it("rejects a GBP leg cost BEFORE any FX call", async () => {
    // validateBaseCurrency throws inside the leg loop (consistent with the
    // adjacent validateAmount) — captureAction re-throws rather than mapping to
    // {success:false}. The point is the throw lands before toUsdAndEur runs.
    hoisted.mockClient = createMockClient([{ data: parent, error: null }]); // fetch parent
    await expect(
      splitActivityEntry(ENTRY_ID, [
        { effective_date: "2026-01-01", quantity: 4, cost: { amount: 40, currency: "GBP" as unknown as "EUR" } },
        { effective_date: "2026-01-02", quantity: 6 },
      ]),
    ).rejects.toThrow("Cost currency must be EUR or USD");
    expect(hoisted.toUsdAndEur).not.toHaveBeenCalled();
  });

  it("accepts a USD leg cost (no over-reject)", async () => {
    hoisted.toUsdAndEur.mockResolvedValue({ usd: 40, eur: 37 });
    hoisted.mockClient = createMockClient([
      { data: parent, error: null }, // fetch parent
      { data: null, error: null }, // insert children
      { data: null, error: null }, // mark parent undone
    ]);
    const res = await splitActivityEntry(ENTRY_ID, [
      { effective_date: "2026-01-01", quantity: 4, cost: { amount: 40, currency: "USD" } },
      { effective_date: "2026-01-02", quantity: 6 },
    ]);
    expect(res.success).toBe(true);
    expect(hoisted.toUsdAndEur).toHaveBeenCalledTimes(1);
  });
});
