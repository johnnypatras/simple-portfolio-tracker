import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestUser } from "./setup";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Import-related DB constraints: unique indexes on crypto_assets and stock_assets,
 * FK enforcement on crypto_positions.
 *
 * Requires local Supabase running (supabase start).
 */

describe("import constraints", () => {
  // ── 1. Duplicate crypto_asset (same coingecko_id + chain + user_id) ───

  describe("duplicate crypto_asset unique constraint", () => {
    let user: { client: SupabaseClient; userId: string; cleanup: () => void };

    beforeAll(async () => {
      user = await createTestUser("import-crypto-dup@test.local");

      const { error } = await user.client.from("crypto_assets").insert({
        user_id: user.userId,
        name: "Bitcoin",
        ticker: "BTC",
        coingecko_id: "bitcoin",
      });
      if (error) throw new Error("Failed to create first crypto asset: " + error.message);
    });

    afterAll(() => user.cleanup());

    it("rejects duplicate coingecko_id + chain for same user", async () => {
      // uq_crypto_assets_active: UNIQUE (user_id, coingecko_id, COALESCE(chain, '')) WHERE deleted_at IS NULL
      const { error } = await user.client.from("crypto_assets").insert({
        user_id: user.userId,
        name: "Bitcoin Duplicate",
        ticker: "BTC2",
        coingecko_id: "bitcoin",
      });

      expect(error).not.toBeNull();
      // 23505 = unique_violation
      expect(error!.code).toBe("23505");
      expect(error!.message).toContain("uq_crypto_assets_active");
    });
  });

  // ── 2. Duplicate stock_asset (same ticker + user_id) ──────────

  describe("duplicate stock_asset unique constraint", () => {
    let user: { client: SupabaseClient; userId: string; cleanup: () => void };

    beforeAll(async () => {
      user = await createTestUser("import-stock-dup@test.local");
    });

    afterAll(() => user.cleanup());

    it("rejects duplicate yahoo_ticker for same user", async () => {
      // uq_stock_assets_yahoo_active: UNIQUE (user_id, yahoo_ticker)
      // WHERE yahoo_ticker IS NOT NULL AND deleted_at IS NULL
      const { error: firstErr } = await user.client
        .from("stock_assets")
        .insert({
          user_id: user.userId,
          name: "Apple Inc",
          ticker: "AAPL",
          yahoo_ticker: "AAPL",
        });
      if (firstErr) throw new Error("Failed to create first stock: " + firstErr.message);

      const { error } = await user.client.from("stock_assets").insert({
        user_id: user.userId,
        name: "Apple Duplicate",
        ticker: "AAPL-2",
        yahoo_ticker: "AAPL",
      });

      expect(error).not.toBeNull();
      expect(error!.code).toBe("23505");
      expect(error!.message).toContain("uq_stock_assets_yahoo_active");
    });

    it("rejects duplicate ticker when yahoo_ticker is null", async () => {
      // uq_stock_assets_ticker_active: UNIQUE (user_id, ticker)
      // WHERE yahoo_ticker IS NULL AND deleted_at IS NULL
      const { error: firstErr } = await user.client
        .from("stock_assets")
        .insert({
          user_id: user.userId,
          name: "Custom Stock",
          ticker: "CUSTOM1",
          yahoo_ticker: null,
        });
      if (firstErr) throw new Error("Failed to create first null-yahoo stock: " + firstErr.message);

      const { error } = await user.client.from("stock_assets").insert({
        user_id: user.userId,
        name: "Custom Stock Dup",
        ticker: "CUSTOM1",
        yahoo_ticker: null,
      });

      expect(error).not.toBeNull();
      expect(error!.code).toBe("23505");
      expect(error!.message).toContain("uq_stock_assets_ticker_active");
    });
  });

  // ── 3. FK constraint: crypto_position → crypto_asset ──────────

  describe("FK constraint on crypto_position → crypto_asset", () => {
    let user: { client: SupabaseClient; userId: string; cleanup: () => void };
    let walletId: string;

    beforeAll(async () => {
      user = await createTestUser("import-fk-asset@test.local");

      // Create a wallet so the wallet FK is satisfied
      const { data: wallet } = await user.client
        .from("wallets")
        .insert({
          user_id: user.userId,
          name: "FK-Test-Wallet",
          wallet_type: "custodial",
        })
        .select("id")
        .single();
      if (!wallet) throw new Error("Failed to create wallet");
      walletId = wallet.id;
    });

    afterAll(() => user.cleanup());

    it("rejects position with non-existent asset_id", async () => {
      const fakeAssetId = "00000000-0000-0000-0000-000000000001";

      const { error } = await user.client.from("crypto_positions").insert({
        crypto_asset_id: fakeAssetId,
        wallet_id: walletId,
        quantity: 5,
      });

      expect(error).not.toBeNull();
      // RLS blocks before FK check when asset doesn't belong to user (42501)
      // or FK violation (23503) if RLS passes first — both are valid defenses
      expect(["42501", "23503"]).toContain(error!.code);
    });
  });

  // ── 4. FK constraint: crypto_position → wallet ────────────────

  describe("FK constraint on crypto_position → wallet", () => {
    let user: { client: SupabaseClient; userId: string; cleanup: () => void };
    let assetId: string;

    beforeAll(async () => {
      user = await createTestUser("import-fk-wallet@test.local");

      // Create a crypto asset so the asset FK is satisfied
      const { data: asset } = await user.client
        .from("crypto_assets")
        .insert({
          user_id: user.userId,
          name: "FK-Wallet-Coin",
          ticker: "FKWC",
          coingecko_id: "fk-wallet-coin",
        })
        .select("id")
        .single();
      if (!asset) throw new Error("Failed to create crypto asset");
      assetId = asset.id;
    });

    afterAll(() => user.cleanup());

    it("rejects position with non-existent wallet_id", async () => {
      const fakeWalletId = "00000000-0000-0000-0000-000000000002";

      const { error } = await user.client.from("crypto_positions").insert({
        crypto_asset_id: assetId,
        wallet_id: fakeWalletId,
        quantity: 3,
      });

      expect(error).not.toBeNull();
      // RLS blocks before FK check when wallet doesn't belong to user (42501)
      // or FK violation (23503) if RLS passes first — both are valid defenses
      expect(["42501", "23503"]).toContain(error!.code);
    });
  });

  // ── 5. Multi-chain crypto constraint ────────────────────────

  describe("multi-chain crypto_asset constraint", () => {
    let user: { client: SupabaseClient; userId: string; cleanup: () => void };

    beforeAll(async () => {
      user = await createTestUser();
    });

    afterAll(() => user.cleanup());

    it("allows same coingecko_id with different chains", async () => {
      const { error: e1 } = await user.client.from("crypto_assets").insert({
        user_id: user.userId,
        name: "Ethereum",
        ticker: "ETH",
        coingecko_id: "ethereum",
        chain: "Ethereum",
      });
      expect(e1).toBeNull();

      const { error: e2 } = await user.client.from("crypto_assets").insert({
        user_id: user.userId,
        name: "Ethereum",
        ticker: "ETH",
        coingecko_id: "ethereum",
        chain: "Linea",
      });
      expect(e2).toBeNull();
    });

    it("rejects same coingecko_id with same chain", async () => {
      const { error } = await user.client.from("crypto_assets").insert({
        user_id: user.userId,
        name: "Ethereum Dup",
        ticker: "ETH2",
        coingecko_id: "ethereum",
        chain: "Ethereum",
      });

      expect(error).not.toBeNull();
      expect(error!.code).toBe("23505");
    });

    it("rejects same coingecko_id with both null chains", async () => {
      const { error: e1 } = await user.client.from("crypto_assets").insert({
        user_id: user.userId,
        name: "Bitcoin",
        ticker: "BTC",
        coingecko_id: "bitcoin",
        chain: null,
      });
      expect(e1).toBeNull();

      const { error: e2 } = await user.client.from("crypto_assets").insert({
        user_id: user.userId,
        name: "Bitcoin Dup",
        ticker: "BTC2",
        coingecko_id: "bitcoin",
        chain: null,
      });

      expect(e2).not.toBeNull();
      expect(e2!.code).toBe("23505");
    });
  });
});
