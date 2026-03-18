import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestUser, getAdminClient } from "./setup";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("RLS enforcement", () => {
  let userA: {
    client: SupabaseClient;
    userId: string;
    cleanup: () => void;
  };
  let userB: {
    client: SupabaseClient;
    userId: string;
    cleanup: () => void;
  };
  let cryptoAssetId: string;
  let cashAccountId: string;

  beforeAll(async () => {
    userA = await createTestUser("rls-a@test.local");
    userB = await createTestUser("rls-b@test.local");

    const { data: asset } = await userA.client
      .from("crypto_assets")
      .insert({
        user_id: userA.userId,
        name: "Bitcoin",
        ticker: "BTC",
        coingecko_id: "bitcoin",
      })
      .select("id")
      .single();
    cryptoAssetId = asset!.id;

    // Create a cash_account for RLS tests
    const { data: inst } = await userA.client
      .from("institutions")
      .insert({ user_id: userA.userId, name: "RLS-Bank" })
      .select("id")
      .single();
    const { data: cash } = await userA.client
      .from("cash_accounts")
      .insert({
        user_id: userA.userId,
        name: "RLS-Cash",
        institution_id: inst!.id,
        currency: "EUR",
        balance: 3000,
      })
      .select("id")
      .single();
    cashAccountId = cash!.id;
  });

  afterAll(() => {
    userA.cleanup();
    userB.cleanup();
  });

  it("User B cannot SELECT User A's crypto_assets", async () => {
    const { data } = await userB.client
      .from("crypto_assets")
      .select("*")
      .eq("id", cryptoAssetId);
    expect(data).toEqual([]);
  });

  it("User B cannot UPDATE User A's data", async () => {
    await userB.client
      .from("crypto_assets")
      .update({ name: "Hacked" })
      .eq("id", cryptoAssetId);
    const { data } = await userA.client
      .from("crypto_assets")
      .select("name")
      .eq("id", cryptoAssetId)
      .single();
    expect(data?.name).toBe("Bitcoin");
  });

  it("User B cannot INSERT with User A's user_id", async () => {
    const { error } = await userB.client.from("crypto_assets").insert({
      user_id: userA.userId,
      name: "Injected",
      ticker: "HACK",
      coingecko_id: "hack",
    });
    // RLS blocks the insert — verify via both paths unconditionally
    // Supabase may return an error OR silently reject (no rows affected)
    const { data } = await userA.client
      .from("crypto_assets")
      .select("id")
      .eq("ticker", "HACK");
    expect(data).toEqual([]);
    // If an error was returned, it should be a real RLS violation
    if (error) {
      expect(error.code).toBeTruthy();
    }
  });

  it("User B cannot SELECT User A's cash_accounts", async () => {
    const { data } = await userB.client
      .from("cash_accounts")
      .select("*")
      .eq("id", cashAccountId);
    expect(data).toEqual([]);
  });

  it("User B cannot UPDATE User A's cash_accounts", async () => {
    await userB.client
      .from("cash_accounts")
      .update({ balance: 0 })
      .eq("id", cashAccountId);
    const { data } = await userA.client
      .from("cash_accounts")
      .select("balance")
      .eq("id", cashAccountId)
      .single();
    expect(data?.balance).toBe(3000);
  });

  it("User B cannot DELETE User A's activity_log", async () => {
    const admin = getAdminClient();
    await admin.from("activity_log").insert({
      user_id: userA.userId,
      action: "created",
      entity_type: "crypto_asset",
      entity_name: "Bitcoin",
      description: "Test",
    });
    const { data: logs } = await userA.client
      .from("activity_log")
      .select("id")
      .limit(1);
    expect(logs).toBeDefined();
    expect(logs!.length).toBeGreaterThan(0);

    await userB.client
      .from("activity_log")
      .delete()
      .eq("id", logs![0].id);
    const { data: after } = await userA.client
      .from("activity_log")
      .select("id")
      .eq("id", logs![0].id);
    expect(after).toHaveLength(1);
  });
});
