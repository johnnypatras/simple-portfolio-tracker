import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration tests for the compensating transaction undo system.
 *
 * Tests verify DB-level behaviour of the undo flow:
 * - undone_at column marking entries as undone
 * - compensates_for linking compensation entries to originals
 * - transfer_group_id paired undo (both legs marked)
 * - double-undo prevention via undone_at guard
 * - RLS isolation (User B cannot see/modify User A's activity_log)
 *
 * These tests insert directly into activity_log and related tables (not via
 * server actions) because we are testing schema correctness and column
 * behaviour, not the full undo business logic (which requires price API mocking).
 */
describe("undo compensating transactions (integration)", () => {
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

  it("undo a 'created' action — marks entry with undone_at and entity with deleted_at", async () => {
    // Create a crypto_asset to undo
    const { data: asset, error: assetErr } = await client
      .from("crypto_assets")
      .insert({
        user_id: userId,
        name: "UndoTestCoin",
        ticker: "UTC",
        coingecko_id: `undo-test-${Date.now()}`,
      })
      .select("id")
      .single();
    expect(assetErr).toBeNull();
    const assetId = asset!.id;

    // Insert an activity_log entry for the creation
    const { data: logEntry, error: logErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_asset",
        entity_name: "UTC — UndoTestCoin",
        description: "Added crypto asset UndoTestCoin",
        entity_id: assetId,
        entity_table: "crypto_assets",
        after_snapshot: { name: "UndoTestCoin", ticker: "UTC" },
      })
      .select("id")
      .single();
    expect(logErr).toBeNull();
    const logId = logEntry!.id;

    // Simulate the undo flow: mark entry as undone + soft-delete the entity
    const undoneAt = new Date().toISOString();
    const { error: undoErr } = await client
      .from("activity_log")
      .update({ undone_at: undoneAt })
      .eq("id", logId);
    expect(undoErr).toBeNull();

    const { error: deleteErr } = await client
      .from("crypto_assets")
      .update({ deleted_at: undoneAt })
      .eq("id", assetId);
    expect(deleteErr).toBeNull();

    // Verify: activity_log entry has undone_at set
    const { data: undoneLog } = await client
      .from("activity_log")
      .select("undone_at")
      .eq("id", logId)
      .single();
    expect(undoneLog).not.toBeNull();
    expect(undoneLog!.undone_at).not.toBeNull();

    // Verify: entity is soft-deleted
    const { data: deletedAsset } = await client
      .from("crypto_assets")
      .select("deleted_at")
      .eq("id", assetId)
      .single();
    expect(deletedAsset).not.toBeNull();
    expect(deletedAsset!.deleted_at).not.toBeNull();
  });

  it("compensation entry is created with compensates_for linking to original", async () => {
    // Insert the original "updated" activity_log entry
    const entityId = crypto.randomUUID();
    const { data: original, error: origErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "BTC position",
        description: "Updated BTC quantity 5 → 10",
        entity_id: entityId,
        entity_table: "crypto_positions",
        before_snapshot: { quantity: 5 },
        after_snapshot: { quantity: 10 },
      })
      .select("id")
      .single();
    expect(origErr).toBeNull();
    const originalId = original!.id;

    // Insert a compensation entry that links back via compensates_for
    const { data: comp, error: compErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "BTC position",
        description: "Undid update on BTC position (Quantity: 10 → 5)",
        entity_id: entityId,
        entity_table: "crypto_positions",
        before_snapshot: { quantity: 10 },
        after_snapshot: { quantity: 5 },
        compensates_for: originalId,
        is_adjustment: false,
        delta_usd: null,
        delta_eur: null,
      })
      .select("id, compensates_for")
      .single();
    expect(compErr).toBeNull();
    expect(comp).not.toBeNull();
    expect(comp!.compensates_for).toBe(originalId);

    // Mark the original as undone
    const { error: undoErr } = await client
      .from("activity_log")
      .update({ undone_at: new Date().toISOString() })
      .eq("id", originalId);
    expect(undoErr).toBeNull();

    // Verify: the compensation can be queried by compensates_for
    const { data: linked, error: queryErr } = await client
      .from("activity_log")
      .select("id, compensates_for, action")
      .eq("compensates_for", originalId);
    expect(queryErr).toBeNull();
    expect(linked).toHaveLength(1);
    expect(linked![0].id).toBe(comp!.id);
    expect(linked![0].compensates_for).toBe(originalId);

    // Verify: the original now has undone_at set
    const { data: origCheck } = await client
      .from("activity_log")
      .select("undone_at")
      .eq("id", originalId)
      .single();
    expect(origCheck!.undone_at).not.toBeNull();
  });

  it("undo transfer pair — both legs marked with undone_at", async () => {
    const groupId = crypto.randomUUID();

    // Insert two transfer legs with the same transfer_group_id
    const { data: legA, error: legAErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "BTC (sell leg)",
        description: "Transfer: sold BTC on Exchange A",
        is_adjustment: true,
        delta_usd: -500.0,
        delta_eur: -450.0,
        transfer_group_id: groupId,
      })
      .select("id")
      .single();
    expect(legAErr).toBeNull();

    const { data: legB, error: legBErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "BTC (buy leg)",
        description: "Transfer: bought BTC on Exchange B",
        is_adjustment: true,
        delta_usd: 495.0,
        delta_eur: 445.5,
        transfer_group_id: groupId,
      })
      .select("id")
      .single();
    expect(legBErr).toBeNull();

    // Simulate paired undo: mark BOTH legs as undone (as undoTransferGroup does)
    const undoneAt = new Date().toISOString();
    const { error: undoAErr } = await client
      .from("activity_log")
      .update({ undone_at: undoneAt })
      .eq("id", legA!.id);
    expect(undoAErr).toBeNull();

    const { error: undoBErr } = await client
      .from("activity_log")
      .update({ undone_at: undoneAt })
      .eq("id", legB!.id);
    expect(undoBErr).toBeNull();

    // Verify: both legs now have undone_at set
    const { data: group, error: groupErr } = await client
      .from("activity_log")
      .select("id, undone_at, transfer_group_id")
      .eq("transfer_group_id", groupId);
    expect(groupErr).toBeNull();
    expect(group).toHaveLength(2);
    expect(group!.every((r) => r.undone_at !== null)).toBe(true);

    // Verify: querying for non-undone entries in this group returns nothing
    const { data: active, error: activeErr } = await client
      .from("activity_log")
      .select("id")
      .eq("transfer_group_id", groupId)
      .is("undone_at", null);
    expect(activeErr).toBeNull();
    expect(active).toHaveLength(0);
  });

  it("already-undone guard — undone_at is set, preventing re-undo", async () => {
    // Insert an entry that is already undone
    const undoneAt = new Date().toISOString();
    const { data: entry, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_asset",
        entity_name: "ALREADYUNDONE",
        description: "This entry is already undone",
        undone_at: undoneAt,
      })
      .select("id, undone_at")
      .single();
    expect(insertErr).toBeNull();

    // Verify: the entry has undone_at set (guard condition used by undoActivity)
    expect(entry!.undone_at).not.toBeNull();

    // Verify: querying for active (non-undone) entries excludes this one
    const { data: active } = await client
      .from("activity_log")
      .select("id")
      .eq("id", entry!.id)
      .is("undone_at", null);
    expect(active).toHaveLength(0);

    // Verify: the entry exists but is filtered out by the is-null guard
    const { data: allEntries } = await client
      .from("activity_log")
      .select("id, undone_at")
      .eq("id", entry!.id);
    expect(allEntries).toHaveLength(1);
    // Supabase returns +00:00 suffix, not Z — compare as Date
    expect(new Date(allEntries![0].undone_at).getTime()).toBe(new Date(undoneAt).getTime());
  });

  it("double-undo prevention — existing compensation blocks re-compensation", async () => {
    const entityId = crypto.randomUUID();

    // Insert original entry
    const { data: original, error: origErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "ETH position",
        description: "Updated ETH quantity",
        entity_id: entityId,
        entity_table: "crypto_positions",
        before_snapshot: { quantity: 2 },
        after_snapshot: { quantity: 5 },
        undone_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    expect(origErr).toBeNull();
    const originalId = original!.id;

    // Insert an active compensation entry (no undone_at)
    const { error: compErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "ETH position",
        description: "Undid update on ETH position",
        entity_id: entityId,
        entity_table: "crypto_positions",
        compensates_for: originalId,
        before_snapshot: { quantity: 5 },
        after_snapshot: { quantity: 2 },
      })
      .select("id")
      .single();
    expect(compErr).toBeNull();

    // Verify: querying for active compensations for this original finds one
    // (this is the guard used by undoActivity to prevent double-undo)
    const { data: existingComp } = await client
      .from("activity_log")
      .select("id")
      .eq("compensates_for", originalId)
      .is("undone_at", null);
    expect(existingComp).toHaveLength(1);
  });
});

describe("undo RLS isolation (integration)", () => {
  let userA: { client: SupabaseClient; userId: string; cleanup: () => void };
  let userB: { client: SupabaseClient; userId: string; cleanup: () => void };
  let userALogId: string;

  beforeAll(async () => {
    userA = await createTestUser("undo-rls-a@test.local");
    userB = await createTestUser("undo-rls-b@test.local");

    // User A inserts an activity_log entry
    const { data, error } = await userA.client
      .from("activity_log")
      .insert({
        user_id: userA.userId,
        action: "created",
        entity_type: "crypto_asset",
        entity_name: "RLS-Test-Coin",
        description: "Created by User A",
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    userALogId = data!.id;
  });

  afterAll(() => {
    userA.cleanup();
    userB.cleanup();
  });

  it("User B cannot SELECT User A's activity_log entries", async () => {
    const { data } = await userB.client
      .from("activity_log")
      .select("id")
      .eq("id", userALogId);
    expect(data).toEqual([]);
  });

  it("User B cannot UPDATE User A's activity_log (set undone_at)", async () => {
    // User B tries to mark User A's entry as undone
    await userB.client
      .from("activity_log")
      .update({ undone_at: new Date().toISOString() })
      .eq("id", userALogId);

    // Verify: User A's entry is unchanged
    const { data } = await userA.client
      .from("activity_log")
      .select("undone_at")
      .eq("id", userALogId)
      .single();
    expect(data).not.toBeNull();
    expect(data!.undone_at).toBeNull();
  });

  it("User B cannot INSERT a compensation entry referencing User A's log", async () => {
    // User B tries to insert a compensation entry pointing to User A's entry.
    // RLS user_id check prevents the insert from being visible to User A,
    // and User B's own client would need their own user_id.
    const { data: inserted, error: insertErr } = await userB.client
      .from("activity_log")
      .insert({
        user_id: userA.userId, // Attempting to impersonate User A
        action: "updated",
        entity_type: "crypto_asset",
        entity_name: "Malicious compensation",
        description: "User B trying to inject",
        compensates_for: userALogId,
      })
      .select("id")
      .single();

    // RLS blocks insert with mismatched user_id — either error or empty result
    const blocked = insertErr !== null || inserted === null;
    expect(blocked).toBe(true);

    // Verify: User A still sees no compensation entry for their log
    const { data: comps } = await userA.client
      .from("activity_log")
      .select("id")
      .eq("compensates_for", userALogId);
    expect(comps).toHaveLength(0);
  });
});
