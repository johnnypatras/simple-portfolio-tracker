import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestUser } from "./setup";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Tests the cascade soft-delete trigger from migration 024.
 *
 * When a parent entity's `deleted_at` is set, the DB trigger automatically
 * cascades to all child entities. This tests every cascade path:
 *
 *   institutions → wallets, brokers, cash_accounts
 *   wallets → crypto_positions, cash_accounts (wallet_id)
 *   brokers → stock_positions, cash_accounts (broker_id)
 *   crypto_assets → crypto_positions
 *   stock_assets → stock_positions
 *   Two-level: institution → wallet → crypto_position
 *   Two-level: institution → broker → stock_position + broker_deposit
 */
describe("cascade soft-delete triggers", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
  });

  afterAll(() => cleanup());

  async function softDelete(table: string, id: string) {
    const { error } = await client
      .from(table)
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(`softDelete ${table}/${id}: ${error.message}`);
  }

  async function isDeleted(table: string, id: string): Promise<boolean> {
    const { data } = await client
      .from(table)
      .select("deleted_at")
      .eq("id", id)
      .single();
    return data?.deleted_at != null;
  }

  it("institution → wallets", async () => {
    const { data: inst } = await client
      .from("institutions")
      .insert({ user_id: userId, name: "Cascade-Inst-1" })
      .select("id")
      .single();
    const { data: wallet } = await client
      .from("wallets")
      .insert({
        user_id: userId,
        name: "Cascade-Wallet-1",
        wallet_type: "custodial",
        institution_id: inst!.id,
      })
      .select("id")
      .single();

    await softDelete("institutions", inst!.id);
    expect(await isDeleted("wallets", wallet!.id)).toBe(true);
  });

  it("institution → brokers", async () => {
    const { data: inst } = await client
      .from("institutions")
      .insert({ user_id: userId, name: "Cascade-Inst-2" })
      .select("id")
      .single();
    const { data: broker } = await client
      .from("brokers")
      .insert({
        user_id: userId,
        name: "Cascade-Broker-1",
        institution_id: inst!.id,
      })
      .select("id")
      .single();

    await softDelete("institutions", inst!.id);
    expect(await isDeleted("brokers", broker!.id)).toBe(true);
  });

  it("institution → cash_accounts", async () => {
    const { data: inst } = await client
      .from("institutions")
      .insert({ user_id: userId, name: "Cascade-Inst-3" })
      .select("id")
      .single();
    const { data: cash } = await client
      .from("cash_accounts")
      .insert({
        user_id: userId,
        name: "Cascade-Bank",
        currency: "EUR",
        balance: 1000,
        institution_id: inst!.id,
      })
      .select("id")
      .single();

    await softDelete("institutions", inst!.id);
    expect(await isDeleted("cash_accounts", cash!.id)).toBe(true);
  });

  it("institution → wallet → crypto_position (two-level)", async () => {
    const { data: inst } = await client
      .from("institutions")
      .insert({ user_id: userId, name: "Cascade-Inst-4" })
      .select("id")
      .single();
    const { data: wallet } = await client
      .from("wallets")
      .insert({
        user_id: userId,
        name: "Cascade-Wallet-2",
        wallet_type: "custodial",
        institution_id: inst!.id,
      })
      .select("id")
      .single();
    const { data: asset } = await client
      .from("crypto_assets")
      .insert({
        user_id: userId,
        ticker: "CTEST1",
        name: "Cascade Coin 1",
        coingecko_id: "cascade-coin-1",
      })
      .select("id")
      .single();
    const { data: position } = await client
      .from("crypto_positions")
      .insert({
        crypto_asset_id: asset!.id,
        wallet_id: wallet!.id,
        quantity: 10,
      })
      .select("id")
      .single();

    await softDelete("institutions", inst!.id);

    expect(await isDeleted("wallets", wallet!.id)).toBe(true);
    expect(await isDeleted("crypto_positions", position!.id)).toBe(true);
  });

  it("wallet → cash_accounts (exchange deposit)", async () => {
    const { data: wallet } = await client
      .from("wallets")
      .insert({
        user_id: userId,
        name: "Cascade-Wallet-3",
        wallet_type: "custodial",
      })
      .select("id")
      .single();
    const { data: deposit } = await client
      .from("cash_accounts")
      .insert({
        user_id: userId,
        wallet_id: wallet!.id,
        currency: "USD",
        balance: 500,
      })
      .select("id")
      .single();

    await softDelete("wallets", wallet!.id);
    expect(await isDeleted("cash_accounts", deposit!.id)).toBe(true);
  });

  it("institution → broker → stock_position + cash_account (two-level)", async () => {
    const { data: inst } = await client
      .from("institutions")
      .insert({ user_id: userId, name: "Cascade-Inst-5" })
      .select("id")
      .single();
    const { data: broker } = await client
      .from("brokers")
      .insert({
        user_id: userId,
        name: "Cascade-Broker-2",
        institution_id: inst!.id,
      })
      .select("id")
      .single();
    const { data: stockAsset, error: saErr } = await client
      .from("stock_assets")
      .insert({
        user_id: userId,
        ticker: "CTEST",
        name: "Cascade Stock",
        yahoo_ticker: "CTEST.DE",
        currency: "EUR",
      })
      .select("id")
      .single();
    if (saErr) throw new Error("stock_assets insert: " + saErr.message);
    const { data: stockPos, error: spErr } = await client
      .from("stock_positions")
      .insert({
        stock_asset_id: stockAsset!.id,
        broker_id: broker!.id,
        quantity: 5,
      })
      .select("id")
      .single();
    if (spErr) throw new Error("stock_positions insert: " + spErr.message);
    const { data: brokerCash, error: bcErr } = await client
      .from("cash_accounts")
      .insert({
        user_id: userId,
        broker_id: broker!.id,
        currency: "EUR",
        balance: 1000,
      })
      .select("id")
      .single();
    if (bcErr) throw new Error("cash_accounts insert: " + bcErr.message);

    await softDelete("institutions", inst!.id);

    expect(await isDeleted("brokers", broker!.id)).toBe(true);
    expect(await isDeleted("stock_positions", stockPos!.id)).toBe(true);
    expect(await isDeleted("cash_accounts", brokerCash!.id)).toBe(true);
  });

  it("crypto_asset → crypto_positions", async () => {
    const { data: wallet } = await client
      .from("wallets")
      .insert({
        user_id: userId,
        name: "Cascade-Wallet-4",
        wallet_type: "custodial",
      })
      .select("id")
      .single();
    const { data: asset } = await client
      .from("crypto_assets")
      .insert({
        user_id: userId,
        ticker: "CTEST2",
        name: "Cascade Coin 2",
        coingecko_id: "cascade-coin-2",
      })
      .select("id")
      .single();
    const { data: position } = await client
      .from("crypto_positions")
      .insert({
        crypto_asset_id: asset!.id,
        wallet_id: wallet!.id,
        quantity: 3,
      })
      .select("id")
      .single();

    await softDelete("crypto_assets", asset!.id);
    expect(await isDeleted("crypto_positions", position!.id)).toBe(true);
  });

  it("stock_asset → stock_positions", async () => {
    const { data: broker } = await client
      .from("brokers")
      .insert({ user_id: userId, name: "Cascade-Broker-3" })
      .select("id")
      .single();
    const { data: asset, error: saErr } = await client
      .from("stock_assets")
      .insert({
        user_id: userId,
        ticker: "CTEST2",
        name: "Cascade Stock 2",
        yahoo_ticker: "CTEST2.DE",
        currency: "EUR",
      })
      .select("id")
      .single();
    if (saErr) throw new Error("stock_assets insert: " + saErr.message);
    const { data: position } = await client
      .from("stock_positions")
      .insert({
        stock_asset_id: asset!.id,
        broker_id: broker!.id,
        quantity: 7,
      })
      .select("id")
      .single();

    await softDelete("stock_assets", asset!.id);
    expect(await isDeleted("stock_positions", position!.id)).toBe(true);
  });

  it("wallet → cash_account cascade restore (soft-delete then restore)", async () => {
    const { data: wallet } = await client
      .from("wallets")
      .insert({
        user_id: userId,
        name: "Cascade-Restore-Wallet",
        wallet_type: "custodial",
      })
      .select("id")
      .single();
    const { data: deposit } = await client
      .from("cash_accounts")
      .insert({
        user_id: userId,
        wallet_id: wallet!.id,
        currency: "EUR",
        balance: 250,
      })
      .select("id")
      .single();

    // Soft-delete the wallet → cash_account should cascade
    await softDelete("wallets", wallet!.id);
    expect(await isDeleted("cash_accounts", deposit!.id)).toBe(true);

    // Restore the wallet (set deleted_at = NULL) → cash_account should restore
    const { error } = await client
      .from("wallets")
      .update({ deleted_at: null })
      .eq("id", wallet!.id);
    if (error) throw new Error(`restore wallets/${wallet!.id}: ${error.message}`);

    expect(await isDeleted("cash_accounts", deposit!.id)).toBe(false);
  });
});
