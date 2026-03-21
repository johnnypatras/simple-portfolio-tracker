import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration tests for stock server actions.
 *
 * Strategy: mock `createServerSupabaseClient` to return the test user's
 * authenticated Supabase client, then call the actual server action functions.
 * This tests the full business logic (validation, DB operations, activity
 * logging, dedup) against a real local Supabase instance.
 *
 * Mocked modules:
 *   - @/lib/supabase/server → returns test user's client
 *   - @/lib/supabase/admin → stub (not called in these paths)
 *   - next/cache → stub revalidatePath
 *   - @/lib/prices/* → stubs to avoid real API calls
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

vi.mock("@/lib/prices/coingecko", () => ({
  getPrices: vi.fn(async () => ({})),
  getCoinImage: vi.fn(async () => null),
}));

vi.mock("@/lib/prices/yahoo", () => ({
  getStockPrices: vi.fn(async () => ({})),
}));

vi.mock("@/lib/prices/fx", () => ({
  getFXRates: vi.fn(async (_base: string, targets: string[]) => {
    const rates: Record<string, number> = {};
    for (const t of targets) {
      if (t === "USD") rates.USD = 1.11;
      else if (t === "EUR") rates.EUR = 0.90;
      else rates[t] = 1;
    }
    return rates;
  }),
  getFXRatesSafe: vi.fn(async () => ({ USD: 1.11, EUR: 1 })),
}));

// ─── Import server actions (resolved against mocks) ─────────
import {
  createStockAsset,
  upsertStockPosition,
  deleteStockAsset,
} from "@/lib/actions/stocks";

// ─── Tests ──────────────────────────────────────────────────
describe("stock server actions (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;
  let brokerId: string;

  // Second user for RLS isolation tests
  let userB: { client: SupabaseClient; userId: string; cleanup: () => void };

  beforeAll(async () => {
    const result = await createTestUser(`stocks-a-${Date.now()}@test.local`);
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;

    // Create a broker for position tests
    const { data: broker, error } = await client
      .from("brokers")
      .insert({ user_id: userId, name: "Test Broker" })
      .select("id")
      .single();
    if (error) throw new Error("Failed to create test broker: " + error.message);
    brokerId = broker!.id;

    // Create second user for RLS tests
    userB = await createTestUser(`stocks-b-${Date.now()}@test.local`);
  });

  afterAll(() => {
    cleanup();
    userB.cleanup();
  });

  // Shared state for sequential tests
  let assetId: string;
  const yahooTicker = "TST" + Math.floor(Date.now() / 1000) + ".DE";

  it("createStockAsset creates asset and logs activity", async () => {
    assetId = await createStockAsset({
      ticker: "AAPL",
      name: "Apple Inc.",
      yahoo_ticker: yahooTicker,
      currency: "USD",
    });

    expect(assetId).toBeDefined();
    expect(typeof assetId).toBe("string");

    // Verify asset in DB
    const { data: asset } = await client
      .from("stock_assets")
      .select("*")
      .eq("id", assetId)
      .single();

    expect(asset).not.toBeNull();
    expect(asset!.ticker).toBe("AAPL");
    expect(asset!.name).toBe("Apple Inc.");
    expect(asset!.yahoo_ticker).toBe(yahooTicker);
    expect(asset!.user_id).toBe(userId);
    expect(asset!.currency).toBe("USD");

    // Verify activity_log entry
    const { data: logs } = await client
      .from("activity_log")
      .select("*")
      .eq("entity_id", assetId)
      .eq("entity_table", "stock_assets")
      .eq("action", "created");

    expect(logs!.length).toBe(1);
    expect(logs![0].entity_type).toBe("stock_asset");
    expect(logs![0].entity_name).toContain("AAPL");
  });

  it("createStockAsset dedup returns existing ID for same yahoo_ticker", async () => {
    const duplicateId = await createStockAsset({
      ticker: "AAPL",
      name: "Apple Inc.",
      yahoo_ticker: yahooTicker,
      currency: "USD",
    });

    expect(duplicateId).toBe(assetId);
  });

  it("upsertStockPosition creates a new position", async () => {
    await upsertStockPosition({
      stock_asset_id: assetId,
      broker_id: brokerId,
      quantity: 10,
    });

    const { data: pos } = await client
      .from("stock_positions")
      .select("*")
      .eq("stock_asset_id", assetId)
      .eq("broker_id", brokerId)
      .is("deleted_at", null)
      .single();

    expect(pos).not.toBeNull();
    expect(Number(pos!.quantity)).toBe(10);

    // Activity log: "created" for the new position
    const { data: logs } = await client
      .from("activity_log")
      .select("*")
      .eq("entity_id", pos!.id)
      .eq("entity_type", "stock_position")
      .eq("action", "created");

    expect(logs!.length).toBe(1);
    expect(logs![0].entity_name).toBe("AAPL");
  });

  it("upsertStockPosition updates quantity of existing position", async () => {
    await upsertStockPosition({
      stock_asset_id: assetId,
      broker_id: brokerId,
      quantity: 25,
    });

    const { data: pos } = await client
      .from("stock_positions")
      .select("*")
      .eq("stock_asset_id", assetId)
      .eq("broker_id", brokerId)
      .is("deleted_at", null)
      .single();

    expect(Number(pos!.quantity)).toBe(25);

    // Activity log: "updated"
    const { data: logs } = await client
      .from("activity_log")
      .select("*")
      .eq("entity_id", pos!.id)
      .eq("entity_type", "stock_position")
      .eq("action", "updated");

    expect(logs!.length).toBeGreaterThanOrEqual(1);
  });

  it("User B cannot SELECT User A's stock_assets", async () => {
    const { data } = await userB.client
      .from("stock_assets")
      .select("*")
      .eq("id", assetId);
    expect(data ?? []).toEqual([]);
  });

  it("User B cannot SELECT User A's stock_positions", async () => {
    // stock_positions RLS goes through stock_assets.user_id
    const { data } = await userB.client
      .from("stock_positions")
      .select("*")
      .eq("stock_asset_id", assetId);
    expect(data ?? []).toEqual([]);
  });

  it("soft-delete stock asset sets deleted_at, position still exists", async () => {
    // Create a separate asset + position for this test so it doesn't
    // interfere with the shared state used by earlier tests
    const isolatedYahoo = "DEL" + Math.floor(Date.now() / 1000) + ".DE";
    const isolatedAssetId = await createStockAsset({
      ticker: "MSFT",
      name: "Microsoft",
      yahoo_ticker: isolatedYahoo,
      currency: "USD",
    });

    await upsertStockPosition({
      stock_asset_id: isolatedAssetId,
      broker_id: brokerId,
      quantity: 5,
    });

    // Get position ID before asset deletion
    const { data: posBefore } = await client
      .from("stock_positions")
      .select("id")
      .eq("stock_asset_id", isolatedAssetId)
      .is("deleted_at", null)
      .single();
    expect(posBefore).not.toBeNull();

    await deleteStockAsset(isolatedAssetId);

    // Asset should be soft-deleted
    const { data: deletedAsset } = await client
      .from("stock_assets")
      .select("deleted_at")
      .eq("id", isolatedAssetId)
      .single();
    expect(deletedAsset!.deleted_at).not.toBeNull();

    // Position should also be soft-deleted (by server action + cascade trigger)
    const { data: deletedPos } = await client
      .from("stock_positions")
      .select("deleted_at")
      .eq("id", posBefore!.id)
      .single();
    expect(deletedPos!.deleted_at).not.toBeNull();

    // Activity log: removal entries for both position and asset
    const { data: posLogs } = await client
      .from("activity_log")
      .select("*")
      .eq("entity_id", posBefore!.id)
      .eq("entity_type", "stock_position")
      .eq("action", "removed");
    expect(posLogs!.length).toBe(1);

    const { data: assetLogs } = await client
      .from("activity_log")
      .select("*")
      .eq("entity_id", isolatedAssetId)
      .eq("entity_type", "stock_asset")
      .eq("action", "removed");
    expect(assetLogs!.length).toBe(1);
  });

  it("activity log created after position insert", async () => {
    // Create a fresh asset + position to verify activity log in isolation
    const freshYahoo = "LOG" + Math.floor(Date.now() / 1000) + ".DE";
    const freshAssetId = await createStockAsset({
      ticker: "GOOG",
      name: "Alphabet",
      yahoo_ticker: freshYahoo,
      currency: "USD",
    });

    await upsertStockPosition({
      stock_asset_id: freshAssetId,
      broker_id: brokerId,
      quantity: 3,
    });

    // Fetch the position to get its ID
    const { data: pos } = await client
      .from("stock_positions")
      .select("id")
      .eq("stock_asset_id", freshAssetId)
      .eq("broker_id", brokerId)
      .is("deleted_at", null)
      .single();

    // Verify activity_log has a "created" entry for this position
    const { data: logs } = await client
      .from("activity_log")
      .select("*")
      .eq("entity_id", pos!.id)
      .eq("entity_table", "stock_positions")
      .eq("action", "created");

    expect(logs).not.toBeNull();
    expect(logs!.length).toBe(1);
    expect(logs![0].entity_type).toBe("stock_position");
    expect(logs![0].entity_name).toBe("GOOG");
    expect(logs![0].user_id).toBe(userId);
  });
});
