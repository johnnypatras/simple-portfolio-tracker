import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration tests for migrate-legacy-adjustments.ts server action.
 *
 * Strategy: mock `createServerSupabaseClient` to return the test user's
 * authenticated Supabase client, then call the real migration action.
 * Price APIs (CoinGecko historical / Yahoo history / FX) are stubbed so
 * `computeDeltaFromSnapshots` can run without real network calls; this
 * keeps the test deterministic and isolated.
 *
 * Coverage targets:
 *   - 3 legacy bulk-flagged real imports → all migrated
 *   - 1 transfer destination leg → UNCHANGED (the regression we're guarding)
 *   - 1 already-non-adjustment entry → UNCHANGED (not a candidate)
 *   - reversal via toggleActivityAdjustment(id, true) restores adjustment state
 */

// ─── Hoisted mock state ─────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  testClient: null as SupabaseClient | null,
}));

// ─── Module mocks (hoisted before imports) ──────────────────
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.testClient),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

// CoinGecko historical: return a constant USD price for the date being looked up.
vi.mock("@/lib/prices/coingecko", () => ({
  fetchCoinHistory: vi.fn(async () => {
    // Cover the entire backdate window with a single price level so the
    // walk-on-or-before in computeDeltaFromSnapshots always lands on 30000.
    return [
      { date: "2020-01-01", price: 30000 },
      { date: "2026-01-01", price: 30000 },
    ];
  }),
}));

// Yahoo historical: return a constant USD price for stock backdates.
vi.mock("@/lib/prices/yahoo", () => ({
  fetchIndexHistory: vi.fn(async () => {
    return [
      { date: "2020-01-01", close: 150 },
      { date: "2026-01-01", close: 150 },
    ];
  }),
}));

// FX: EUR base 1 USD = 1.08 EUR; USD base 1 EUR = 0.93 USD.
vi.mock("@/lib/prices/fx", () => ({
  getFXRates: vi.fn(async (base: string, targets: string[]) => {
    const rates: Record<string, number> = {};
    for (const t of targets) {
      if (base === "USD" && t === "EUR") rates.EUR = 0.93;
      else if (base === "EUR" && t === "USD") rates.USD = 1.08;
      else if (base === t) rates[t] = 1;
      else rates[t] = 1;
    }
    return rates;
  }),
  getFXRatesSafe: vi.fn(async () => ({ USD: 1.08, EUR: 0.93 })),
}));

// ─── Import server actions (resolved against mocks) ─────────
import {
  migrateLegacyAdjustmentFlags,
  previewLegacyAdjustmentMigration,
} from "@/lib/actions/migrate-legacy-adjustments";
import { toggleActivityAdjustment } from "@/lib/actions/activity-log";

// ─── Tests ──────────────────────────────────────────────────
describe("migrate-legacy-adjustments (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  // Seed IDs we look up after the migration
  let legacyCryptoId: string;
  let legacyStockId: string;
  let legacyCashId: string;
  let transferLegId: string;
  let alreadyCorrectId: string;

  // Underlying assets
  let cryptoAssetId: string;
  let stockAssetId: string;

  beforeAll(async () => {
    const result = await createTestUser(`migrate-legacy-${Date.now()}@test.local`);
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;

    // ─── Underlying assets needed for delta computation ───────────────
    const { data: cryptoAsset } = await client
      .from("crypto_assets")
      .insert({
        user_id: userId,
        name: "Bitcoin",
        ticker: "BTC",
        coingecko_id: `bitcoin-migrate-${Date.now()}`,
        subcategory: null,
      })
      .select("id")
      .single();
    cryptoAssetId = cryptoAsset!.id;

    const { data: stockAsset } = await client
      .from("stock_assets")
      .insert({
        user_id: userId,
        ticker: "AAPL",
        name: "Apple",
        yahoo_ticker: `AAPL-MIG-${Date.now()}`,
        currency: "USD",
      })
      .select("id")
      .single();
    stockAssetId = stockAsset!.id;

    // ─── Seed: 3 legacy bulk-flagged real imports ─────────────────────
    // 1. Crypto position — backdated, is_adjustment=true, transfer_group_id NULL
    const { data: cryptoRow } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_name: "BTC",
        description: "Imported crypto position",
        is_adjustment: true,
        delta_usd: 30000,
        delta_eur: 27900,
        delta_status: "complete",
        transfer_group_id: null,
        undone_at: null,
        before_snapshot: null,
        after_snapshot: {
          crypto_asset_id: cryptoAssetId,
          quantity: 1.0,
        },
        effective_date: "2024-06-15",
      })
      .select("id")
      .single();
    legacyCryptoId = cryptoRow!.id;

    // 2. Stock position — same shape
    const { data: stockRow } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "stock_position",
        entity_name: "AAPL",
        description: "Imported stock position",
        is_adjustment: true,
        delta_usd: 1500,
        delta_eur: 1395,
        delta_status: "complete",
        transfer_group_id: null,
        undone_at: null,
        before_snapshot: null,
        after_snapshot: {
          stock_asset_id: stockAssetId,
          quantity: 10,
        },
        effective_date: "2024-06-15",
      })
      .select("id")
      .single();
    legacyStockId = stockRow!.id;

    // 3. Cash account — same shape
    const { data: cashRow } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "cash_account",
        entity_name: "EUR cash",
        description: "Imported cash account",
        is_adjustment: true,
        delta_usd: 5400,
        delta_eur: 5000,
        delta_status: "complete",
        transfer_group_id: null,
        undone_at: null,
        before_snapshot: null,
        after_snapshot: {
          balance: 5000,
          currency: "EUR",
        },
        effective_date: "2024-06-15",
      })
      .select("id")
      .single();
    legacyCashId = cashRow!.id;

    // ─── Seed: 1 transfer destination leg — MUST be excluded ───────────
    const transferGroupId = crypto.randomUUID();
    const { data: transferRow } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_name: "BTC (transfer destination)",
        description: "Transfer destination leg",
        is_adjustment: true,
        delta_usd: 30000,
        delta_eur: 27900,
        delta_status: "complete",
        transfer_group_id: transferGroupId,
        undone_at: null,
        before_snapshot: null,
        after_snapshot: {
          crypto_asset_id: cryptoAssetId,
          quantity: 1.0,
        },
        effective_date: "2024-08-15",
      })
      .select("id")
      .single();
    transferLegId = transferRow!.id;

    // ─── Seed: 1 already-correct non-adjustment entry — MUST be ignored
    const { data: correctRow } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_name: "BTC (already correct)",
        description: "Already not an adjustment",
        is_adjustment: false,
        delta_usd: null,
        delta_eur: null,
        cashflow_amount_usd: 30000,
        cashflow_amount_eur: 27900,
        cashflow_asset_class: "crypto",
        cashflow_status: "complete",
        transfer_group_id: null,
        undone_at: null,
        before_snapshot: null,
        after_snapshot: {
          crypto_asset_id: cryptoAssetId,
          quantity: 1.0,
        },
        effective_date: "2024-09-15",
      })
      .select("id")
      .single();
    alreadyCorrectId = correctRow!.id;
  });

  afterAll(() => cleanup());

  it("previewLegacyAdjustmentMigration counts only the 3 real imports (excludes transfer + already-correct)", async () => {
    const preview = await previewLegacyAdjustmentMigration();
    expect(preview.count).toBe(3);
    expect(preview.by_entity_type).toEqual({
      crypto_position: 1,
      stock_position: 1,
      cash_account: 1,
    });
  });

  describe("migrateLegacyAdjustmentFlags", () => {
    let result: Awaited<ReturnType<typeof migrateLegacyAdjustmentFlags>>;

    beforeAll(async () => {
      result = await migrateLegacyAdjustmentFlags();
    });

    it("returns total_candidates=3, migrated=3, errors=0, remaining=0, details empty", () => {
      expect(result.total_candidates).toBe(3);
      expect(result.migrated).toBe(3);
      expect(result.errors).toBe(0);
      // All attempted, none errored → no un-attempted rows.
      expect(result.remaining).toBe(0);
      // Successful migrations are counted, not enumerated.
      expect(result.details).toHaveLength(0);
    });

    it("migrated crypto_position: is_adjustment=false, cashflow populated, delta cleared", async () => {
      const { data, error } = await client
        .from("activity_log")
        .select(
          "is_adjustment, cashflow_amount_usd, cashflow_amount_eur, cashflow_asset_class, cashflow_status, delta_usd, delta_eur, delta_status",
        )
        .eq("id", legacyCryptoId)
        .single();
      expect(error).toBeNull();
      expect(data!.is_adjustment).toBe(false);
      expect(Number(data!.cashflow_amount_usd)).toBeGreaterThan(0);
      expect(Number(data!.cashflow_amount_eur)).toBeGreaterThan(0);
      expect(data!.cashflow_asset_class).toBe("crypto");
      expect(data!.cashflow_status).toBe("complete");
      expect(data!.delta_usd).toBeNull();
      expect(data!.delta_eur).toBeNull();
      expect(data!.delta_status).toBeNull();
    });

    it("migrated stock_position: is_adjustment=false, cashflow populated, delta cleared", async () => {
      const { data, error } = await client
        .from("activity_log")
        .select(
          "is_adjustment, cashflow_amount_usd, cashflow_asset_class, cashflow_status, delta_usd",
        )
        .eq("id", legacyStockId)
        .single();
      expect(error).toBeNull();
      expect(data!.is_adjustment).toBe(false);
      expect(Number(data!.cashflow_amount_usd)).toBeGreaterThan(0);
      expect(data!.cashflow_asset_class).toBe("stocks");
      expect(data!.cashflow_status).toBe("complete");
      expect(data!.delta_usd).toBeNull();
    });

    it("migrated cash_account: is_adjustment=false, cashflow populated (asset_class=cash), delta cleared", async () => {
      const { data, error } = await client
        .from("activity_log")
        .select(
          "is_adjustment, cashflow_amount_usd, cashflow_amount_eur, cashflow_asset_class, cashflow_status, delta_usd",
        )
        .eq("id", legacyCashId)
        .single();
      expect(error).toBeNull();
      expect(data!.is_adjustment).toBe(false);
      // 5000 EUR balance → 5400 USD via 1 EUR = 1.08 USD
      expect(Number(data!.cashflow_amount_usd)).toBeCloseTo(5400, 1);
      expect(Number(data!.cashflow_amount_eur)).toBeCloseTo(5000, 1);
      expect(data!.cashflow_asset_class).toBe("cash");
      expect(data!.cashflow_status).toBe("complete");
      expect(data!.delta_usd).toBeNull();
    });

    it("transfer destination leg is UNCHANGED (still is_adjustment=true, transfer_group_id still set)", async () => {
      const { data, error } = await client
        .from("activity_log")
        .select("is_adjustment, transfer_group_id, delta_usd, cashflow_status")
        .eq("id", transferLegId)
        .single();
      expect(error).toBeNull();
      expect(data!.is_adjustment).toBe(true);
      expect(data!.transfer_group_id).not.toBeNull();
      // delta_usd still populated, cashflow still null/uninitialised
      expect(Number(data!.delta_usd)).toBe(30000);
      expect(data!.cashflow_status).toBeNull();
    });

    it("already-correct entry is UNCHANGED", async () => {
      const { data, error } = await client
        .from("activity_log")
        .select(
          "is_adjustment, cashflow_amount_usd, cashflow_amount_eur, cashflow_asset_class, cashflow_status",
        )
        .eq("id", alreadyCorrectId)
        .single();
      expect(error).toBeNull();
      expect(data!.is_adjustment).toBe(false);
      expect(Number(data!.cashflow_amount_usd)).toBe(30000);
      expect(Number(data!.cashflow_amount_eur)).toBe(27900);
      expect(data!.cashflow_asset_class).toBe("crypto");
      expect(data!.cashflow_status).toBe("complete");
    });

    it("reversal: toggleActivityAdjustment(id, true) restores adjustment state on a migrated row", async () => {
      // Use the migrated crypto position — flip back ON.
      await toggleActivityAdjustment(legacyCryptoId, true);

      const { data, error } = await client
        .from("activity_log")
        .select(
          "is_adjustment, cashflow_amount_usd, cashflow_amount_eur, cashflow_asset_class, cashflow_status, delta_usd, delta_eur, delta_status",
        )
        .eq("id", legacyCryptoId)
        .single();
      expect(error).toBeNull();
      expect(data!.is_adjustment).toBe(true);
      expect(data!.cashflow_amount_usd).toBeNull();
      expect(data!.cashflow_amount_eur).toBeNull();
      expect(data!.cashflow_asset_class).toBeNull();
      expect(data!.cashflow_status).toBeNull();
      // delta_* re-computed from historical price (30000 USD per BTC × 1.0 qty)
      expect(Number(data!.delta_usd)).toBeGreaterThan(0);
      expect(Number(data!.delta_eur)).toBeGreaterThan(0);
      expect(data!.delta_status).toBe("complete");

      // Re-running migration now finds 1 candidate again (the flipped row).
      const recheck = await previewLegacyAdjustmentMigration();
      expect(recheck.count).toBe(1);
    });
  });
});

describe("migrate-legacy-adjustments — empty case (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  beforeAll(async () => {
    const result = await createTestUser(`migrate-empty-${Date.now()}@test.local`);
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;
  });

  afterAll(() => cleanup());

  beforeEach(() => {
    // Re-pin the mocked client between describe blocks (vitest runs them
    // sequentially but the hoisted mock state is module-scoped).
    hoisted.testClient = client;
  });

  it("returns 0/0/0 when the user has no candidates", async () => {
    const result = await migrateLegacyAdjustmentFlags();
    expect(result.total_candidates).toBe(0);
    expect(result.migrated).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.details).toHaveLength(0);

    const preview = await previewLegacyAdjustmentMigration();
    expect(preview.count).toBe(0);
    expect(preview.by_entity_type).toEqual({});

    // sanity — userId came back from the SetUp client
    expect(userId).toBeDefined();
  });
});
