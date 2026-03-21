import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration tests for cashflow/delta backfill pipeline columns.
 *
 * These tests verify DB-level column storage, status transitions, and query
 * patterns used by the backfill server action (src/lib/actions/backfill.ts).
 * They insert directly into activity_log — no price API mocking needed.
 *
 * Columns tested:
 *   cashflow_status, cashflow_amount_usd, cashflow_amount_eur, cashflow_asset_class,
 *   cashflow_attempted_at, delta_status, delta_usd, delta_eur, delta_attempted_at
 */
describe("backfill pipeline columns (integration)", () => {
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

  it("pending cashflow row — insert and query by cashflow_status filter", async () => {
    const { data, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_name: "BTC position",
        description: "Bought 0.1 BTC",
        is_adjustment: false,
        cashflow_status: "pending",
      })
      .select("id, cashflow_status")
      .single();

    expect(insertErr).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.cashflow_status).toBe("pending");

    // Query using the backfill scan pattern
    const { data: pending, error: queryErr } = await client
      .from("activity_log")
      .select("id, cashflow_status")
      .eq("user_id", userId)
      .eq("cashflow_status", "pending")
      .eq("id", data!.id);

    expect(queryErr).toBeNull();
    expect(pending).toHaveLength(1);
    expect(pending![0].cashflow_status).toBe("pending");
  });

  it("pending delta row — insert and query by delta_status filter", async () => {
    const { data, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "ETH position",
        description: "Updated ETH quantity",
        is_adjustment: true,
        delta_status: "pending",
        cashflow_status: null,
      })
      .select("id, delta_status, cashflow_status")
      .single();

    expect(insertErr).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.delta_status).toBe("pending");
    expect(data!.cashflow_status).toBeNull();

    // Query using the delta backfill scan pattern
    const { data: pending, error: queryErr } = await client
      .from("activity_log")
      .select("id, delta_status")
      .eq("user_id", userId)
      .eq("delta_status", "pending")
      .eq("id", data!.id);

    expect(queryErr).toBeNull();
    expect(pending).toHaveLength(1);
    expect(pending![0].delta_status).toBe("pending");
  });

  it("cashflow status transition — pending to complete with amounts", async () => {
    // Insert a pending row
    const { data: row, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "stock_position",
        entity_name: "AAPL position",
        description: "Bought 10 AAPL",
        is_adjustment: false,
        cashflow_status: "pending",
      })
      .select("id")
      .single();
    expect(insertErr).toBeNull();
    const rowId = row!.id;

    // Transition to complete (as backfill does after price lookup)
    const now = new Date().toISOString();
    const { error: updateErr } = await client
      .from("activity_log")
      .update({
        cashflow_amount_usd: 1500.5,
        cashflow_amount_eur: 1350.45,
        cashflow_asset_class: "stocks",
        cashflow_status: "complete",
        cashflow_attempted_at: now,
      })
      .eq("id", rowId);
    expect(updateErr).toBeNull();

    // Verify all columns stored correctly
    const { data: updated, error: readErr } = await client
      .from("activity_log")
      .select(
        "cashflow_status, cashflow_amount_usd, cashflow_amount_eur, cashflow_asset_class, cashflow_attempted_at"
      )
      .eq("id", rowId)
      .single();

    expect(readErr).toBeNull();
    expect(updated!.cashflow_status).toBe("complete");
    expect(Number(updated!.cashflow_amount_usd)).toBe(1500.5);
    expect(Number(updated!.cashflow_amount_eur)).toBe(1350.45);
    expect(updated!.cashflow_asset_class).toBe("stocks");
    expect(updated!.cashflow_attempted_at).not.toBeNull();
  });

  it("delta status transition — pending to complete with values", async () => {
    // Insert a pending delta row
    const { data: row, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "SOL position",
        description: "Portfolio correction",
        is_adjustment: true,
        delta_status: "pending",
      })
      .select("id")
      .single();
    expect(insertErr).toBeNull();
    const rowId = row!.id;

    // Transition to complete
    const now = new Date().toISOString();
    const { error: updateErr } = await client
      .from("activity_log")
      .update({
        delta_usd: 250.75,
        delta_eur: 225.68,
        delta_status: "complete",
        delta_attempted_at: now,
      })
      .eq("id", rowId);
    expect(updateErr).toBeNull();

    // Verify
    const { data: updated, error: readErr } = await client
      .from("activity_log")
      .select("delta_status, delta_usd, delta_eur, delta_attempted_at")
      .eq("id", rowId)
      .single();

    expect(readErr).toBeNull();
    expect(updated!.delta_status).toBe("complete");
    expect(Number(updated!.delta_usd)).toBe(250.75);
    expect(Number(updated!.delta_eur)).toBe(225.68);
    expect(updated!.delta_attempted_at).not.toBeNull();
  });

  it("failed status — cashflow_status set to failed after exhausted retries", async () => {
    const { data: row, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_name: "DOGE position",
        description: "Bought DOGE",
        is_adjustment: false,
        cashflow_status: "pending",
      })
      .select("id")
      .single();
    expect(insertErr).toBeNull();
    const rowId = row!.id;

    // Transition to failed (as backfill does after MAX_DAYS_BEFORE_EXHAUSTED)
    const { error: updateErr } = await client
      .from("activity_log")
      .update({
        cashflow_amount_usd: 0,
        cashflow_amount_eur: 0,
        cashflow_status: "failed",
        cashflow_attempted_at: new Date().toISOString(),
      })
      .eq("id", rowId);
    expect(updateErr).toBeNull();

    // Verify
    const { data: updated, error: readErr } = await client
      .from("activity_log")
      .select("cashflow_status, cashflow_amount_usd")
      .eq("id", rowId)
      .single();

    expect(readErr).toBeNull();
    expect(updated!.cashflow_status).toBe("failed");
    expect(Number(updated!.cashflow_amount_usd)).toBe(0);
  });

  it("failed delta_status — stored correctly", async () => {
    const { data: row, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "stock_position",
        entity_name: "TSLA position",
        description: "Portfolio correction on TSLA",
        is_adjustment: true,
        delta_status: "pending",
      })
      .select("id")
      .single();
    expect(insertErr).toBeNull();
    const rowId = row!.id;

    const { error: updateErr } = await client
      .from("activity_log")
      .update({
        delta_usd: 0,
        delta_eur: 0,
        delta_status: "failed",
        delta_attempted_at: new Date().toISOString(),
      })
      .eq("id", rowId);
    expect(updateErr).toBeNull();

    const { data: updated, error: readErr } = await client
      .from("activity_log")
      .select("delta_status, delta_usd")
      .eq("id", rowId)
      .single();

    expect(readErr).toBeNull();
    expect(updated!.delta_status).toBe("failed");
  });

  it("throttle gate — cashflow_attempted_at is writable and queryable", async () => {
    const pastDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48h ago

    const { data: row, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_name: "ADA position",
        description: "Bought ADA",
        is_adjustment: false,
        cashflow_status: "pending",
        cashflow_attempted_at: pastDate,
      })
      .select("id, cashflow_attempted_at")
      .single();
    expect(insertErr).toBeNull();
    expect(row!.cashflow_attempted_at).not.toBeNull();

    // Verify: the backfill throttle query pattern works.
    // Rows with cashflow_attempted_at older than the throttle window are eligible.
    const throttleDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 24h ago
    const { data: eligible, error: queryErr } = await client
      .from("activity_log")
      .select("id, cashflow_attempted_at")
      .eq("id", row!.id)
      .eq("cashflow_status", "pending")
      .lt("cashflow_attempted_at", throttleDate);

    expect(queryErr).toBeNull();
    expect(eligible).toHaveLength(1);
    expect(eligible![0].id).toBe(row!.id);
  });

  it("throttle gate — delta_attempted_at is writable and queryable", async () => {
    const pastDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const { data: row, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "stock_position",
        entity_name: "NVDA position",
        description: "Correction on NVDA",
        is_adjustment: true,
        delta_status: "pending",
        delta_attempted_at: pastDate,
      })
      .select("id, delta_attempted_at")
      .single();
    expect(insertErr).toBeNull();
    expect(row!.delta_attempted_at).not.toBeNull();

    // Verify: delta throttle query finds rows past the window
    const throttleDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: eligible, error: queryErr } = await client
      .from("activity_log")
      .select("id, delta_attempted_at")
      .eq("id", row!.id)
      .eq("delta_status", "pending")
      .lt("delta_attempted_at", throttleDate);

    expect(queryErr).toBeNull();
    expect(eligible).toHaveLength(1);
    expect(eligible![0].id).toBe(row!.id);
  });

  it("recently-attempted rows are excluded by throttle query", async () => {
    const recentDate = new Date().toISOString(); // just now

    const { data: row, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_name: "XRP position",
        description: "Bought XRP",
        is_adjustment: false,
        cashflow_status: "pending",
        cashflow_attempted_at: recentDate,
      })
      .select("id")
      .single();
    expect(insertErr).toBeNull();

    // This row was attempted just now — it should NOT appear in the throttle query
    const throttleDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: eligible, error: queryErr } = await client
      .from("activity_log")
      .select("id")
      .eq("id", row!.id)
      .eq("cashflow_status", "pending")
      .lt("cashflow_attempted_at", throttleDate);

    expect(queryErr).toBeNull();
    expect(eligible).toHaveLength(0);
  });
});
