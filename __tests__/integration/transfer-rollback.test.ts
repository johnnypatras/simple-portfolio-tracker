import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration tests for transfer leg storage and cashflow exclusion.
 *
 * Portfolio transfers are two-legged operations (sell + buy, or move from/to)
 * linked by a shared transfer_group_id. Both legs are marked is_adjustment=true
 * so the S&P benchmark ignores them, and both have null cashflow_status so they
 * are excluded from cashflow derivation queries.
 *
 * These tests verify that behavior at the DB level.
 */
describe("transfer rollback / storage (integration)", () => {
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

  it("transfer legs are linked by transfer_group_id and both are adjustments", async () => {
    const groupId = crypto.randomUUID();

    // Insert two legs of the same transfer
    const { error: legAError } = await client.from("activity_log").insert({
      user_id: userId,
      action: "updated",
      entity_type: "crypto_position",
      entity_name: "BTC (sell leg)",
      description: "Transfer: sold BTC on Exchange A",
      is_adjustment: true,
      delta_usd: -500.0,
      delta_eur: -450.0,
      transfer_group_id: groupId,
    });
    expect(legAError).toBeNull();

    const { error: legBError } = await client.from("activity_log").insert({
      user_id: userId,
      action: "updated",
      entity_type: "crypto_position",
      entity_name: "BTC (buy leg)",
      description: "Transfer: bought BTC on Exchange B",
      is_adjustment: true,
      delta_usd: 495.0, // slightly less due to fee
      delta_eur: 445.5,
      transfer_group_id: groupId,
    });
    expect(legBError).toBeNull();

    // Query both legs via the transfer_group_id index
    const { data: rows, error: queryError } = await client
      .from("activity_log")
      .select("id, is_adjustment, transfer_group_id, entity_name")
      .eq("transfer_group_id", groupId);

    expect(queryError).toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows!.every((r) => r.is_adjustment === true)).toBe(true);
    expect(rows!.every((r) => r.transfer_group_id === groupId)).toBe(true);
  });

  it("both transfer legs have null cashflow_status", async () => {
    const groupId = crypto.randomUUID();

    await client.from("activity_log").insert([
      {
        user_id: userId,
        action: "updated",
        entity_type: "exchange_deposit",
        entity_name: "USDT sell leg",
        description: "Transfer sell leg",
        is_adjustment: true,
        transfer_group_id: groupId,
        cashflow_status: null,
      },
      {
        user_id: userId,
        action: "updated",
        entity_type: "exchange_deposit",
        entity_name: "USDT buy leg",
        description: "Transfer buy leg",
        is_adjustment: true,
        transfer_group_id: groupId,
        cashflow_status: null,
      },
    ]);

    const { data: rows, error } = await client
      .from("activity_log")
      .select("id, cashflow_status, transfer_group_id")
      .eq("transfer_group_id", groupId);

    expect(error).toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows!.every((r) => r.cashflow_status === null)).toBe(true);
  });

  it("transfer rows are excluded from cashflow_status = complete queries", async () => {
    const groupId = crypto.randomUUID();

    // Insert transfer rows (no cashflow_status)
    const { error: insertError } = await client.from("activity_log").insert([
      {
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "SOL transfer sell",
        description: "Transfer sell leg",
        is_adjustment: true,
        transfer_group_id: groupId,
        cashflow_status: null,
      },
      {
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "SOL transfer buy",
        description: "Transfer buy leg",
        is_adjustment: true,
        transfer_group_id: groupId,
        cashflow_status: null,
      },
    ]);
    expect(insertError).toBeNull();

    // Also insert a non-transfer row with cashflow_status = complete for contrast
    const { data: realCashflow, error: cfError } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "BTC real purchase",
        description: "Bought BTC from fiat",
        is_adjustment: false,
        cashflow_status: "complete",
        cashflow_amount_usd: 1000.0,
      })
      .select("id")
      .single();
    expect(cfError).toBeNull();
    const realCashflowId = realCashflow!.id;

    // Query for complete cashflows — transfer rows must NOT appear
    const { data: completeRows, error: queryError } = await client
      .from("activity_log")
      .select("id, cashflow_status, transfer_group_id")
      .eq("cashflow_status", "complete")
      .eq("user_id", userId);

    expect(queryError).toBeNull();
    expect(completeRows).not.toBeNull();

    // The real cashflow should appear
    const foundIds = completeRows!.map((r) => r.id);
    expect(foundIds).toContain(realCashflowId);

    // Transfer rows (null cashflow_status) must NOT appear in complete results
    const transferRows = completeRows!.filter(
      (r) => r.transfer_group_id === groupId,
    );
    expect(transferRows).toHaveLength(0);
  });
});
