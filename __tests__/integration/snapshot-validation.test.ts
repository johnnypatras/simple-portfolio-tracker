import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestUser } from "./setup";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("snapshot validation", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  beforeAll(async () => {
    const u = await createTestUser("snapshot@test.local");
    client = u.client;
    userId = u.userId;
    cleanup = u.cleanup;
  });

  afterAll(() => {
    cleanup();
  });

  it("saves snapshot with correct component sum", async () => {
    const today = new Date().toISOString().split("T")[0];
    const { error } = await client
      .from("portfolio_snapshots")
      .upsert(
        {
          user_id: userId,
          snapshot_date: today,
          total_value_usd: 100000,
          total_value_eur: 92000,
          crypto_value_usd: 50000,
          stocks_value_usd: 30000,
          cash_value_usd: 20000,
        },
        { onConflict: "user_id,snapshot_date" },
      );
    expect(error).toBeNull();

    const { data } = await client
      .from("portfolio_snapshots")
      .select("*")
      .eq("snapshot_date", today)
      .single();
    expect(
      data!.crypto_value_usd + data!.stocks_value_usd + data!.cash_value_usd,
    ).toBe(100000);
  });

  it("same-day duplicate uses upsert", async () => {
    const today = new Date().toISOString().split("T")[0];
    await client
      .from("portfolio_snapshots")
      .upsert(
        {
          user_id: userId,
          snapshot_date: today,
          total_value_usd: 105000,
          total_value_eur: 96600,
          crypto_value_usd: 55000,
          stocks_value_usd: 30000,
          cash_value_usd: 20000,
        },
        { onConflict: "user_id,snapshot_date" },
      );

    const { data } = await client
      .from("portfolio_snapshots")
      .select("*")
      .eq("snapshot_date", today);
    expect(data).toHaveLength(1);
    expect(data![0].total_value_usd).toBe(105000);
  });

  it("zero holdings — all zeros, no errors", async () => {
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .split("T")[0];
    const { error } = await client
      .from("portfolio_snapshots")
      .upsert(
        {
          user_id: userId,
          snapshot_date: yesterday,
          total_value_usd: 0,
          total_value_eur: 0,
          crypto_value_usd: 0,
          stocks_value_usd: 0,
          cash_value_usd: 0,
        },
        { onConflict: "user_id,snapshot_date" },
      );
    expect(error).toBeNull();
  });
});
