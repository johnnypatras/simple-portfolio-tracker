import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Unit test for transfers.ts — executeTransfer partial-failure cleanup guard (M8).
 *
 * When the DESTINATION leg fails AND the source ROLLBACK also fails, the transfer
 * is a "partial failure": the source position was modified and could not be
 * restored. In that state the orphan-entity cleanup (cleanupTransferEntities) MUST
 * be skipped — the created entities (e.g. a freshly-made destination wallet) may
 * be referenced by the modified-but-unrolled source, so hard-deleting them would
 * compound the corruption and destroy manual-recovery context. The load-bearing
 * line is the `!isPartial` guard at transfers.ts:~227.
 *
 * Strategy: stub the sub-action modules so a crypto→crypto transfer with a
 * `newWallet` destination runs offline. upsertPosition succeeds for the source
 * leg, then FAILS for the destination leg, then FAILS again for the rollback →
 * partialFailure. We assert:
 *   - result is { success:false, partialFailure:true }
 *   - the created wallet was NOT deleted (cleanup skipped — the guard held)
 */

const VALID_ASSET = "11111111-1111-4111-8111-111111111111";
const VALID_WALLET = "22222222-2222-4222-8222-222222222222";
const DEST_ASSET = "33333333-3333-4333-8333-333333333333";
const NEW_WALLET_ID = "44444444-4444-4444-8444-444444444444";

// ─── Hoisted mock state ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  mockClient: null as ReturnType<typeof createMockClient> | null,
  upsertPosition: vi.fn(),
  createWallet: vi.fn(),
  getPrices: vi.fn(),
  captureException: vi.fn(),
}));

// ─── Recording mock query builder ────────────────────────────────────────────
type FromCall = {
  table: string;
  result: { data: unknown; error: unknown };
  isDelete: boolean;
};

function createQueryBuilder(call: FromCall) {
  const builder: Record<string, unknown> & PromiseLike<unknown> = {
    select: vi.fn().mockReturnThis(),
    delete: vi.fn(() => {
      call.isDelete = true;
      return builder;
    }),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
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

function createMockClient(
  responses: Array<{ table: string; result: { data: unknown; error: unknown } }>,
) {
  let idx = 0;
  const fromCalls: FromCall[] = [];
  return {
    from: vi.fn((table: string) => {
      const resp = responses[idx] ?? { table, result: { data: null, error: null } };
      idx++;
      const call: FromCall = { table, result: resp.result, isDelete: false };
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

vi.mock("@/lib/actions/crypto", () => ({
  upsertPosition: hoisted.upsertPosition,
  createCryptoAsset: vi.fn(),
}));

vi.mock("@/lib/actions/wallets", () => ({
  createWallet: hoisted.createWallet,
}));

// Unused sub-actions on the crypto→crypto path, but the imports must resolve.
vi.mock("@/lib/actions/stocks", () => ({
  upsertStockPosition: vi.fn(),
  createStockAsset: vi.fn(),
}));
vi.mock("@/lib/actions/cash-accounts", () => ({
  createCashAccount: vi.fn(),
  updateCashAccount: vi.fn(),
}));
vi.mock("@/lib/actions/brokers", () => ({ createBroker: vi.fn() }));
vi.mock("@/lib/prices/coingecko", () => ({ getPrices: hoisted.getPrices }));
vi.mock("@/lib/prices/yahoo", () => ({ getStockPrices: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@sentry/nextjs", () => ({
  captureException: hoisted.captureException,
  addBreadcrumb: vi.fn(),
  captureMessage: vi.fn(),
}));

// ─── Import after mocks ──────────────────────────────────────────────────────
import { executeTransfer } from "@/lib/actions/transfers";
import type { TransferInput } from "@/lib/types";

beforeEach(() => {
  vi.clearAllMocks();
  // Prices: one coingecko id present so fetchPrices populates (not required, but
  // realistic). Keyed by the asset's coingecko_id stubbed in the DB response.
  hoisted.getPrices.mockResolvedValue({
    "src-coin": { usd: 100, eur: 90 },
    "dst-coin": { usd: 100, eur: 90 },
  });
  hoisted.createWallet.mockResolvedValue(NEW_WALLET_ID);
});

describe("executeTransfer — partial-failure skips entity cleanup (M8)", () => {
  it("dest leg fails + rollback fails → {success:false, partialFailure:true} and the created wallet is NOT cleaned up", async () => {
    // upsertPosition: call 1 (source leg) OK, call 2 (dest leg) THROWS,
    // call 3 (rollback) THROWS → partialFailure.
    hoisted.upsertPosition
      .mockResolvedValueOnce(undefined) // source leg
      .mockRejectedValueOnce(new Error("dest leg write failed")) // destination leg
      .mockRejectedValueOnce(new Error("rollback write failed")); // rollback

    // FIFO DB responses in call order:
    //   1) fetchSourceState (early balance check, source crypto) → quantity 5
    //   2) fetchSourceState (again, inside the source-leg block) → quantity 5
    //   3) fetchPrices crypto_assets .in() → both assets w/ coingecko ids
    //   4) executeDestLeg existing crypto_positions .single() → quantity 0
    // (No cleanup reads expected — the guard skips them; if cleanup DID run it
    //  would issue from("wallets").delete(), which we assert never happens.)
    hoisted.mockClient = createMockClient([
      { table: "crypto_positions", result: { data: { quantity: 5 }, error: null } },
      { table: "crypto_positions", result: { data: { quantity: 5 }, error: null } },
      {
        table: "crypto_assets",
        result: {
          data: [
            { id: VALID_ASSET, coingecko_id: "src-coin" },
            { id: DEST_ASSET, coingecko_id: "dst-coin" },
          ],
          error: null,
        },
      },
      { table: "crypto_positions", result: { data: { quantity: 0 }, error: null } },
    ]);

    const input: TransferInput = {
      mode: "move",
      source: { type: "crypto_position", assetId: VALID_ASSET, walletId: VALID_WALLET, quantity: 2 },
      destination: { type: "crypto_position", assetId: DEST_ASSET, walletId: NEW_WALLET_ID, quantity: 2 },
      // A newWallet makes createdEntities non-empty, so the cleanup guard is the
      // ONLY reason cleanup is skipped (not an empty entity list).
      newWallet: { name: "Dest Wallet" },
    };

    const result = await executeTransfer(input);

    // Partial-failure contract.
    expect(result.success).toBe(false);
    expect(result.partialFailure).toBe(true);

    // The wallet was created (entity tracked)…
    expect(hoisted.createWallet).toHaveBeenCalledTimes(1);
    // …but cleanup was SKIPPED — no DELETE was ever issued (the !isPartial guard
    // held). A regression that drops the guard would fire from("wallets").delete().
    const anyDelete = hoisted.mockClient!._fromCalls.some((c) => c.isDelete);
    expect(anyDelete).toBe(false);
    // Specifically, the created wallet was not hard-deleted.
    const walletDeleted = hoisted.mockClient!._fromCalls.some(
      (c) => c.table === "wallets" && c.isDelete,
    );
    expect(walletDeleted).toBe(false);

    // The transfer-level Sentry capture fired with the partial tag.
    expect(hoisted.captureException).toHaveBeenCalledTimes(1);
    const [, ctx] = hoisted.captureException.mock.calls[0];
    expect(ctx).toMatchObject({
      tags: { action: "transfers.executeTransfer", partial: "true" },
    });

    // upsertPosition was called exactly 3× (source, dest, rollback).
    expect(hoisted.upsertPosition).toHaveBeenCalledTimes(3);
  });
});
