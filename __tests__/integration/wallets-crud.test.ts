import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestUser } from "./setup";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Integration tests for wallet CRUD operations.
 *
 * Tests direct DB operations (insert, select, soft-delete) and RLS isolation
 * against a real local Supabase instance. Uses the same pattern as
 * cascade-delete.test.ts — no server action mocks, just authenticated clients.
 */
describe("wallet CRUD (integration)", () => {
  let clientA: SupabaseClient;
  let userIdA: string;
  let cleanupA: () => void;

  let clientB: SupabaseClient;
  let cleanupB: () => void;

  beforeAll(async () => {
    const resultA = await createTestUser();
    clientA = resultA.client;
    userIdA = resultA.userId;
    cleanupA = resultA.cleanup;

    const resultB = await createTestUser();
    clientB = resultB.client;
    cleanupB = resultB.cleanup;
  });

  afterAll(() => {
    cleanupA();
    cleanupB();
  });

  async function softDelete(
    client: SupabaseClient,
    table: string,
    id: string
  ) {
    const { error } = await client
      .from(table)
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(`softDelete ${table}/${id}: ${error.message}`);
  }

  async function isDeleted(
    client: SupabaseClient,
    table: string,
    id: string
  ): Promise<boolean> {
    const { data } = await client
      .from(table)
      .select("deleted_at")
      .eq("id", id)
      .single();
    return data?.deleted_at != null;
  }

  it("create wallet — insert and verify", async () => {
    const { data: wallet, error } = await clientA
      .from("wallets")
      .insert({
        user_id: userIdA,
        name: "Test Wallet",
        wallet_type: "custodial",
      })
      .select("*")
      .single();

    expect(error).toBeNull();
    expect(wallet).not.toBeNull();
    expect(wallet!.name).toBe("Test Wallet");
    expect(wallet!.wallet_type).toBe("custodial");
    expect(wallet!.user_id).toBe(userIdA);
    expect(wallet!.deleted_at).toBeNull();
  });

  it("create wallet with institution — FK verified", async () => {
    // Create institution first
    const { data: inst, error: instErr } = await clientA
      .from("institutions")
      .insert({ user_id: userIdA, name: "Wallet-Inst" })
      .select("id")
      .single();
    if (instErr) throw new Error("institution insert: " + instErr.message);

    // Create wallet linked to institution
    const { data: wallet, error } = await clientA
      .from("wallets")
      .insert({
        user_id: userIdA,
        name: "Inst-Wallet",
        wallet_type: "custodial",
        institution_id: inst!.id,
      })
      .select("*")
      .single();

    expect(error).toBeNull();
    expect(wallet).not.toBeNull();
    expect(wallet!.institution_id).toBe(inst!.id);

    // Verify the institution exists and is linked
    const { data: fetchedInst } = await clientA
      .from("institutions")
      .select("id, name")
      .eq("id", inst!.id)
      .single();
    expect(fetchedInst).not.toBeNull();
    expect(fetchedInst!.name).toBe("Wallet-Inst");
  });

  it("RLS isolation — User B cannot SELECT User A's wallets", async () => {
    // Create a wallet for User A
    const { data: wallet } = await clientA
      .from("wallets")
      .insert({
        user_id: userIdA,
        name: "RLS-Private-Wallet",
        wallet_type: "non_custodial",
      })
      .select("id")
      .single();

    // User B should see nothing
    const { data } = await clientB
      .from("wallets")
      .select("*")
      .eq("id", wallet!.id);
    expect(data).toEqual([]);
  });

  it("soft-delete wallet — crypto_positions still exist but are cascade-deleted", async () => {
    // Create wallet + crypto asset + position
    const { data: wallet } = await clientA
      .from("wallets")
      .insert({
        user_id: userIdA,
        name: "SoftDel-Wallet",
        wallet_type: "custodial",
      })
      .select("id")
      .single();

    const { data: asset } = await clientA
      .from("crypto_assets")
      .insert({
        user_id: userIdA,
        ticker: "WTEST",
        name: "Wallet Test Coin",
        coingecko_id: "wallet-test-" + Date.now(),
      })
      .select("id")
      .single();

    const { data: position } = await clientA
      .from("crypto_positions")
      .insert({
        crypto_asset_id: asset!.id,
        wallet_id: wallet!.id,
        quantity: 50,
      })
      .select("id")
      .single();

    // Soft-delete the wallet
    await softDelete(clientA, "wallets", wallet!.id);

    // Wallet should be soft-deleted
    expect(await isDeleted(clientA, "wallets", wallet!.id)).toBe(true);

    // Position should be cascade soft-deleted by DB trigger
    expect(await isDeleted(clientA, "crypto_positions", position!.id)).toBe(
      true
    );

    // Position row still physically exists (not hard-deleted)
    const { data: posRow } = await clientA
      .from("crypto_positions")
      .select("id, deleted_at")
      .eq("id", position!.id)
      .single();
    expect(posRow).not.toBeNull();
    expect(posRow!.deleted_at).not.toBeNull();
  });

  it("cascade institution delete — wallets cascade soft-deleted", async () => {
    // Create institution + wallet
    const { data: inst } = await clientA
      .from("institutions")
      .insert({ user_id: userIdA, name: "Cascade-Inst-Wallet" })
      .select("id")
      .single();

    const { data: wallet } = await clientA
      .from("wallets")
      .insert({
        user_id: userIdA,
        name: "Cascade-Child-Wallet",
        wallet_type: "custodial",
        institution_id: inst!.id,
      })
      .select("id")
      .single();

    // Verify both exist and are active
    expect(await isDeleted(clientA, "institutions", inst!.id)).toBe(false);
    expect(await isDeleted(clientA, "wallets", wallet!.id)).toBe(false);

    // Soft-delete the institution
    await softDelete(clientA, "institutions", inst!.id);

    // Institution should be soft-deleted
    expect(await isDeleted(clientA, "institutions", inst!.id)).toBe(true);

    // Wallet should be cascade soft-deleted by DB trigger
    expect(await isDeleted(clientA, "wallets", wallet!.id)).toBe(true);
  });
});
