import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration tests for cashflow column writes on activity_log.
 *
 * These tests verify that the new columns added in migration 003_cashflow_columns.sql
 * (cashflow_amount_usd, cashflow_amount_eur, cashflow_asset_class, cashflow_status,
 * delta_status) are correctly stored and queryable at the DB level.
 *
 * Tests insert directly into activity_log (not via server actions) because we're
 * testing schema correctness and index behaviour, not business logic.
 */
describe("cashflow write (integration)", () => {
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

  it("activity_log accepts cashflow fields and is queryable by cashflow_status", async () => {
    const { data, error } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "BTC position",
        description: "Bought 0.5 BTC",
        is_adjustment: false,
        cashflow_amount_usd: 15000.0,
        cashflow_amount_eur: 13500.0,
        cashflow_asset_class: "crypto",
        cashflow_status: "complete",
      })
      .select("id, cashflow_amount_usd, cashflow_amount_eur, cashflow_asset_class, cashflow_status")
      .single();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    const insertedId = data!.id;

    // Now query using the cashflow_status filter (exercises the partial index)
    const { data: rows, error: queryError } = await client
      .from("activity_log")
      .select("id, cashflow_status, cashflow_amount_usd, cashflow_asset_class")
      .eq("cashflow_status", "complete")
      .eq("id", insertedId);

    expect(queryError).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows![0].cashflow_status).toBe("complete");
    expect(Number(rows![0].cashflow_amount_usd)).toBe(15000.0);
    expect(rows![0].cashflow_asset_class).toBe("crypto");
  });

  it("adjustment rows store delta_status but have null cashflow_status", async () => {
    const { data, error } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "ETH position",
        description: "Portfolio correction",
        is_adjustment: true,
        delta_usd: 500.0,
        delta_eur: 450.0,
        delta_status: "complete",
        cashflow_status: null,
      })
      .select("id, is_adjustment, delta_status, cashflow_status")
      .single();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.is_adjustment).toBe(true);
    expect(data!.delta_status).toBe("complete");
    expect(data!.cashflow_status).toBeNull();
  });

  it("pending cashflow_status rows are found by backfill index query", async () => {
    const { error: insertError } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "stock_position",
        entity_name: "AAPL position",
        description: "Bought 10 AAPL",
        is_adjustment: false,
        cashflow_status: "pending",
      });

    expect(insertError).toBeNull();

    // This is the query pattern used by the backfill scan
    const { data: rows, error: queryError } = await client
      .from("activity_log")
      .select("id, cashflow_status")
      .eq("user_id", userId)
      .eq("cashflow_status", "pending");

    expect(queryError).toBeNull();
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThanOrEqual(1);
    expect(rows!.every((r) => r.cashflow_status === "pending")).toBe(true);
  });

  it("zero-delta cashflow rows are accepted with complete status", async () => {
    const { data, error } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "bank_account",
        entity_name: "Savings account",
        description: "Zero-value adjustment",
        is_adjustment: false,
        cashflow_amount_usd: 0,
        cashflow_amount_eur: 0,
        cashflow_status: "complete",
      })
      .select("id, cashflow_amount_usd, cashflow_status")
      .single();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(Number(data!.cashflow_amount_usd)).toBe(0);
    expect(data!.cashflow_status).toBe("complete");
  });
});
