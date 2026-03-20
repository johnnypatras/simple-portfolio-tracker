import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for unauthenticated read guard behavior.
 *
 * Verifies that getCashAccounts(), getSnapshots(), and getBrokers() each return
 * an empty array — and never touch the DB — when auth.getUser() returns no user.
 * This guard was audited and confirmed consistent across all read functions.
 */

// ─── Hoisted mock state ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({ testClient: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.testClient),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// cash-accounts.ts imports activity-log, cashflow, validation — stub side-effects
vi.mock("@/lib/actions/activity-log", () => ({
  logActivity: vi.fn(),
  toUsdAndEur: vi.fn().mockResolvedValue({ usd: 0, eur: 0 }),
}));

vi.mock("@/lib/cashflow", () => ({
  computeCashflowFromPrices: vi.fn().mockReturnValue({ usd: 0, eur: 0 }),
  classifyAssetClass: vi.fn().mockReturnValue("cash"),
}));

vi.mock("@/lib/validation", () => ({
  validateAmount: vi.fn(),
  validateCurrency: vi.fn(),
  validateName: vi.fn(),
  validateUUID: vi.fn(),
}));

// brokers.ts imports institutions and activity-log
vi.mock("@/lib/actions/institutions", () => ({
  findOrCreateInstitution: vi.fn().mockResolvedValue("inst-id"),
  renameInstitution: vi.fn(),
}));

// Sentry is referenced by snapshots.ts
vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
}));

// ─── Import after mocks ──────────────────────────────────────────────────────
import { getCashAccounts } from "@/lib/actions/cash-accounts";
import { getSnapshots } from "@/lib/actions/snapshots";
import { getBrokers } from "@/lib/actions/brokers";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Client that simulates an unauthenticated session (user is null). */
function makeUnauthClient() {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: null },
        error: null,
      }),
    },
    from: vi.fn(), // must NOT be called
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("auth guard — read functions return [] when unauthenticated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.testClient = makeUnauthClient();
  });

  describe("getCashAccounts()", () => {
    it("returns an empty array", async () => {
      const result = await getCashAccounts();
      expect(result).toEqual([]);
    });

    it("never queries the DB", async () => {
      const client = makeUnauthClient();
      hoisted.testClient = client;
      await getCashAccounts();
      expect(client.from).not.toHaveBeenCalled();
    });
  });

  describe("getSnapshots()", () => {
    it("returns an empty array for any day count", async () => {
      const result = await getSnapshots(30);
      expect(result).toEqual([]);
    });

    it("returns an empty array with day count of 1", async () => {
      const result = await getSnapshots(1);
      expect(result).toEqual([]);
    });

    it("never queries the DB", async () => {
      const client = makeUnauthClient();
      hoisted.testClient = client;
      await getSnapshots(30);
      expect(client.from).not.toHaveBeenCalled();
    });
  });

  describe("getBrokers()", () => {
    it("returns an empty array", async () => {
      const result = await getBrokers();
      expect(result).toEqual([]);
    });

    it("never queries the DB", async () => {
      const client = makeUnauthClient();
      hoisted.testClient = client;
      await getBrokers();
      expect(client.from).not.toHaveBeenCalled();
    });
  });
});
