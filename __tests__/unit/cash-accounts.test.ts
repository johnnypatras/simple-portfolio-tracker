import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Unit tests for mergeCashAccounts and findExistingCash from cash-accounts.ts.
 *
 * Strategy: mock `createServerSupabaseClient` to return a fake Supabase client
 * with controlled query results. Also mock activity-log, validation, and
 * next/cache to avoid side-effects from the "use server" module.
 */

// ─── Hoisted mock state ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  mockClient: null as ReturnType<typeof createMockClient> | null,
  updateCashAccountCalls: [] as { id: string; input: unknown; opts: unknown }[],
  deleteCashAccountCalls: [] as { id: string; opts: unknown }[],
}));

// ─── Mock helpers ────────────────────────────────────────────────────────────

/**
 * Creates a fake Supabase query builder that returns preset results.
 *
 * The Supabase client chain: .from(...).select(...).eq(...).is(...).single()
 * All builder methods return `this` and the object itself is thenable.
 */
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

/**
 * Builds a mock Supabase client whose `.from()` returns per-call query builders.
 * Also stubs `auth.getUser()` to return a test user.
 */
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

// ─── Module mocks (hoisted before imports) ───────────────────────────────────
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.mockClient),
}));

// Mock activity-log to avoid FX API calls and DB writes
vi.mock("@/lib/actions/activity-log", () => ({
  logActivity: vi.fn(),
  toUsdAndEur: vi.fn().mockResolvedValue({ usd: 100, eur: 92 }),
}));

// Mock cashflow module
vi.mock("@/lib/cashflow", () => ({
  computeCashflowFromPrices: vi.fn().mockReturnValue({ usd: 100, eur: 92 }),
  classifyAssetClass: vi.fn().mockReturnValue("cash"),
}));

// Mock validation (pass-through — not testing validation here)
vi.mock("@/lib/validation", () => ({
  validateAmount: vi.fn(),
  validateApy: vi.fn(),
  validateCurrency: vi.fn(),
  validateName: vi.fn(),
  validateUUID: vi.fn(),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────
import { mergeCashAccounts, findExistingCash, updateCashAccount, createCashAccount } from "@/lib/actions/cash-accounts";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("createCashAccount — bank must have an institution (orphan guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // auth.getUser() resolves a user; the guard throws before any DB write,
    // so no preset .from() results are needed for the throwing cases.
    hoisted.mockClient = createMockClient([]);
  });

  it("throws when a bank-origin account has no institution (and no wallet/broker)", async () => {
    await expect(
      createCashAccount({ currency: "EUR", balance: 100 }),
    ).rejects.toThrow("A bank account must have a bank");
  });

  it("throws even when a name is provided but no bank", async () => {
    await expect(
      createCashAccount({ currency: "EUR", balance: 100, name: "Savings" }),
    ).rejects.toThrow(/must have a bank/);
  });

  it("does NOT apply the guard to a wallet deposit — proceeds to a successful insert", async () => {
    // A wallet/broker deposit has no institution_id by design. The guard must
    // not fire: with a successful insert mock the call RESOLVES (a positive
    // assertion — if the guard wrongly fired it would reject with "must have a
    // bank", which can never resolve). Stronger than asserting a downstream error.
    hoisted.mockClient = createMockClient([
      { data: { id: "dep-1", balance: 100, currency: "EUR" }, error: null }, // insert
    ]);
    await expect(
      createCashAccount({ currency: "EUR", balance: 100, wallet_id: "11111111-2222-3333-4444-555555555555" }),
    ).resolves.toBe("dep-1");
  });

  it("does NOT apply the guard to a broker deposit either", async () => {
    hoisted.mockClient = createMockClient([
      { data: { id: "dep-2", balance: 50, currency: "USD" }, error: null }, // insert
    ]);
    await expect(
      createCashAccount({ currency: "USD", balance: 50, broker_id: "22222222-3333-4444-5555-666666666666" }),
    ).resolves.toBe("dep-2");
  });
});

describe("mergeCashAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.updateCashAccountCalls = [];
    hoisted.deleteCashAccountCalls = [];
  });

  it("throws when merging an account with itself", async () => {
    await expect(
      mergeCashAccounts("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    ).rejects.toThrow("Cannot merge a cash account with itself");
  });

  it("throws when accounts are at different institutions", async () => {
    // from() call 1: auth.getUser() is on the mock client
    // mergeCashAccounts calls createServerSupabaseClient, then getUser,
    // then two .from("cash_accounts") calls for survivor and duplicate.
    hoisted.mockClient = createMockClient([
      // survivor fetch
      {
        data: {
          id: "surv-id",
          user_id: "user-123",
          institution_id: "inst-A",
          currency: "EUR",
          balance: 5000,
          name: "Savings A",
          apy: 0,
          region: null,
          wallet_id: null,
          broker_id: null,
        },
        error: null,
      },
      // duplicate fetch
      {
        data: {
          id: "dup-id",
          user_id: "user-123",
          institution_id: "inst-B",
          currency: "EUR",
          balance: 500,
          name: "Savings B",
          apy: 0,
          region: null,
          wallet_id: null,
          broker_id: null,
        },
        error: null,
      },
    ]);

    await expect(
      mergeCashAccounts(
        "aaaaaaaa-0000-0000-0000-000000000001",
        "aaaaaaaa-0000-0000-0000-000000000002",
      ),
    ).rejects.toThrow("Cash accounts must be at the same institution");
  });

  it("throws when accounts have different currencies", async () => {
    hoisted.mockClient = createMockClient([
      // survivor: EUR
      {
        data: {
          id: "surv-id",
          user_id: "user-123",
          institution_id: "inst-A",
          currency: "EUR",
          balance: 5000,
          name: "EUR Account",
          apy: 0,
          region: null,
          wallet_id: null,
          broker_id: null,
        },
        error: null,
      },
      // duplicate: USD
      {
        data: {
          id: "dup-id",
          user_id: "user-123",
          institution_id: "inst-A",
          currency: "USD",
          balance: 1000,
          name: "USD Account",
          apy: 0,
          region: null,
          wallet_id: null,
          broker_id: null,
        },
        error: null,
      },
    ]);

    await expect(
      mergeCashAccounts(
        "aaaaaaaa-0000-0000-0000-000000000001",
        "aaaaaaaa-0000-0000-0000-000000000002",
      ),
    ).rejects.toThrow("Cash accounts must have the same currency");
  });

  it("throws when one account is not found", async () => {
    hoisted.mockClient = createMockClient([
      // survivor found
      {
        data: {
          id: "surv-id",
          user_id: "user-123",
          institution_id: "inst-A",
          currency: "EUR",
          balance: 5000,
          name: "Savings",
          apy: 0,
          region: null,
          wallet_id: null,
          broker_id: null,
        },
        error: null,
      },
      // duplicate not found
      { data: null, error: null },
    ]);

    await expect(
      mergeCashAccounts(
        "aaaaaaaa-0000-0000-0000-000000000001",
        "aaaaaaaa-0000-0000-0000-000000000002",
      ),
    ).rejects.toThrow("One or both cash accounts not found");
  });

  it("computes correct merged balance (6500 + 500 = 7000)", async () => {
    // The merge function calls:
    // 1. createServerSupabaseClient + getUser
    // 2. from("cash_accounts").select.eq.eq.is.single → survivor
    // 3. from("cash_accounts").select.eq.eq.is.single → duplicate
    // Then it calls updateCashAccount(survivorId, { balance: 7000, ... })
    // which internally calls createServerSupabaseClient again.
    // We need enough from() results for all DB calls in both merge + update + delete.

    // For the merge itself (fetching survivor & duplicate):
    const mergeClient = createMockClient([
      // survivor fetch
      {
        data: {
          id: "surv-id",
          user_id: "user-123",
          institution_id: "inst-A",
          currency: "EUR",
          balance: 6500,
          name: "Main Account",
          apy: 1.5,
          region: "GR",
          wallet_id: null,
          broker_id: null,
        },
        error: null,
      },
      // duplicate fetch
      {
        data: {
          id: "dup-id",
          user_id: "user-123",
          institution_id: "inst-A",
          currency: "EUR",
          balance: 500,
          name: "Duplicate",
          apy: 0,
          region: "GR",
          wallet_id: null,
          broker_id: null,
        },
        error: null,
      },
    ]);

    // After merge fetches, it calls updateCashAccount and deleteCashAccount,
    // each of which calls createServerSupabaseClient. We track calls by
    // swapping the mock client for each subsequent call.

    // Track how updateCashAccount is called by intercepting createServerSupabaseClient.
    // Each call to updateCashAccount/deleteCashAccount gets a fresh client.
    const updateClient = createMockClient([
      // institution ownership check (runs first in updateCashAccount when an
      // institution_id is supplied) → returns a row = caller owns it
      { data: { id: "inst-A" }, error: null },
      // before snapshot fetch
      { data: { id: "surv-id", balance: 6500, currency: "EUR" }, error: null },
      // update query
      { error: null },
      // after snapshot fetch
      { data: { id: "surv-id", balance: 7000, currency: "EUR" }, error: null },
      // resolveDisplayNames: institution lookup
      { data: { name: "Alpha Bank" }, error: null },
    ]);

    const deleteClient = createMockClient([
      // snapshot fetch for delete
      {
        data: {
          id: "dup-id",
          balance: 500,
          currency: "EUR",
          name: "Duplicate",
          institutions: null,
          wallets: null,
          brokers: null,
        },
        error: null,
      },
      // soft-delete update
      { error: null },
    ]);

    const { createServerSupabaseClient } = await import(
      "@/lib/supabase/server"
    );
    const mockCreate = vi.mocked(createServerSupabaseClient);

    // First call → merge client (fetches survivor + duplicate)
    // Second call → update client (updateCashAccount)
    // Third call → delete client (deleteCashAccount)
    mockCreate
      .mockResolvedValueOnce(mergeClient as never)
      .mockResolvedValueOnce(updateClient as never)
      .mockResolvedValueOnce(deleteClient as never);

    await mergeCashAccounts(
      "aaaaaaaa-0000-0000-0000-000000000001",
      "aaaaaaaa-0000-0000-0000-000000000002",
    );

    // Verify updateCashAccount was called — the update client's from() should have been invoked.
    // The update client's .from() is called for: institution ownership check,
    // before fetch, update, after fetch, display names.
    expect(updateClient.from).toHaveBeenCalled();

    // The THIRD .from() call is the update (index 2: after the ownership check
    // and the before-snapshot fetch) — check that .update() was called on it.
    const updateBuilder = updateClient.from.mock.results[2]?.value;
    expect(updateBuilder.update).toHaveBeenCalled();

    // Verify the balance in the update call: the update builder's update() should receive { balance: 7000, ... }
    const updateArg = updateBuilder.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updateArg.balance).toBe(7000);
  });
});

describe("findExistingCash", () => {
  it("returns matching records for institution + currency", async () => {
    const mockClient = createMockClient([
      {
        data: [
          {
            id: "ca1",
            user_id: "user-123",
            institution_id: "inst-A",
            currency: "EUR",
            balance: 5000,
          },
          {
            id: "ca2",
            user_id: "user-123",
            institution_id: "inst-A",
            currency: "EUR",
            balance: 3000,
          },
        ],
        error: null,
      },
    ]);

    // findExistingCash takes a pre-built supabase client, no need for mock injection
    const result = await findExistingCash(
      mockClient as never,
      "user-123",
      "inst-A",
      "EUR",
    );

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("ca1");
    expect(result[1].id).toBe("ca2");
  });

  it("returns empty array when no match exists", async () => {
    const mockClient = createMockClient([
      { data: [], error: null },
    ]);

    const result = await findExistingCash(
      mockClient as never,
      "user-123",
      "inst-X",
      "GBP",
    );

    expect(result).toEqual([]);
  });

  it("filters out soft-deleted records via .is('deleted_at', null)", async () => {
    // The query builder chains .is("deleted_at", null).
    // We verify the chain is called correctly and only non-deleted data is returned.
    const mockClient = createMockClient([
      {
        data: [
          {
            id: "ca-active",
            user_id: "user-123",
            institution_id: "inst-A",
            currency: "EUR",
            balance: 5000,
            deleted_at: null,
          },
        ],
        error: null,
      },
    ]);

    const result = await findExistingCash(
      mockClient as never,
      "user-123",
      "inst-A",
      "EUR",
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ca-active");

    // Verify .is() was called with "deleted_at" and null (soft-delete filter)
    const fromResult = mockClient.from.mock.results[0]?.value;
    expect(fromResult.is).toHaveBeenCalledWith("deleted_at", null);
  });
});

// ─── updateCashAccount partial-update semantics ──────────────────────────────
//
// Regression tests for the "transfer destination clobbers APY/name" bug.
//
// When the transfers.ts destination handler calls updateCashAccount with only
// { currency, balance }, the update payload sent to Supabase MUST NOT include
// the unsupplied fields (apy, name, institution_id, region, wallet_id,
// broker_id) — otherwise existing values get clobbered by default coercions.
//
// The fix: input fields the caller didn't pass are forwarded as `undefined`
// and stripped by partialUpdate(). These tests assert that contract.
describe("updateCashAccount — partial-update semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function captureUpdatePayload(): { client: ReturnType<typeof createMockClient>; getPayload: () => Record<string, unknown> } {
    // Mock chain for updateCashAccount with no display-name resolution
    // (input has no institution_id/wallet_id/broker_id):
    //   1. before snapshot fetch
    //   2. .update() — payload captured here
    //   3. after snapshot fetch
    const client = createMockClient([
      // before snapshot
      {
        data: {
          id: "ca-id",
          user_id: "user-123",
          institution_id: "inst-A",
          currency: "USD",
          balance: 3546,
          name: "USD Savings",
          apy: 3.3,
          region: "US",
          wallet_id: null,
          broker_id: "broker-A",
        },
        error: null,
      },
      // update result
      { error: null },
      // after snapshot
      {
        data: {
          id: "ca-id",
          user_id: "user-123",
          institution_id: "inst-A",
          currency: "USD",
          balance: 4317.47,
          name: "USD Savings",
          apy: 3.3,
          region: "US",
          wallet_id: null,
          broker_id: "broker-A",
        },
        error: null,
      },
    ]);
    return {
      client,
      getPayload: () => {
        // Second from() call is the update — its builder captured the payload
        const updateBuilder = client.from.mock.results[1]?.value as {
          update: ReturnType<typeof vi.fn>;
        };
        return updateBuilder.update.mock.calls[0]?.[0] as Record<string, unknown>;
      },
    };
  }

  it("transfer-style call (currency + balance only) does NOT include apy in update payload", async () => {
    const { client, getPayload } = captureUpdatePayload();
    hoisted.mockClient = client;

    await updateCashAccount(
      "aaaaaaaa-0000-0000-0000-000000000001",
      { currency: "USD", balance: 4317.47 },
      { isAdjustment: true, transferGroupId: "transfer-group-id" },
    );

    const payload = getPayload();
    expect(payload).not.toHaveProperty("apy");
    expect(payload).not.toHaveProperty("name");
    expect(payload).not.toHaveProperty("institution_id");
    expect(payload).not.toHaveProperty("region");
    expect(payload).not.toHaveProperty("wallet_id");
    expect(payload).not.toHaveProperty("broker_id");

    // Sanity: the fields the caller DID pass are written
    expect(payload.currency).toBe("USD");
    expect(payload.balance).toBe(4317.47);

    // Badge flags are always written (badge precedence rule)
    expect(payload.last_was_adjustment).toBe(true);
    expect(payload.last_was_transfer).toBe(true);
  });

  it("modal-style call (full payload with apy=3.3) writes apy in update payload", async () => {
    const { client, getPayload } = captureUpdatePayload();
    hoisted.mockClient = client;

    await updateCashAccount(
      "aaaaaaaa-0000-0000-0000-000000000001",
      { currency: "USD", balance: 1000, apy: 3.3, name: "Savings" },
    );

    const payload = getPayload();
    expect(payload.apy).toBe(3.3);
    expect(payload.name).toBe("Savings");
    expect(payload.currency).toBe("USD");
    expect(payload.balance).toBe(1000);
  });

  it("explicit apy=0 from caller is preserved in update payload (not stripped)", async () => {
    const { client, getPayload } = captureUpdatePayload();
    hoisted.mockClient = client;

    await updateCashAccount(
      "aaaaaaaa-0000-0000-0000-000000000001",
      { currency: "USD", balance: 1000, apy: 0 },
    );

    const payload = getPayload();
    expect(payload).toHaveProperty("apy");
    expect(payload.apy).toBe(0);
  });

  it("explicit name=null from caller writes null (clear name)", async () => {
    const { client, getPayload } = captureUpdatePayload();
    hoisted.mockClient = client;

    await updateCashAccount(
      "aaaaaaaa-0000-0000-0000-000000000001",
      { currency: "USD", balance: 1000, name: null },
    );

    const payload = getPayload();
    expect(payload).toHaveProperty("name");
    expect(payload.name).toBeNull();
  });

  it("empty-string name from caller normalizes to null (clear name)", async () => {
    const { client, getPayload } = captureUpdatePayload();
    hoisted.mockClient = client;

    await updateCashAccount(
      "aaaaaaaa-0000-0000-0000-000000000001",
      { currency: "USD", balance: 1000, name: "   " },
    );

    const payload = getPayload();
    expect(payload).toHaveProperty("name");
    expect(payload.name).toBeNull();
  });

  it("non-transfer non-adjustment update sets badge flags to false", async () => {
    const { client, getPayload } = captureUpdatePayload();
    hoisted.mockClient = client;

    await updateCashAccount(
      "aaaaaaaa-0000-0000-0000-000000000001",
      { currency: "USD", balance: 1000 },
    );

    const payload = getPayload();
    expect(payload.last_was_adjustment).toBe(false);
    expect(payload.last_was_transfer).toBe(false);
  });

  // ─── New partial-update API enabled by the type split ──────────────────────
  // After CashAccountUpdateInput = Partial<CashAccountCreateInput>, callers can
  // omit any field — including currency and balance — and the function must
  // not crash. Runtime validation is gated on `if (input.X !== undefined)`.

  it("apy-only update (no currency, no balance) writes only apy + flags", async () => {
    const { client, getPayload } = captureUpdatePayload();
    hoisted.mockClient = client;

    await updateCashAccount(
      "aaaaaaaa-0000-0000-0000-000000000001",
      { apy: 5.5 },
    );

    const payload = getPayload();
    expect(payload).toHaveProperty("apy");
    expect(payload.apy).toBe(5.5);
    expect(payload).not.toHaveProperty("currency");
    expect(payload).not.toHaveProperty("balance");
    expect(payload).not.toHaveProperty("name");
    expect(payload.last_was_adjustment).toBe(false);
    expect(payload.last_was_transfer).toBe(false);
  });

  it("name-only update writes only name + flags", async () => {
    const { client, getPayload } = captureUpdatePayload();
    hoisted.mockClient = client;

    await updateCashAccount(
      "aaaaaaaa-0000-0000-0000-000000000001",
      { name: "Renamed account" },
    );

    const payload = getPayload();
    expect(payload).toHaveProperty("name");
    expect(payload.name).toBe("Renamed account");
    expect(payload).not.toHaveProperty("currency");
    expect(payload).not.toHaveProperty("balance");
    expect(payload).not.toHaveProperty("apy");
  });

  it("empty-object update is a complete no-op (no SQL UPDATE, no log, no badge change)", async () => {
    const { client } = captureUpdatePayload();
    hoisted.mockClient = client;

    await updateCashAccount(
      "aaaaaaaa-0000-0000-0000-000000000001",
      {},
    );

    // The function should return BEFORE any from() call — no before fetch,
    // no .update(), no after fetch, no display name resolution, nothing.
    expect(client.from).not.toHaveBeenCalled();
  });

  it("update with only `apy: undefined` (explicitly undefined) is also a no-op", async () => {
    // Sanity: passing an explicit `undefined` is equivalent to omitting the
    // key — partialUpdate strips it and the early-return fires.
    const { client } = captureUpdatePayload();
    hoisted.mockClient = client;

    await updateCashAccount(
      "aaaaaaaa-0000-0000-0000-000000000001",
      { apy: undefined },
    );

    expect(client.from).not.toHaveBeenCalled();
  });

  it("empty-object update preserves pre-existing badge state (does not flip Xfer→none)", async () => {
    // The whole point of the early-return: a row with last_was_transfer=true
    // (showing the teal Xfer badge) must NOT have its badge silently cleared
    // by an empty/no-op update call. Since the function early-returns before
    // any DB write, the existing row state is untouched by definition — this
    // test asserts the absence of the SQL UPDATE that would otherwise flip
    // the flag.
    const { client } = captureUpdatePayload();
    hoisted.mockClient = client;

    // The mock's "before" snapshot says last_was_transfer:false, but that
    // doesn't matter — what matters is the function never even fetches it.
    await updateCashAccount(
      "aaaaaaaa-0000-0000-0000-000000000001",
      {},
      { isAdjustment: true, transferGroupId: undefined },
    );

    // No update call → no badge flip. Even with opts that would normally
    // write last_was_adjustment:true, the early-return takes precedence.
    expect(client.from).not.toHaveBeenCalled();
  });
});
