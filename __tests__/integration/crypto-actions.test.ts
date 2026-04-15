import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration tests for crypto server actions.
 *
 * Strategy: mock `createServerSupabaseClient` to return the test user's
 * authenticated Supabase client, then call the actual server action functions.
 * This tests the full business logic (validation, DB operations, activity
 * logging, dedup, cascade deletes) against a real local Supabase instance.
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
  createCryptoAsset,
  upsertPosition,
  deleteCryptoAsset,
} from "@/lib/actions/crypto";

// ─── Tests ──────────────────────────────────────────────────
describe("crypto server actions (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;
  let walletId: string;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;

    // Create a wallet for position tests
    const { data: wallet, error } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Test Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (error) throw new Error("Failed to create test wallet: " + error.message);
    walletId = wallet!.id;
  });

  afterAll(() => cleanup());

  // Shared state for sequential tests
  let btcAssetId: string;
  const btcCoingeckoId = "bitcoin-test-" + Date.now();

  it("createCryptoAsset creates asset and logs activity", async () => {
    btcAssetId = await createCryptoAsset({
      ticker: "BTC",
      name: "Bitcoin",
      coingecko_id: btcCoingeckoId,
    });

    expect(btcAssetId).toBeDefined();
    expect(typeof btcAssetId).toBe("string");

    // Verify asset in DB
    const { data: asset } = await client
      .from("crypto_assets")
      .select("*")
      .eq("id", btcAssetId)
      .single();

    expect(asset).not.toBeNull();
    expect(asset!.ticker).toBe("BTC");
    expect(asset!.name).toBe("Bitcoin");
    expect(asset!.coingecko_id).toBe(btcCoingeckoId);
    expect(asset!.user_id).toBe(userId);

    // Verify activity_log entry
    const { data: logs } = await client
      .from("activity_log")
      .select("*")
      .eq("entity_id", btcAssetId)
      .eq("entity_table", "crypto_assets")
      .eq("action", "created");

    expect(logs!.length).toBe(1);
    expect(logs![0].entity_type).toBe("crypto_asset");
    expect(logs![0].entity_name).toContain("BTC");
  });

  it("createCryptoAsset dedup returns existing ID for same coingecko_id", async () => {
    const duplicateId = await createCryptoAsset({
      ticker: "BTC",
      name: "Bitcoin",
      coingecko_id: btcCoingeckoId,
    });

    expect(duplicateId).toBe(btcAssetId);
  });

  it("upsertPosition creates a new position", async () => {
    await upsertPosition({
      crypto_asset_id: btcAssetId,
      wallet_id: walletId,
      quantity: 5,
    });

    const { data: pos } = await client
      .from("crypto_positions")
      .select("*")
      .eq("crypto_asset_id", btcAssetId)
      .eq("wallet_id", walletId)
      .is("deleted_at", null)
      .single();

    expect(pos).not.toBeNull();
    expect(Number(pos!.quantity)).toBe(5);

    // Activity log: "created" for the new position
    const { data: logs } = await client
      .from("activity_log")
      .select("*")
      .eq("entity_id", pos!.id)
      .eq("entity_type", "crypto_position")
      .eq("action", "created");

    expect(logs!.length).toBe(1);
    expect(logs![0].entity_name).toBe("BTC");
  });

  it("upsertPosition updates quantity of existing position", async () => {
    await upsertPosition({
      crypto_asset_id: btcAssetId,
      wallet_id: walletId,
      quantity: 10,
    });

    const { data: pos } = await client
      .from("crypto_positions")
      .select("*")
      .eq("crypto_asset_id", btcAssetId)
      .eq("wallet_id", walletId)
      .is("deleted_at", null)
      .single();

    expect(Number(pos!.quantity)).toBe(10);

    // Activity log: "updated"
    const { data: logs } = await client
      .from("activity_log")
      .select("*")
      .eq("entity_id", pos!.id)
      .eq("entity_type", "crypto_position")
      .eq("action", "updated");

    expect(logs!.length).toBeGreaterThanOrEqual(1);
  });

  it("upsertPosition with quantity 0 soft-deletes the position", async () => {
    // Get position ID before deletion
    const { data: before } = await client
      .from("crypto_positions")
      .select("id")
      .eq("crypto_asset_id", btcAssetId)
      .eq("wallet_id", walletId)
      .is("deleted_at", null)
      .single();
    expect(before).not.toBeNull();
    const posId = before!.id;

    await upsertPosition({
      crypto_asset_id: btcAssetId,
      wallet_id: walletId,
      quantity: 0,
    });

    // Position should be soft-deleted
    const { data: after } = await client
      .from("crypto_positions")
      .select("deleted_at")
      .eq("id", posId)
      .single();
    expect(after!.deleted_at).not.toBeNull();

    // Activity log: "removed"
    const { data: logs } = await client
      .from("activity_log")
      .select("*")
      .eq("entity_id", posId)
      .eq("entity_type", "crypto_position")
      .eq("action", "removed");

    expect(logs!.length).toBe(1);
  });

  it("deleteCryptoAsset cascades to positions and logs both", async () => {
    // Create a fresh asset + position for this test
    const solCoingeckoId = "solana-delete-test-" + Date.now();
    const assetId = await createCryptoAsset({
      ticker: "SOL",
      name: "Solana",
      coingecko_id: solCoingeckoId,
    });

    await upsertPosition({
      crypto_asset_id: assetId,
      wallet_id: walletId,
      quantity: 100,
    });

    // Get position ID
    const { data: pos } = await client
      .from("crypto_positions")
      .select("id")
      .eq("crypto_asset_id", assetId)
      .eq("wallet_id", walletId)
      .is("deleted_at", null)
      .single();

    await deleteCryptoAsset(assetId);

    // Asset should be soft-deleted
    const { data: deletedAsset } = await client
      .from("crypto_assets")
      .select("deleted_at")
      .eq("id", assetId)
      .single();
    expect(deletedAsset!.deleted_at).not.toBeNull();

    // Position should be soft-deleted (explicitly by server action, before DB trigger)
    const { data: deletedPos } = await client
      .from("crypto_positions")
      .select("deleted_at")
      .eq("id", pos!.id)
      .single();
    expect(deletedPos!.deleted_at).not.toBeNull();

    // Activity log: removal entries for both position and asset
    const { data: posLogs } = await client
      .from("activity_log")
      .select("*")
      .eq("entity_id", pos!.id)
      .eq("entity_type", "crypto_position")
      .eq("action", "removed");
    expect(posLogs!.length).toBe(1);

    const { data: assetLogs } = await client
      .from("activity_log")
      .select("*")
      .eq("entity_id", assetId)
      .eq("entity_type", "crypto_asset")
      .eq("action", "removed");
    expect(assetLogs!.length).toBe(1);
  });

  // ── Multi-chain tests ──────────────────────────────────────

  describe("multi-chain support", () => {
    const ethCoingeckoId = "ethereum-multichain-" + Date.now();
    let ethMainnetId: string;
    let ethLineaId: string;

    beforeAll(async () => {
      ethMainnetId = await createCryptoAsset({
        ticker: "ETH",
        name: "Ethereum",
        coingecko_id: ethCoingeckoId,
        chain: "Ethereum",
      });

      ethLineaId = await createCryptoAsset({
        ticker: "ETH",
        name: "Ethereum",
        coingecko_id: ethCoingeckoId,
        chain: "Linea",
      });
    });

    it("creates same coingecko_id with different chains as separate assets", () => {
      expect(typeof ethMainnetId).toBe("string");
      expect(ethMainnetId).not.toBe("");
      expect(typeof ethLineaId).toBe("string");
      expect(ethLineaId).not.toBe("");
      expect(ethMainnetId).not.toBe(ethLineaId);
    });

    it("dedup returns existing ID for same coingecko_id + same chain", async () => {
      const dupeId = await createCryptoAsset({
        ticker: "ETH",
        name: "Ethereum",
        coingecko_id: ethCoingeckoId,
        chain: "Ethereum",
      });

      expect(dupeId).toBe(ethMainnetId);
    });

    it("positions on different chain assets are independent", async () => {
      await upsertPosition({
        crypto_asset_id: ethMainnetId,
        wallet_id: walletId,
        quantity: 10,
      });

      await upsertPosition({
        crypto_asset_id: ethLineaId,
        wallet_id: walletId,
        quantity: 3,
      });

      const { data: mainnetPos } = await client
        .from("crypto_positions")
        .select("quantity")
        .eq("crypto_asset_id", ethMainnetId)
        .eq("wallet_id", walletId)
        .is("deleted_at", null)
        .single();

      const { data: lineaPos } = await client
        .from("crypto_positions")
        .select("quantity")
        .eq("crypto_asset_id", ethLineaId)
        .eq("wallet_id", walletId)
        .is("deleted_at", null)
        .single();

      expect(Number(mainnetPos!.quantity)).toBe(10);
      expect(Number(lineaPos!.quantity)).toBe(3);
    });

    it("writes and reads the position-level `network` field (migration 013)", async () => {
      // Position-level network is distinct from asset-level chain — regression
      // guard for the `normalizedNetwork` normalization in upsertPosition.
      await upsertPosition({
        crypto_asset_id: ethLineaId,
        wallet_id: walletId,
        quantity: 5,
        network: "Linea",
      });

      const { data: pos } = await client
        .from("crypto_positions")
        .select("network")
        .eq("crypto_asset_id", ethLineaId)
        .eq("wallet_id", walletId)
        .is("deleted_at", null)
        .single();

      expect(pos?.network).toBe("Linea");
    });

    it("trims leading/trailing whitespace on network (regression guard)", async () => {
      await upsertPosition({
        crypto_asset_id: ethMainnetId,
        wallet_id: walletId,
        quantity: 11,
        network: "  Arbitrum  ",
      });

      const { data: pos } = await client
        .from("crypto_positions")
        .select("network")
        .eq("crypto_asset_id", ethMainnetId)
        .eq("wallet_id", walletId)
        .is("deleted_at", null)
        .single();

      expect(pos?.network).toBe("Arbitrum");
    });

    it("deleting one chain asset does not affect the other", async () => {
      await deleteCryptoAsset(ethLineaId);

      // Linea asset should be soft-deleted
      const { data: deleted } = await client
        .from("crypto_assets")
        .select("deleted_at")
        .eq("id", ethLineaId)
        .single();
      expect(deleted!.deleted_at).not.toBeNull();

      // Mainnet asset should still be active
      const { data: active } = await client
        .from("crypto_assets")
        .select("deleted_at")
        .eq("id", ethMainnetId)
        .single();
      expect(active!.deleted_at).toBeNull();
    });
  });
});
