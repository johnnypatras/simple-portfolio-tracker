import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestUser } from "./setup";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Integration tests for migrations 007-009 security constraints.
 * Requires local Supabase running (supabase start).
 */
describe("migration constraints (integration)", () => {
  let user: {
    client: SupabaseClient;
    userId: string;
    cleanup: () => void;
  };
  let cryptoAssetId: string;
  let stockAssetId: string;
  let cashAccountId: string;
  let walletId: string;
  let brokerId: string;

  beforeAll(async () => {
    user = await createTestUser("constraints-test@test.local");

    // Create parent entities first (wallet + broker needed for positions)
    const { data: wallet } = await user.client
      .from("wallets")
      .insert({ user_id: user.userId, name: "TestWallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (!wallet) throw new Error("Failed to create wallet");
    walletId = wallet.id;

    const { data: broker } = await user.client
      .from("brokers")
      .insert({ user_id: user.userId, name: "TestBroker" })
      .select("id")
      .single();
    if (!broker) throw new Error("Failed to create broker");
    brokerId = broker.id;

    // Create test entities
    const { data: cryptoAsset, error: cryptoErr } = await user.client
      .from("crypto_assets")
      .insert({ user_id: user.userId, name: "TestCoin", ticker: "TC", coingecko_id: "testcoin-constraints" })
      .select("id")
      .single();
    if (cryptoErr) throw new Error(`Failed to create crypto asset: ${cryptoErr.message}`);
    if (!cryptoAsset) throw new Error("Crypto asset insert returned null");
    cryptoAssetId = cryptoAsset.id;

    const { data: stockAsset } = await user.client
      .from("stock_assets")
      .insert({ user_id: user.userId, name: "TestStock", ticker: "TS", currency: "USD" })
      .select("id")
      .single();
    if (!stockAsset) throw new Error("Failed to create stock asset");
    stockAssetId = stockAsset.id;

    const { data: cashAccount, error: cashErr } = await user.client
      .from("cash_accounts")
      .insert({ user_id: user.userId, currency: "USD", balance: 100, name: "Test Account" })
      .select("id")
      .single();
    if (cashErr) throw new Error(`Failed to create cash account: ${cashErr.message}`);
    if (!cashAccount) throw new Error("Cash account insert returned null");
    cashAccountId = cashAccount.id;
  });

  afterAll(() => user?.cleanup());

  // ── Migration 007: CHECK constraints ──────────────────

  it("rejects negative cash_accounts balance", async () => {
    const { error } = await user.client
      .from("cash_accounts")
      .update({ balance: -1 })
      .eq("id", cashAccountId);

    expect(error).not.toBeNull();
    expect(error!.message).toContain("chk_cash_balance_non_negative");
  });

  it("rejects negative crypto_positions quantity", async () => {
    const { error } = await user.client
      .from("crypto_positions")
      .insert({ crypto_asset_id: cryptoAssetId, wallet_id: walletId, quantity: -5 });

    expect(error).not.toBeNull();
    expect(error!.message).toContain("chk_crypto_qty_non_negative");
  });

  it("rejects negative stock_positions quantity", async () => {
    const { error } = await user.client
      .from("stock_positions")
      .insert({ stock_asset_id: stockAssetId, broker_id: brokerId, quantity: -1 });

    expect(error).not.toBeNull();
    expect(error!.message).toContain("chk_stock_qty_non_negative");
  });

  it("allows zero balance/quantity (boundary)", async () => {
    const { error } = await user.client
      .from("cash_accounts")
      .update({ balance: 0 })
      .eq("id", cashAccountId);

    expect(error).toBeNull();
  });

  // ── Migration 008: profiles column-level REVOKE ───────

  it("blocks authenticated user from updating own role", async () => {
    const { error } = await user.client
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", user.userId);

    expect(error).not.toBeNull();
    // Column-level REVOKE produces a permission denied error
    expect(error!.message).toMatch(/permission denied|column "role"/i);
  });

  it("blocks authenticated user from updating own status", async () => {
    const { error } = await user.client
      .from("profiles")
      .update({ status: "active" })
      .eq("id", user.userId);

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/permission denied|column "status"/i);
  });

  // ── Migration 009: diary unique constraint ────────────

  it("rejects duplicate diary entries for same user+date", async () => {
    const date = "2020-01-01";

    // Insert first entry
    const { error: firstErr } = await user.client
      .from("diary_entries")
      .insert({ user_id: user.userId, entry_date: date, content: "First" });
    expect(firstErr).toBeNull();

    // Insert duplicate — should fail
    const { error: dupeErr } = await user.client
      .from("diary_entries")
      .insert({ user_id: user.userId, entry_date: date, content: "Duplicate" });

    expect(dupeErr).not.toBeNull();
    expect(dupeErr!.message).toContain("uq_diary_entries_user_date_active");
  });
});
