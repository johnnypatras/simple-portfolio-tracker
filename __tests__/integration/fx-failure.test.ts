import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration tests for FX failure status tracking on activity_log.
 *
 * These tests verify that delta_status and cashflow_status 'pending' / 'failed'
 * values are correctly stored and queryable. The partial indexes created in
 * 003_cashflow_columns.sql make these queries efficient at scale; here we
 * verify the DB accepts and returns the correct rows.
 */
describe("FX failure status (integration)", () => {
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

  it("delta_status = pending is stored and queryable (exercises pending-deltas index)", async () => {
    const { data: inserted, error: insertError } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "BTC delta pending",
        description: "FX unavailable at write time",
        is_adjustment: true,
        delta_usd: null,
        delta_eur: null,
        delta_status: "pending",
      })
      .select("id")
      .single();

    expect(insertError).toBeNull();
    expect(inserted).not.toBeNull();
    const insertedId = inserted!.id;

    // Query via the partial index pattern (backfill scan)
    const { data: rows, error: queryError } = await client
      .from("activity_log")
      .select("id, delta_status, delta_usd")
      .eq("user_id", userId)
      .eq("delta_status", "pending")
      .eq("id", insertedId);

    expect(queryError).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows![0].delta_status).toBe("pending");
    expect(rows![0].delta_usd).toBeNull();
  });

  it("cashflow_status = pending is stored and queryable (exercises pending-cashflows index)", async () => {
    const { data: inserted, error: insertError } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "stock_position",
        entity_name: "MSFT cashflow pending",
        description: "FX unavailable at write time",
        is_adjustment: false,
        cashflow_status: "pending",
      })
      .select("id")
      .single();

    expect(insertError).toBeNull();
    expect(inserted).not.toBeNull();
    const insertedId = inserted!.id;

    const { data: rows, error: queryError } = await client
      .from("activity_log")
      .select("id, cashflow_status")
      .eq("user_id", userId)
      .eq("cashflow_status", "pending")
      .eq("id", insertedId);

    expect(queryError).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows![0].cashflow_status).toBe("pending");
  });

  it("failed status rows are found by the OR query used for failedCount in deriveCashFlows", async () => {
    // Insert a row with cashflow_status = 'failed'
    const { data: cf, error: cfError } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "SOL cashflow failed",
        description: "FX rate fetch failed after retries",
        is_adjustment: false,
        cashflow_status: "failed",
      })
      .select("id")
      .single();

    expect(cfError).toBeNull();
    const cfId = cf!.id;

    // Insert a row with delta_status = 'failed'
    const { data: dl, error: dlError } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "ETH delta failed",
        description: "Delta backfill failed after retries",
        is_adjustment: true,
        delta_status: "failed",
      })
      .select("id")
      .single();

    expect(dlError).toBeNull();
    const dlId = dl!.id;

    // This is the OR query used by deriveCashFlows to count failures shown in the UI
    const { data: rows, error: queryError } = await client
      .from("activity_log")
      .select("id, cashflow_status, delta_status")
      .eq("user_id", userId)
      .or("cashflow_status.eq.failed,delta_status.eq.failed");

    expect(queryError).toBeNull();
    expect(rows).not.toBeNull();

    const foundIds = rows!.map((r) => r.id);
    expect(foundIds).toContain(cfId);
    expect(foundIds).toContain(dlId);

    // Verify the status values are correct
    const cfRow = rows!.find((r) => r.id === cfId);
    const dlRow = rows!.find((r) => r.id === dlId);
    expect(cfRow!.cashflow_status).toBe("failed");
    expect(dlRow!.delta_status).toBe("failed");
  });
});
