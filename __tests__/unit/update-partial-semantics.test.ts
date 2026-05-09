import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Cross-module regression tests for partial-update semantics.
 *
 * The pattern: `value ?? default` (or `value || null`) inside an object handed
 * to `partialUpdate(...)` defeats partialUpdate's purpose. Once `undefined`
 * has been coerced to a real value, partialUpdate keeps it and writes it,
 * clobbering existing DB columns.
 *
 * See cash-accounts.test.ts for the cash-account variant. This file covers
 * the analogous fixes in wallets.ts (`chain`) and trades.ts (`notes`).
 */

// ─── Hoisted mock state ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  mockClient: null as ReturnType<typeof createMockClient> | null,
}));

// ─── Mock helpers (same shape as cash-accounts.test.ts) ──────────────────────

function createQueryBuilder(resolveValue: unknown) {
  const builder: Record<string, unknown> & PromiseLike<unknown> = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockReturnThis(),
    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(resolveValue).then(onfulfilled, onrejected) as PromiseLike<TResult1 | TResult2>;
    },
  };
  return builder;
}

function createMockClient(fromCalls: unknown[]) {
  let callIndex = 0;
  return {
    from: vi.fn(() => {
      const result = fromCalls[callIndex] ?? { data: null, error: null };
      callIndex++;
      return createQueryBuilder(result);
    }),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      }),
    },
  };
}

// ─── Module mocks ────────────────────────────────────────────────────────────
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.mockClient),
}));

vi.mock("@/lib/actions/activity-log", () => ({
  logActivity: vi.fn(),
  toUsdAndEur: vi.fn().mockResolvedValue({ usd: 100, eur: 92 }),
}));

vi.mock("@/lib/cashflow", () => ({
  computeCashflowFromPrices: vi.fn().mockReturnValue({ usd: 100, eur: 92 }),
  classifyAssetClass: vi.fn().mockReturnValue("cash"),
  isStablecoin: vi.fn().mockReturnValue(false),
}));

// crypto.upsertPosition imports from these — mock them so we can run it in isolation.
vi.mock("@/lib/actions/revalidate", () => ({
  revalidateDashboard: vi.fn(),
  revalidateCashPaths: vi.fn(),
}));

vi.mock("@/lib/activity-fx", () => ({
  computeActivityFx: vi.fn().mockResolvedValue({
    deltaUsd: 0,
    deltaEur: 0,
    deltaStatus: "complete",
    cashflowUsd: null,
    cashflowEur: null,
    cashflowAssetClass: null,
    cashflowStatus: null,
  }),
  emptyFx: vi.fn().mockReturnValue({
    deltaUsd: 0,
    deltaEur: 0,
    deltaStatus: null,
    cashflowUsd: null,
    cashflowEur: null,
    cashflowAssetClass: null,
    cashflowStatus: null,
  }),
}));

vi.mock("@/lib/validation", () => ({
  validateAmount: vi.fn(),
  validateApy: vi.fn(),
  validateCurrency: vi.fn(),
  validateDate: vi.fn(),
  validateName: vi.fn(),
  validateQuantity: vi.fn(),
  validateUUID: vi.fn(),
}));

// rate-limit mock — wallets.ts and trades.ts may not use it but harmless if not
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ allowed: true })),
}));

// Import after mocks
import { updateWallet } from "@/lib/actions/wallets";
import { updateTradeEntry } from "@/lib/actions/trades";
import { upsertPosition } from "@/lib/actions/crypto";

// ─── Helper to extract the .update() payload from the mock chain ─────────────
function getUpdatePayload(client: ReturnType<typeof createMockClient>, callIndex: number): Record<string, unknown> {
  const builder = client.from.mock.results[callIndex]?.value as { update: ReturnType<typeof vi.fn> };
  return builder.update.mock.calls[0]?.[0] as Record<string, unknown>;
}

// ─── updateWallet — chain preservation ───────────────────────────────────────
describe("updateWallet — partial-update semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("omitting `chain` from input does NOT include chain in update payload", async () => {
    // Mock chain: 1) before snapshot, 2) update, then optional sibling rename,
    // institution update, etc. We only need to inspect the first update call.
    hoisted.mockClient = createMockClient([
      // before snapshot fetch
      {
        data: {
          id: "w-id",
          user_id: "user-123",
          name: "Old Name",
          wallet_type: "custodial",
          chain: "Ethereum",
          institution_id: null,
        },
        error: null,
      },
      // update result
      { error: null },
      // after snapshot fetch (for activity log)
      {
        data: {
          id: "w-id",
          user_id: "user-123",
          name: "New Name",
          wallet_type: "custodial",
          chain: "Ethereum",
        },
        error: null,
      },
    ]);

    await updateWallet(
      "aaaaaaaa-0000-0000-0000-000000000001",
      { name: "New Name", wallet_type: "custodial" /* no chain */ },
    );

    const payload = getUpdatePayload(hoisted.mockClient!, 1);
    expect(payload).not.toHaveProperty("chain");
    expect(payload.name).toBe("New Name");
    expect(payload.wallet_type).toBe("custodial");
  });

  it("explicit chain=null clears the chain (preserved through partialUpdate)", async () => {
    hoisted.mockClient = createMockClient([
      {
        data: {
          id: "w-id",
          user_id: "user-123",
          name: "Old",
          wallet_type: "custodial",
          chain: "Ethereum",
          institution_id: null,
        },
        error: null,
      },
      { error: null },
      {
        data: {
          id: "w-id",
          user_id: "user-123",
          name: "Old",
          wallet_type: "custodial",
          chain: null,
        },
        error: null,
      },
    ]);

    await updateWallet(
      "aaaaaaaa-0000-0000-0000-000000000001",
      { name: "Old", wallet_type: "custodial", chain: null },
    );

    const payload = getUpdatePayload(hoisted.mockClient!, 1);
    expect(payload).toHaveProperty("chain");
    expect(payload.chain).toBeNull();
  });

  it("non-empty chain string is normalized and written", async () => {
    hoisted.mockClient = createMockClient([
      {
        data: {
          id: "w-id",
          user_id: "user-123",
          name: "Old",
          wallet_type: "custodial",
          chain: null,
          institution_id: null,
        },
        error: null,
      },
      { error: null },
      {
        data: {
          id: "w-id",
          user_id: "user-123",
          name: "Old",
          wallet_type: "custodial",
          chain: "Solana",
        },
        error: null,
      },
    ]);

    await updateWallet(
      "aaaaaaaa-0000-0000-0000-000000000001",
      { name: "Old", wallet_type: "custodial", chain: "  Solana  " },
    );

    const payload = getUpdatePayload(hoisted.mockClient!, 1);
    expect(payload.chain).toBe("Solana");
  });
});

// ─── updateTradeEntry — notes preservation ───────────────────────────────────
describe("updateTradeEntry — partial-update semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("omitting `notes` from input does NOT include notes in update payload", async () => {
    hoisted.mockClient = createMockClient([
      // before snapshot
      {
        data: {
          id: "t-id",
          user_id: "user-123",
          trade_date: "2026-01-15",
          asset_type: "stock",
          asset_name: "AAPL",
          action: "buy",
          quantity: 10,
          price: 200,
          currency: "USD",
          total_value: 2000,
          notes: "Existing note",
        },
        error: null,
      },
      // update result
      { error: null },
      // after snapshot
      {
        data: {
          id: "t-id",
          user_id: "user-123",
          trade_date: "2026-01-15",
          asset_type: "stock",
          asset_name: "AAPL",
          action: "buy",
          quantity: 12,
          price: 200,
          currency: "USD",
          total_value: 2400,
          notes: "Existing note",
        },
        error: null,
      },
    ]);

    await updateTradeEntry(
      "aaaaaaaa-0000-0000-0000-000000000001",
      {
        trade_date: "2026-01-15",
        asset_type: "stock",
        asset_name: "AAPL",
        action: "buy",
        quantity: 12,
        price: 200,
        currency: "USD",
        // no notes
      },
    );

    const payload = getUpdatePayload(hoisted.mockClient!, 1);
    expect(payload).not.toHaveProperty("notes");
    expect(payload.quantity).toBe(12);
    expect(payload.total_value).toBe(2400);
  });

  it("explicit empty-string notes clears the field (normalizes to null)", async () => {
    hoisted.mockClient = createMockClient([
      {
        data: {
          id: "t-id",
          user_id: "user-123",
          trade_date: "2026-01-15",
          asset_type: "stock",
          asset_name: "AAPL",
          action: "buy",
          quantity: 10,
          price: 200,
          currency: "USD",
          total_value: 2000,
          notes: "Existing",
        },
        error: null,
      },
      { error: null },
      {
        data: {
          id: "t-id",
          user_id: "user-123",
          trade_date: "2026-01-15",
          asset_type: "stock",
          asset_name: "AAPL",
          action: "buy",
          quantity: 10,
          price: 200,
          currency: "USD",
          total_value: 2000,
          notes: null,
        },
        error: null,
      },
    ]);

    await updateTradeEntry(
      "aaaaaaaa-0000-0000-0000-000000000001",
      {
        trade_date: "2026-01-15",
        asset_type: "stock",
        asset_name: "AAPL",
        action: "buy",
        quantity: 10,
        price: 200,
        currency: "USD",
        notes: "",
      },
    );

    const payload = getUpdatePayload(hoisted.mockClient!, 1);
    expect(payload).toHaveProperty("notes");
    expect(payload.notes).toBeNull();
  });

  it("non-empty notes are trimmed and written", async () => {
    hoisted.mockClient = createMockClient([
      {
        data: {
          id: "t-id",
          user_id: "user-123",
          trade_date: "2026-01-15",
          asset_type: "stock",
          asset_name: "AAPL",
          action: "buy",
          quantity: 10,
          price: 200,
          currency: "USD",
          total_value: 2000,
          notes: null,
        },
        error: null,
      },
      { error: null },
      {
        data: {
          id: "t-id",
          user_id: "user-123",
          trade_date: "2026-01-15",
          asset_type: "stock",
          asset_name: "AAPL",
          action: "buy",
          quantity: 10,
          price: 200,
          currency: "USD",
          total_value: 2000,
          notes: "Earnings call",
        },
        error: null,
      },
    ]);

    await updateTradeEntry(
      "aaaaaaaa-0000-0000-0000-000000000001",
      {
        trade_date: "2026-01-15",
        asset_type: "stock",
        asset_name: "AAPL",
        action: "buy",
        quantity: 10,
        price: 200,
        currency: "USD",
        notes: "  Earnings call  ",
      },
    );

    const payload = getUpdatePayload(hoisted.mockClient!, 1);
    expect(payload.notes).toBe("Earnings call");
  });
});

// ─── upsertPosition (crypto) — network preservation ──────────────────────────
//
// `upsertPosition` is INSERT-OR-UPDATE. The update branch hands a payload to
// partialUpdate() that must preserve `network` when the caller (e.g. a transfer
// destination) doesn't pass it. Same bug class as cash-accounts apy / wallets
// chain — flagged here for crypto positions specifically.
describe("upsertPosition — partial-update semantics (network preservation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transfer-style call (no network field) does NOT include network in update payload", async () => {
    // Mock chain for upsertPosition (existing-position update branch):
    //   1. crypto_assets.select.eq.is.single → asset (for ticker + subcategory)
    //   2. crypto_positions.select.eq.eq.is.single → before snapshot
    //   3. crypto_positions.update(partialUpdate(...)).eq → captured here
    //   4. crypto_positions.select.eq.eq.is.single → after snapshot
    hoisted.mockClient = createMockClient([
      // 1) asset lookup
      { data: { ticker: "ETH", subcategory: null }, error: null },
      // 2) before snapshot — position with network already set
      {
        data: {
          id: "pos-id",
          crypto_asset_id: "asset-id",
          wallet_id: "wallet-id",
          quantity: 10,
          acquisition_method: "bought",
          apy: 4.5,
          network: "Linea",
          last_was_adjustment: false,
          last_was_transfer: false,
        },
        error: null,
      },
      // 3) update result
      { error: null },
      // 4) after snapshot
      {
        data: {
          id: "pos-id",
          crypto_asset_id: "asset-id",
          wallet_id: "wallet-id",
          quantity: 12,
          acquisition_method: "bought",
          apy: 4.5,
          network: "Linea",
          last_was_adjustment: true,
          last_was_transfer: true,
        },
        error: null,
      },
    ]);

    await upsertPosition(
      {
        crypto_asset_id: "aaaaaaaa-0000-0000-0000-000000000001",
        wallet_id: "aaaaaaaa-0000-0000-0000-000000000002",
        quantity: 12,
        // no network, no apy, no acquisition_method
      },
      { isAdjustment: true, transferGroupId: "transfer-group-id" },
    );

    // Update is the THIRD from() call (asset, before, update, after)
    const payload = getUpdatePayload(hoisted.mockClient!, 2);
    expect(payload).not.toHaveProperty("network");
    expect(payload).not.toHaveProperty("apy");
    expect(payload).not.toHaveProperty("acquisition_method");

    // Sanity: fields that ARE passed get written
    expect(payload.quantity).toBe(12);
    expect(payload.last_was_adjustment).toBe(true);
    expect(payload.last_was_transfer).toBe(true);
  });

  it("explicit network=null clears the network in update payload", async () => {
    hoisted.mockClient = createMockClient([
      { data: { ticker: "ETH", subcategory: null }, error: null },
      {
        data: {
          id: "pos-id",
          crypto_asset_id: "asset-id",
          wallet_id: "wallet-id",
          quantity: 10,
          network: "Ethereum",
        },
        error: null,
      },
      { error: null },
      {
        data: {
          id: "pos-id",
          crypto_asset_id: "asset-id",
          wallet_id: "wallet-id",
          quantity: 10,
          network: null,
        },
        error: null,
      },
    ]);

    await upsertPosition({
      crypto_asset_id: "aaaaaaaa-0000-0000-0000-000000000001",
      wallet_id: "aaaaaaaa-0000-0000-0000-000000000002",
      quantity: 10,
      network: null,
    });

    const payload = getUpdatePayload(hoisted.mockClient!, 2);
    expect(payload).toHaveProperty("network");
    expect(payload.network).toBeNull();
  });

  it("non-empty network is trimmed and written", async () => {
    hoisted.mockClient = createMockClient([
      { data: { ticker: "ETH", subcategory: null }, error: null },
      {
        data: {
          id: "pos-id",
          crypto_asset_id: "asset-id",
          wallet_id: "wallet-id",
          quantity: 10,
          network: null,
        },
        error: null,
      },
      { error: null },
      {
        data: {
          id: "pos-id",
          crypto_asset_id: "asset-id",
          wallet_id: "wallet-id",
          quantity: 10,
          network: "Base",
        },
        error: null,
      },
    ]);

    await upsertPosition({
      crypto_asset_id: "aaaaaaaa-0000-0000-0000-000000000001",
      wallet_id: "aaaaaaaa-0000-0000-0000-000000000002",
      quantity: 10,
      network: "  Base  ",
    });

    const payload = getUpdatePayload(hoisted.mockClient!, 2);
    expect(payload.network).toBe("Base");
  });
});
