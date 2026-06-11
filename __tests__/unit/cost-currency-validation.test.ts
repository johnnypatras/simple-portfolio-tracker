import { vi, describe, it, expect, beforeEach } from "vitest";
import { round2 } from "@/lib/format";

/**
 * Cost-currency boundary tests for the cost write sites (any-ISO contract,
 * 2026-06-11 currency-uniform fix).
 *
 * A cost may be typed in ANY ISO-4217 currency. The boundary validator is
 * `validateCurrency` (REAL here, not mocked — 3 uppercase letters), and the
 * stored dual EUR+USD pair follows the verbatim-leg rule:
 *   - EUR-typed  → eur leg BYTE-EXACT (all decimals), usd = round2(derived)
 *   - USD-typed  → usd leg BYTE-EXACT, eur = round2(derived)
 *   - other ISO  → BOTH legs derived via `toUsdAndEur` + round2 (the typed
 *     number has no stored leg of its own; it survives in original_*)
 * Every consumed user cost also stamps `original_(amount|currency)` — the
 * literal (magnitude, ISO) the user typed — onto the activity row.
 *
 * Each site gets: a foreign-ISO (GBP/CHF) acceptance test asserting BOTH
 * stored legs derive from the mocked `toUsdAndEur` + the original stamp;
 * EUR- and USD-typed byte-exact tests; and a malformed-code rejection
 * ("EU"/"ABCD"/""/lowercase) asserting `toUsdAndEur` is never reached.
 *
 * Harness mirrors crypto-position-concurrency.test.ts: a positional `fromCalls`
 * mock client (builders recorded for insert/update payload inspection), real
 * validation, mocked FX/Sentry/cache.
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
type MockQueryBuilder = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: <TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => PromiseLike<TResult1 | TResult2>;
};

function createQueryBuilder(resolveValue: unknown): MockQueryBuilder {
  const builder: MockQueryBuilder = {
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
  // Builders recorded in from() order so tests can inspect insert/update payloads.
  const builders: MockQueryBuilder[] = [];
  return {
    builders,
    from: vi.fn(() => {
      const result = fromCalls[callIndex] ?? { data: null, error: null };
      callIndex++;
      const builder = createQueryBuilder(result);
      builders.push(builder);
      return builder;
    }),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: opts?.user === undefined ? { id: "user-123" } : opts.user },
        error: null,
      }),
    },
  };
}

/** The single logActivity payload for an entity type (throws when absent). */
function logCallFor(entityType: string): Record<string, unknown> {
  const call = hoisted.logActivity.mock.calls.find(
    (c) => (c[0] as { entity_type?: string }).entity_type === entityType,
  );
  if (!call) throw new Error(`no logActivity call for entity_type=${entityType}`);
  return call[0] as Record<string, unknown>;
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

// NOTE: @/lib/validation is intentionally NOT mocked — validateCurrency must
// run for real so the any-ISO accept / malformed-reject contract is exercised
// at the true boundary.

// ─── Import after mocks ─────────────────────────────────────────────────────
import { upsertPosition } from "@/lib/actions/crypto";
import { upsertStockPosition } from "@/lib/actions/stocks";
import { splitActivityEntry } from "@/lib/actions/splits";
import {
  addTransaction,
  addNewAssetTransaction,
  editTransaction,
} from "@/lib/actions/transactions";

const ASSET_ID = "11111111-2222-3333-4444-555555555555";
const WALLET_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const BROKER_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const ENTRY_ID = "cccccccc-dddd-eeee-ffff-000000000000";

// Distinct multi-decimal FX outputs so BOTH round2'd legs are assertable and a
// verbatim (non-rounded) leg is distinguishable from a derived one.
const FOREIGN_FX = { usd: 127.456789, eur: 117.134567 }; // → 127.46 / 117.13
const EUR_TYPED = { amount: 100.123456, fx: { usd: 108.567891, eur: 100.123456 } }; // usd → 108.57
const USD_TYPED = { amount: 250.987654, fx: { usd: 250.987654, eur: 231.234567 } }; // eur → 231.23

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.toUsdAndEur.mockResolvedValue({ usd: 0, eur: 0 });
  hoisted.computeDeltaFromSnapshots.mockResolvedValue({ usd: 0, eur: 0 });
});

// ═══ crypto.upsertPosition ═══════════════════════════════════════════════════

describe("crypto.upsertPosition — cost currency boundary", () => {
  /** fromCalls for the no-prior-position insert path. */
  const upsertFromCalls = () => [
    { data: { ticker: "BTC", subcategory: null }, error: null }, // asset
    { data: null, error: null }, // before (none → insert path)
    { data: null, error: null }, // insert
    { data: { id: "pos-1", quantity: 5 }, error: null }, // after
  ];

  it("accepts a GBP cost: toUsdAndEur called with GBP, BOTH stored legs derived + round2'd, original stamped", async () => {
    hoisted.toUsdAndEur.mockResolvedValue(FOREIGN_FX);
    hoisted.mockClient = createMockClient(upsertFromCalls());
    await expect(
      upsertPosition(
        { crypto_asset_id: ASSET_ID, wallet_id: WALLET_ID, quantity: 5 },
        { cost: { amount: 100, currency: "GBP" } },
      ),
    ).resolves.toBeUndefined();
    expect(hoisted.toUsdAndEur).toHaveBeenCalledTimes(1);
    expect(hoisted.toUsdAndEur).toHaveBeenCalledWith(100, "GBP", undefined);
    expect(hoisted.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        cashflow_amount_usd: round2(FOREIGN_FX.usd), // 127.46 — derived, NOT the typed 100
        cashflow_amount_eur: round2(FOREIGN_FX.eur), // 117.13 — derived
        cashflow_user_set: true,
        original: { amount: 100, currency: "GBP" },
      }),
    );
  });

  it("EUR-typed cost keeps the eur leg BYTE-EXACT; usd derived + round2'd", async () => {
    hoisted.toUsdAndEur.mockResolvedValue(EUR_TYPED.fx);
    hoisted.mockClient = createMockClient(upsertFromCalls());
    await upsertPosition(
      { crypto_asset_id: ASSET_ID, wallet_id: WALLET_ID, quantity: 5 },
      { cost: { amount: EUR_TYPED.amount, currency: "EUR" } },
    );
    expect(hoisted.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        cashflow_amount_eur: EUR_TYPED.amount, // 100.123456 verbatim — no round2
        cashflow_amount_usd: round2(EUR_TYPED.fx.usd), // 108.57
        original: { amount: EUR_TYPED.amount, currency: "EUR" },
      }),
    );
  });

  it("USD-typed cost keeps the usd leg BYTE-EXACT; eur derived + round2'd", async () => {
    hoisted.toUsdAndEur.mockResolvedValue(USD_TYPED.fx);
    hoisted.mockClient = createMockClient(upsertFromCalls());
    await upsertPosition(
      { crypto_asset_id: ASSET_ID, wallet_id: WALLET_ID, quantity: 5 },
      { cost: { amount: USD_TYPED.amount, currency: "USD" } },
    );
    expect(hoisted.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        cashflow_amount_usd: USD_TYPED.amount, // 250.987654 verbatim — no round2
        cashflow_amount_eur: round2(USD_TYPED.fx.eur), // 231.23
        original: { amount: USD_TYPED.amount, currency: "USD" },
      }),
    );
  });

  it('rejects a malformed code ("EU") BEFORE any FX call', async () => {
    hoisted.mockClient = createMockClient([]);
    await expect(
      upsertPosition(
        { crypto_asset_id: ASSET_ID, wallet_id: WALLET_ID, quantity: 5 },
        { cost: { amount: 100, currency: "EU" } },
      ),
    ).rejects.toThrow('Invalid currency code: "EU"');
    expect(hoisted.toUsdAndEur).not.toHaveBeenCalled();
  });
});

// ═══ stocks.upsertStockPosition ══════════════════════════════════════════════

describe("stocks.upsertStockPosition — cost currency boundary", () => {
  const upsertFromCalls = () => [
    { data: { ticker: "AAPL" }, error: null }, // asset
    { data: null, error: null }, // before (none → insert path)
    { data: null, error: null }, // insert
    { data: { id: "pos-1", quantity: 5 }, error: null }, // after
  ];

  it("accepts a CHF cost: toUsdAndEur called with CHF, BOTH stored legs derived + round2'd, original stamped", async () => {
    hoisted.toUsdAndEur.mockResolvedValue(FOREIGN_FX);
    hoisted.mockClient = createMockClient(upsertFromCalls());
    await expect(
      upsertStockPosition(
        { stock_asset_id: ASSET_ID, broker_id: BROKER_ID, quantity: 5 },
        { cost: { amount: 100, currency: "CHF" } },
      ),
    ).resolves.toBeUndefined();
    expect(hoisted.toUsdAndEur).toHaveBeenCalledTimes(1);
    expect(hoisted.toUsdAndEur).toHaveBeenCalledWith(100, "CHF", undefined);
    expect(hoisted.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        cashflow_amount_usd: round2(FOREIGN_FX.usd),
        cashflow_amount_eur: round2(FOREIGN_FX.eur),
        cashflow_user_set: true,
        original: { amount: 100, currency: "CHF" },
      }),
    );
  });

  it("EUR-typed cost keeps the eur leg BYTE-EXACT; usd derived + round2'd", async () => {
    hoisted.toUsdAndEur.mockResolvedValue(EUR_TYPED.fx);
    hoisted.mockClient = createMockClient(upsertFromCalls());
    await upsertStockPosition(
      { stock_asset_id: ASSET_ID, broker_id: BROKER_ID, quantity: 5 },
      { cost: { amount: EUR_TYPED.amount, currency: "EUR" } },
    );
    expect(hoisted.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        cashflow_amount_eur: EUR_TYPED.amount,
        cashflow_amount_usd: round2(EUR_TYPED.fx.usd),
        original: { amount: EUR_TYPED.amount, currency: "EUR" },
      }),
    );
  });

  it("USD-typed cost keeps the usd leg BYTE-EXACT; eur derived + round2'd", async () => {
    hoisted.toUsdAndEur.mockResolvedValue(USD_TYPED.fx);
    hoisted.mockClient = createMockClient(upsertFromCalls());
    await upsertStockPosition(
      { stock_asset_id: ASSET_ID, broker_id: BROKER_ID, quantity: 5 },
      { cost: { amount: USD_TYPED.amount, currency: "USD" } },
    );
    expect(hoisted.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        cashflow_amount_usd: USD_TYPED.amount,
        cashflow_amount_eur: round2(USD_TYPED.fx.eur),
        original: { amount: USD_TYPED.amount, currency: "USD" },
      }),
    );
  });

  it('rejects a malformed code ("ABCD") BEFORE any FX call', async () => {
    hoisted.mockClient = createMockClient([]);
    await expect(
      upsertStockPosition(
        { stock_asset_id: ASSET_ID, broker_id: BROKER_ID, quantity: 5 },
        { cost: { amount: 100, currency: "ABCD" } },
      ),
    ).rejects.toThrow('Invalid currency code: "ABCD"');
    expect(hoisted.toUsdAndEur).not.toHaveBeenCalled();
  });
});

// ═══ transactions.addTransaction ═════════════════════════════════════════════

describe("transactions.addTransaction — cost currency boundary", () => {
  // from() trace: readCryptoQty (maybeSingle) → upsertPosition asset →
  // before → insert → after.
  const buyFromCalls = () => [
    { data: null, error: null }, // readCryptoQty → 0 (first buy)
    { data: { ticker: "BTC", subcategory: null }, error: null }, // asset
    { data: null, error: null }, // before
    { data: null, error: null }, // insert
    { data: { id: "pos-1", quantity: 5 }, error: null }, // after
  ];

  it("accepts a GBP cost: BOTH stored legs derived + round2'd, original stamped", async () => {
    hoisted.toUsdAndEur.mockResolvedValue(FOREIGN_FX);
    hoisted.mockClient = createMockClient(buyFromCalls());
    await expect(
      addTransaction(
        { class: "crypto", assetId: ASSET_ID },
        {
          type: "buy",
          quantity: 5,
          walletId: WALLET_ID,
          cost: { amount: 100, currency: "GBP" },
        },
      ),
    ).resolves.toBeUndefined();
    expect(hoisted.toUsdAndEur).toHaveBeenCalledTimes(1);
    expect(hoisted.toUsdAndEur).toHaveBeenCalledWith(100, "GBP", undefined);
    expect(hoisted.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        cashflow_amount_usd: round2(FOREIGN_FX.usd),
        cashflow_amount_eur: round2(FOREIGN_FX.eur),
        cashflow_user_set: true,
        original: { amount: 100, currency: "GBP" },
      }),
    );
  });

  it("EUR-typed cost keeps the eur leg BYTE-EXACT; usd derived + round2'd", async () => {
    hoisted.toUsdAndEur.mockResolvedValue(EUR_TYPED.fx);
    hoisted.mockClient = createMockClient(buyFromCalls());
    await addTransaction(
      { class: "crypto", assetId: ASSET_ID },
      {
        type: "buy",
        quantity: 5,
        walletId: WALLET_ID,
        cost: { amount: EUR_TYPED.amount, currency: "EUR" },
      },
    );
    expect(hoisted.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        cashflow_amount_eur: EUR_TYPED.amount,
        cashflow_amount_usd: round2(EUR_TYPED.fx.usd),
        original: { amount: EUR_TYPED.amount, currency: "EUR" },
      }),
    );
  });

  it("USD-typed cost keeps the usd leg BYTE-EXACT; eur derived + round2'd", async () => {
    hoisted.toUsdAndEur.mockResolvedValue(USD_TYPED.fx);
    hoisted.mockClient = createMockClient(buyFromCalls());
    await addTransaction(
      { class: "crypto", assetId: ASSET_ID },
      {
        type: "buy",
        quantity: 5,
        walletId: WALLET_ID,
        cost: { amount: USD_TYPED.amount, currency: "USD" },
      },
    );
    expect(hoisted.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        cashflow_amount_usd: USD_TYPED.amount,
        cashflow_amount_eur: round2(USD_TYPED.fx.eur),
        original: { amount: USD_TYPED.amount, currency: "USD" },
      }),
    );
  });

  it("blank-cost (market) buy stamps NO original and calls no FX", async () => {
    hoisted.mockClient = createMockClient(buyFromCalls());
    await addTransaction(
      { class: "crypto", assetId: ASSET_ID },
      {
        type: "buy",
        quantity: 5,
        walletId: WALLET_ID,
        currentPriceUsd: 10,
        currentPriceEur: 9,
      },
    );
    expect(hoisted.toUsdAndEur).not.toHaveBeenCalled();
    const logged = logCallFor("crypto_position");
    expect(logged.original ?? null).toBeNull();
    expect(logged.cashflow_user_set).toBe(false);
  });

  it('rejects a malformed code ("") BEFORE any FX call', async () => {
    hoisted.mockClient = createMockClient([]);
    await expect(
      addTransaction(
        { class: "crypto", assetId: ASSET_ID },
        {
          type: "buy",
          quantity: 5,
          walletId: WALLET_ID,
          cost: { amount: 100, currency: "" },
        },
      ),
    ).rejects.toThrow("Invalid currency code");
    expect(hoisted.toUsdAndEur).not.toHaveBeenCalled();
  });
});

// ═══ transactions.addNewAssetTransaction ═════════════════════════════════════

describe("transactions.addNewAssetTransaction — cost currency boundary", () => {
  it("accepts a GBP cost end-to-end (delegated buy books derived legs + original)", async () => {
    hoisted.toUsdAndEur.mockResolvedValue(FOREIGN_FX);
    // from() trace: createCryptoAsset insert → addTransaction readCryptoQty →
    // upsertPosition asset → before → insert → after.
    hoisted.mockClient = createMockClient([
      { data: { id: ASSET_ID }, error: null }, // createCryptoAsset insert+select
      { data: null, error: null }, // readCryptoQty → 0
      { data: { ticker: "BTC", subcategory: null }, error: null }, // asset
      { data: null, error: null }, // before
      { data: null, error: null }, // insert
      { data: { id: "pos-1", quantity: 5 }, error: null }, // after
    ]);
    const res = await addNewAssetTransaction({
      assetClass: "crypto",
      newCryptoAsset: { ticker: "BTC", name: "Bitcoin", coingecko_id: "bitcoin" },
      locationId: WALLET_ID,
      quantity: 5,
      cost: { amount: 100, currency: "GBP" },
    });
    expect(res).toEqual({ success: true });
    expect(hoisted.toUsdAndEur).toHaveBeenCalledWith(100, "GBP", undefined);
    expect(hoisted.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: "crypto_position",
        cashflow_amount_usd: round2(FOREIGN_FX.usd),
        cashflow_amount_eur: round2(FOREIGN_FX.eur),
        original: { amount: 100, currency: "GBP" },
      }),
    );
  });

  it('rejects a malformed code (lowercase "gbp") BEFORE any FX or asset creation', async () => {
    const client = createMockClient([]);
    hoisted.mockClient = client;
    const res = await addNewAssetTransaction({
      assetClass: "crypto",
      newCryptoAsset: { ticker: "BTC", name: "Bitcoin", coingecko_id: "bitcoin" },
      locationId: WALLET_ID,
      quantity: 5,
      cost: { amount: 100, currency: "gbp" },
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Invalid currency code: "gbp"');
    expect(hoisted.toUsdAndEur).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled(); // no asset minted
  });
});

// ═══ transactions.editTransaction ════════════════════════════════════════════

describe("transactions.editTransaction — cost currency boundary", () => {
  const baseRow = {
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

  it("accepts a GBP cost: BOTH updated legs derived + round2'd, original stamped, FX at the row's date", async () => {
    hoisted.toUsdAndEur.mockResolvedValue(FOREIGN_FX);
    const client = createMockClient([
      { data: baseRow, error: null }, // fetch row
      { data: { subcategory: null }, error: null }, // crypto_assets stablecoin lookup
      { data: null, error: null }, // UPDATE
    ]);
    hoisted.mockClient = client;
    const res = await editTransaction(ENTRY_ID, { cost: { amount: 100, currency: "GBP" } });
    expect(res.success).toBe(true);
    expect(hoisted.toUsdAndEur).toHaveBeenCalledTimes(1);
    expect(hoisted.toUsdAndEur).toHaveBeenCalledWith(100, "GBP", "2026-01-01");
    expect(client.builders[2].update).toHaveBeenCalledWith(
      expect.objectContaining({
        cashflow_amount_usd: round2(FOREIGN_FX.usd),
        cashflow_amount_eur: round2(FOREIGN_FX.eur),
        cashflow_status: "complete",
        cashflow_user_set: true,
        original_amount: 100,
        original_currency: "GBP",
      }),
    );
  });

  it("EUR-typed cost keeps the eur leg BYTE-EXACT; usd derived + round2'd", async () => {
    hoisted.toUsdAndEur.mockResolvedValue(EUR_TYPED.fx);
    const client = createMockClient([
      { data: baseRow, error: null },
      { data: { subcategory: null }, error: null },
      { data: null, error: null },
    ]);
    hoisted.mockClient = client;
    const res = await editTransaction(ENTRY_ID, {
      cost: { amount: EUR_TYPED.amount, currency: "EUR" },
    });
    expect(res.success).toBe(true);
    expect(client.builders[2].update).toHaveBeenCalledWith(
      expect.objectContaining({
        cashflow_amount_eur: EUR_TYPED.amount,
        cashflow_amount_usd: round2(EUR_TYPED.fx.usd),
        original_amount: EUR_TYPED.amount,
        original_currency: "EUR",
      }),
    );
  });

  it("USD-typed cost keeps the usd leg BYTE-EXACT; eur derived + round2'd", async () => {
    hoisted.toUsdAndEur.mockResolvedValue(USD_TYPED.fx);
    const client = createMockClient([
      { data: baseRow, error: null },
      { data: { subcategory: null }, error: null },
      { data: null, error: null },
    ]);
    hoisted.mockClient = client;
    const res = await editTransaction(ENTRY_ID, {
      cost: { amount: USD_TYPED.amount, currency: "USD" },
    });
    expect(res.success).toBe(true);
    expect(client.builders[2].update).toHaveBeenCalledWith(
      expect.objectContaining({
        cashflow_amount_usd: USD_TYPED.amount,
        cashflow_amount_eur: round2(USD_TYPED.fx.eur),
        original_amount: USD_TYPED.amount,
        original_currency: "USD",
      }),
    );
  });

  it("adjustment row: CHF cost lands in delta_* (derived legs), original stamped, cashflow_user_set NOT touched", async () => {
    hoisted.toUsdAndEur.mockResolvedValue(FOREIGN_FX);
    const adjRow = {
      ...baseRow,
      is_adjustment: true,
      cashflow_amount_usd: null,
      cashflow_amount_eur: null,
      delta_usd: 50,
      delta_eur: 46,
    };
    // Adjustment branch skips the stablecoin lookup: fetch row → UPDATE.
    const client = createMockClient([
      { data: adjRow, error: null },
      { data: null, error: null },
    ]);
    hoisted.mockClient = client;
    const res = await editTransaction(ENTRY_ID, { cost: { amount: 100, currency: "CHF" } });
    expect(res.success).toBe(true);
    const payload = client.builders[1].update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toEqual(
      expect.objectContaining({
        delta_usd: round2(FOREIGN_FX.usd),
        delta_eur: round2(FOREIGN_FX.eur),
        delta_status: "complete",
        cashflow_amount_usd: null,
        cashflow_amount_eur: null,
        cashflow_status: null,
        original_amount: 100,
        original_currency: "CHF",
      }),
    );
    // Provenance semantics preserved: the adjustment branch never writes
    // cashflow_user_set — stamping the original must not change that.
    expect("cashflow_user_set" in payload).toBe(false);
  });

  it('rejects a malformed code ("EU") BEFORE any FX call', async () => {
    hoisted.mockClient = createMockClient([]);
    await expect(
      editTransaction(ENTRY_ID, { cost: { amount: 100, currency: "EU" } }),
    ).rejects.toThrow('Invalid currency code: "EU"');
    expect(hoisted.toUsdAndEur).not.toHaveBeenCalled();
  });
});

// ═══ splits.splitActivityEntry ═══════════════════════════════════════════════

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

  const splitFromCalls = () => [
    { data: parent, error: null }, // fetch parent
    { data: null, error: null }, // insert children
    { data: null, error: null }, // mark parent undone
  ];

  it("accepts a GBP leg cost: BOTH child legs derived + round2'd, original stamped on the costed leg only", async () => {
    hoisted.toUsdAndEur.mockResolvedValue({ usd: 51.456789, eur: 47.131234 });
    const client = createMockClient(splitFromCalls());
    hoisted.mockClient = client;
    const res = await splitActivityEntry(ENTRY_ID, [
      { effective_date: "2026-01-01", quantity: 4, cost: { amount: 40, currency: "GBP" } },
      { effective_date: "2026-01-02", quantity: 6 },
    ]);
    expect(res.success).toBe(true);
    expect(hoisted.toUsdAndEur).toHaveBeenCalledTimes(1);
    expect(hoisted.toUsdAndEur).toHaveBeenCalledWith(40, "GBP", "2026-01-01");

    const children = client.builders[1].insert.mock.calls[0][0] as Record<string, unknown>[];
    expect(children).toHaveLength(2);
    expect(children[0]).toEqual(
      expect.objectContaining({
        cashflow_amount_usd: 51.46, // round2(derived) — NOT the typed 40
        cashflow_amount_eur: 47.13,
        cashflow_user_set: true,
        original_amount: 40,
        original_currency: "GBP",
      }),
    );
    // The proportional (no-cost) leg carries no user-entered original.
    expect(children[1]).toEqual(
      expect.objectContaining({ original_amount: null, original_currency: null }),
    );
  });

  it("EUR-typed leg cost keeps the eur leg BYTE-EXACT; usd derived + round2'd", async () => {
    hoisted.toUsdAndEur.mockResolvedValue({ usd: 43.567891, eur: 40.123456 });
    const client = createMockClient(splitFromCalls());
    hoisted.mockClient = client;
    const res = await splitActivityEntry(ENTRY_ID, [
      { effective_date: "2026-01-01", quantity: 4, cost: { amount: 40.123456, currency: "EUR" } },
      { effective_date: "2026-01-02", quantity: 6 },
    ]);
    expect(res.success).toBe(true);
    const children = client.builders[1].insert.mock.calls[0][0] as Record<string, unknown>[];
    expect(children[0]).toEqual(
      expect.objectContaining({
        cashflow_amount_eur: 40.123456, // verbatim — no round2
        cashflow_amount_usd: 43.57,
        original_amount: 40.123456,
        original_currency: "EUR",
      }),
    );
  });

  it("USD-typed leg cost keeps the usd leg BYTE-EXACT; eur derived + round2'd", async () => {
    hoisted.toUsdAndEur.mockResolvedValue({ usd: 40.987654, eur: 37.876543 });
    const client = createMockClient(splitFromCalls());
    hoisted.mockClient = client;
    const res = await splitActivityEntry(ENTRY_ID, [
      { effective_date: "2026-01-01", quantity: 4, cost: { amount: 40.987654, currency: "USD" } },
      { effective_date: "2026-01-02", quantity: 6 },
    ]);
    expect(res.success).toBe(true);
    const children = client.builders[1].insert.mock.calls[0][0] as Record<string, unknown>[];
    expect(children[0]).toEqual(
      expect.objectContaining({
        cashflow_amount_usd: 40.987654, // verbatim — no round2
        cashflow_amount_eur: 37.88,
        original_amount: 40.987654,
        original_currency: "USD",
      }),
    );
  });

  it('rejects a malformed leg code ("ABCD") BEFORE any FX call', async () => {
    // validateCurrency throws inside the leg loop (consistent with the adjacent
    // validateAmount) — captureAction re-throws rather than mapping to
    // {success:false}. The point is the throw lands before toUsdAndEur runs.
    hoisted.mockClient = createMockClient([{ data: parent, error: null }]); // fetch parent
    await expect(
      splitActivityEntry(ENTRY_ID, [
        { effective_date: "2026-01-01", quantity: 4, cost: { amount: 40, currency: "ABCD" } },
        { effective_date: "2026-01-02", quantity: 6 },
      ]),
    ).rejects.toThrow('Invalid currency code: "ABCD"');
    expect(hoisted.toUsdAndEur).not.toHaveBeenCalled();
  });
});
