import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser, getAdminClient } from "./setup";
import {
  getAssetTransactions,
  getAllAssetTransactions,
  fetchTransferCounterparts,
  toTransactionDisplayRows,
} from "@/lib/portfolio/asset-transactions";

/**
 * Integration tests for Task 2.4a — getAssetTransactions (the asset-scoped read).
 *
 * Runs the real read against local Supabase (Docker), via the RLS-scoped client
 * returned by createTestUser. getAssetTransactions takes the client as its first
 * argument (the dual-client contract), so nothing is mocked here — we drive it
 * against a real database with real RLS.
 *
 * Coverage:
 *   1. Cross-wallet merge — one asset in two positions → a single merged stream.
 *   2. Undone-split handling — undone parent excluded, children included; AND the
 *      de-dup defense for a LIVE parent with live children.
 *   3. Ownership isolation (#97) — userA cannot read userB's asset transactions.
 *   4. Cash path — a cash account's rows return; a foreign accountId returns [].
 *   5. Both value columns selected — delta_* present on a transfer/adjustment leg.
 *   6. Admin-client explicit-userId scoping — the service-role (admin) client
 *      bypasses RLS, so only the module's own .eq("user_id") / join-filter guards
 *      prevent cross-user leaks. This test exercises THAT defense.
 *
 * No mocks: the read is exercised against real DB clients.
 */

// Cast helper for activity_log inserts — the test client is an untyped
// SupabaseClient, so a plain object insert is type-checked structurally.
type ActivityInsert = {
  user_id: string;
  action: "created" | "updated" | "removed";
  entity_type: string;
  entity_name: string;
  description: string;
  entity_id?: string | null;
  is_yield?: boolean;
  is_adjustment?: boolean;
  transfer_group_id?: string | null;
  split_from_id?: string | null;
  cashflow_amount_usd?: number | null;
  cashflow_amount_eur?: number | null;
  delta_usd?: number | null;
  delta_eur?: number | null;
  before_snapshot?: Record<string, unknown> | null;
  after_snapshot?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
  effective_date?: string | null;
  undone_at?: string | null;
};

async function insertActivity(
  client: SupabaseClient,
  row: ActivityInsert,
): Promise<string> {
  const { data, error } = await client
    .from("activity_log")
    .insert(row)
    .select("id")
    .single();
  if (error) throw new Error(`insert activity_log failed: ${error.message}`);
  return data!.id as string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Cross-wallet merge
// ─────────────────────────────────────────────────────────────────────────────

describe("getAssetTransactions — cross-wallet merge (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  let cryptoAssetId: string;
  let positionAId: string;
  let positionBId: string;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;

    // One crypto asset.
    const { data: asset, error: assetErr } = await client
      .from("crypto_assets")
      .insert({
        user_id: userId,
        name: "MergeCoin",
        ticker: "MRG",
        coingecko_id: `mergecoin-${randomUUID()}`,
      })
      .select("id")
      .single();
    if (assetErr) throw new Error("asset: " + assetErr.message);
    cryptoAssetId = asset!.id;

    // Two wallets → two positions, both for the SAME asset.
    const { data: walletA } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Wallet A", wallet_type: "custodial" })
      .select("id")
      .single();
    const { data: walletB } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Wallet B", wallet_type: "non_custodial" })
      .select("id")
      .single();

    const { data: posA } = await client
      .from("crypto_positions")
      .insert({ crypto_asset_id: cryptoAssetId, wallet_id: walletA!.id, quantity: 1 })
      .select("id")
      .single();
    const { data: posB } = await client
      .from("crypto_positions")
      .insert({ crypto_asset_id: cryptoAssetId, wallet_id: walletB!.id, quantity: 2 })
      .select("id")
      .single();
    positionAId = posA!.id;
    positionBId = posB!.id;

    // Activity rows under BOTH positions.
    await insertActivity(client, {
      user_id: userId,
      action: "created",
      entity_type: "crypto_position",
      entity_name: "MergeCoin (A)",
      description: "Buy in wallet A",
      entity_id: positionAId,
      before_snapshot: null,
      after_snapshot: { quantity: 1 },
      cashflow_amount_usd: 1000,
      cashflow_amount_eur: 910,
      effective_date: "2026-01-01",
    });
    await insertActivity(client, {
      user_id: userId,
      action: "created",
      entity_type: "crypto_position",
      entity_name: "MergeCoin (B)",
      description: "Buy in wallet B",
      entity_id: positionBId,
      before_snapshot: null,
      after_snapshot: { quantity: 2 },
      cashflow_amount_usd: 2000,
      cashflow_amount_eur: 1820,
      effective_date: "2026-01-02",
    });
  });

  afterAll(() => cleanup());

  it("merges activity from both positions of the same asset into one stream", async () => {
    const rows = await getAssetTransactions(client, userId, {
      class: "crypto",
      assetId: cryptoAssetId,
    });

    expect(rows).toHaveLength(2);
    const entityIds = new Set(rows.map((r) => r.entity_id));
    expect(entityIds.has(positionAId)).toBe(true);
    expect(entityIds.has(positionBId)).toBe(true);
    // Sorted ascending by effective_date.
    expect(rows[0].effective_date).toBe("2026-01-01");
    expect(rows[1].effective_date).toBe("2026-01-02");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Undone-split handling + de-dup defense
// ─────────────────────────────────────────────────────────────────────────────

describe("getAssetTransactions — undone-split handling (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  let cryptoAssetId: string;
  let positionId: string;

  // Suite A: undone parent + live children.
  let undoneParentId: string;
  let childAId: string;
  let childBId: string;

  // Suite B (de-dup defense): live parent + live children.
  let liveParentId: string;
  let liveChildId: string;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;

    const { data: asset } = await client
      .from("crypto_assets")
      .insert({
        user_id: userId,
        name: "SplitCoin",
        ticker: "SPL",
        coingecko_id: `splitcoin-${randomUUID()}`,
      })
      .select("id")
      .single();
    cryptoAssetId = asset!.id;

    const { data: wallet } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Split Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    const { data: pos } = await client
      .from("crypto_positions")
      .insert({ crypto_asset_id: cryptoAssetId, wallet_id: wallet!.id, quantity: 10 })
      .select("id")
      .single();
    positionId = pos!.id;

    // ── Suite A: undone parent with two live children ──
    undoneParentId = await insertActivity(client, {
      user_id: userId,
      action: "created",
      entity_type: "crypto_position",
      entity_name: "SplitCoin (parent)",
      description: "Original buy (to be split)",
      entity_id: positionId,
      before_snapshot: null,
      after_snapshot: { quantity: 10 },
      effective_date: "2026-02-01",
    });
    childAId = await insertActivity(client, {
      user_id: userId,
      action: "created",
      entity_type: "crypto_position",
      entity_name: "SplitCoin (child A)",
      description: "Split child A",
      entity_id: positionId,
      split_from_id: undoneParentId,
      details: { split_quantity: 6, split_direction: 1 },
      effective_date: "2026-01-15",
    });
    childBId = await insertActivity(client, {
      user_id: userId,
      action: "created",
      entity_type: "crypto_position",
      entity_name: "SplitCoin (child B)",
      description: "Split child B",
      entity_id: positionId,
      split_from_id: undoneParentId,
      details: { split_quantity: 4, split_direction: 1 },
      effective_date: "2026-02-01",
    });
    // Mark the parent undone AFTER inserting children (mirrors the real split flow).
    const { error: undoErr } = await client
      .from("activity_log")
      .update({ undone_at: new Date().toISOString() })
      .eq("id", undoneParentId);
    if (undoErr) throw new Error("undo parent: " + undoErr.message);

    // ── Suite B: LIVE parent (undone_at NULL) with a live child — de-dup defense ──
    liveParentId = await insertActivity(client, {
      user_id: userId,
      action: "created",
      entity_type: "crypto_position",
      entity_name: "SplitCoin (live parent)",
      description: "Live parent — crashed mid-split",
      entity_id: positionId,
      before_snapshot: null,
      after_snapshot: { quantity: 3 },
      effective_date: "2026-03-01",
    });
    liveChildId = await insertActivity(client, {
      user_id: userId,
      action: "created",
      entity_type: "crypto_position",
      entity_name: "SplitCoin (live child)",
      description: "Live child of live parent",
      entity_id: positionId,
      split_from_id: liveParentId,
      details: { split_quantity: 3, split_direction: 1 },
      effective_date: "2026-03-01",
    });
  });

  afterAll(() => cleanup());

  it("excludes the undone parent and includes its live children", async () => {
    const rows = await getAssetTransactions(client, userId, {
      class: "crypto",
      assetId: cryptoAssetId,
    });
    const ids = new Set(rows.map((r) => r.id));

    // Undone parent excluded.
    expect(ids.has(undoneParentId)).toBe(false);
    // Both live children present.
    expect(ids.has(childAId)).toBe(true);
    expect(ids.has(childBId)).toBe(true);
  });

  it("de-dups a LIVE parent when its live children are present (split-orphan defense)", async () => {
    const rows = await getAssetTransactions(client, userId, {
      class: "crypto",
      assetId: cryptoAssetId,
    });
    const ids = new Set(rows.map((r) => r.id));

    // The live parent is referenced as split_from_id by liveChild → dropped.
    expect(ids.has(liveParentId)).toBe(false);
    // The child remains.
    expect(ids.has(liveChildId)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Ownership isolation (#97)
// ─────────────────────────────────────────────────────────────────────────────

describe("getAssetTransactions — ownership isolation (integration)", () => {
  let userA: { client: SupabaseClient; userId: string; cleanup: () => void };
  let userB: { client: SupabaseClient; userId: string; cleanup: () => void };
  let userBAssetId: string;
  let userBPositionId: string;

  beforeAll(async () => {
    userA = await createTestUser();
    userB = await createTestUser();

    // userB owns a crypto asset + position + activity.
    const { data: asset } = await userB.client
      .from("crypto_assets")
      .insert({
        user_id: userB.userId,
        name: "PrivateCoin",
        ticker: "PRV",
        coingecko_id: `privatecoin-${randomUUID()}`,
      })
      .select("id")
      .single();
    userBAssetId = asset!.id;

    const { data: wallet } = await userB.client
      .from("wallets")
      .insert({ user_id: userB.userId, name: "B Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    const { data: pos } = await userB.client
      .from("crypto_positions")
      .insert({ crypto_asset_id: userBAssetId, wallet_id: wallet!.id, quantity: 5 })
      .select("id")
      .single();
    userBPositionId = pos!.id;

    await insertActivity(userB.client, {
      user_id: userB.userId,
      action: "created",
      entity_type: "crypto_position",
      entity_name: "PrivateCoin",
      description: "userB private buy",
      entity_id: userBPositionId,
      after_snapshot: { quantity: 5 },
      effective_date: "2026-01-01",
    });
  });

  afterAll(() => {
    userA.cleanup();
    userB.cleanup();
  });

  it("userA reading userB's asset returns [] (no cross-user leak)", async () => {
    const rows = await getAssetTransactions(userA.client, userA.userId, {
      class: "crypto",
      assetId: userBAssetId,
    });
    expect(rows).toEqual([]);
  });

  it("userB reading their own asset returns their rows (control)", async () => {
    const rows = await getAssetTransactions(userB.client, userB.userId, {
      class: "crypto",
      assetId: userBAssetId,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.entity_id === userBPositionId)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cash path
// ─────────────────────────────────────────────────────────────────────────────

describe("getAssetTransactions — cash path (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  let cashAccountId: string;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;

    const { data: inst } = await client
      .from("institutions")
      .insert({ user_id: userId, name: "Test Bank" })
      .select("id")
      .single();

    const { data: account } = await client
      .from("cash_accounts")
      .insert({
        user_id: userId,
        institution_id: inst!.id,
        name: "Savings",
        currency: "EUR",
        balance: 1000,
      })
      .select("id")
      .single();
    cashAccountId = account!.id;

    await insertActivity(client, {
      user_id: userId,
      action: "created",
      entity_type: "cash_account",
      entity_name: "Savings",
      description: "Open savings account",
      entity_id: cashAccountId,
      before_snapshot: null,
      after_snapshot: { balance: 1000 },
      cashflow_amount_usd: 1100,
      cashflow_amount_eur: 1000,
      effective_date: "2026-01-05",
    });
  });

  afterAll(() => cleanup());

  it("returns a cash account's activity rows (account id IS the entity_id)", async () => {
    const rows = await getAssetTransactions(client, userId, {
      class: "cash",
      accountId: cashAccountId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_id).toBe(cashAccountId);
    expect(rows[0].entity_type).toBe("cash_account");
  });

  it("returns [] for a foreign / non-existent accountId", async () => {
    const rows = await getAssetTransactions(client, userId, {
      class: "cash",
      accountId: randomUUID(), // belongs to nobody
    });
    expect(rows).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Both value columns selected (delta on transfer/adjustment legs)
// ─────────────────────────────────────────────────────────────────────────────

describe("getAssetTransactions — value-column coverage (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  let cryptoAssetId: string;
  let positionId: string;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;

    const { data: asset } = await client
      .from("crypto_assets")
      .insert({
        user_id: userId,
        name: "ColCoin",
        ticker: "COL",
        coingecko_id: `colcoin-${randomUUID()}`,
      })
      .select("id")
      .single();
    cryptoAssetId = asset!.id;

    const { data: wallet } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Col Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    const { data: pos } = await client
      .from("crypto_positions")
      .insert({ crypto_asset_id: cryptoAssetId, wallet_id: wallet!.id, quantity: 1 })
      .select("id")
      .single();
    positionId = pos!.id;

    // A normal buy: cashflow_* populated, delta_* null.
    await insertActivity(client, {
      user_id: userId,
      action: "created",
      entity_type: "crypto_position",
      entity_name: "ColCoin (buy)",
      description: "Real buy",
      entity_id: positionId,
      after_snapshot: { quantity: 1 },
      cashflow_amount_usd: 1000,
      cashflow_amount_eur: 910,
      effective_date: "2026-01-01",
    });

    // A transfer/adjustment leg: delta_* populated, cashflow_* null.
    await insertActivity(client, {
      user_id: userId,
      action: "updated",
      entity_type: "crypto_position",
      entity_name: "ColCoin (transfer leg)",
      description: "Transfer leg",
      entity_id: positionId,
      is_adjustment: true,
      transfer_group_id: randomUUID(),
      before_snapshot: { quantity: 1 },
      after_snapshot: { quantity: 0.5 },
      delta_usd: -500,
      delta_eur: -450,
      effective_date: "2026-01-10",
    });
  });

  afterAll(() => cleanup());

  it("selects both cashflow_* and delta_* columns; transfer leg has delta set, cashflow null", async () => {
    const rows = await getAssetTransactions(client, userId, {
      class: "crypto",
      assetId: cryptoAssetId,
    });
    expect(rows).toHaveLength(2);

    const buy = rows.find((r) => r.cashflow_amount_usd != null);
    const leg = rows.find((r) => r.delta_usd != null);

    expect(buy).toBeDefined();
    expect(leg).toBeDefined();

    // The buy carries cashflow, no delta.
    expect(buy!.cashflow_amount_usd).toBe(1000);
    expect(buy!.cashflow_amount_eur).toBe(910);
    expect(buy!.delta_usd).toBeNull();

    // The transfer leg carries delta, no cashflow.
    expect(leg!.delta_usd).toBe(-500);
    expect(leg!.delta_eur).toBe(-450);
    expect(leg!.cashflow_amount_usd).toBeNull();
    expect(leg!.transfer_group_id).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Admin-client explicit-userId scoping
//
// The admin (service-role) client bypasses RLS entirely. The module's real
// cross-user isolation guarantee comes from its own explicit .eq("user_id", …)
// and .eq("crypto_assets.user_id", …) filters — not from RLS. This test
// exercises THAT defense: with RLS OFF, only the module's scoping prevents
// a cross-user read.
// ─────────────────────────────────────────────────────────────────────────────

describe("getAssetTransactions — admin-client explicit-userId scoping (integration)", () => {
  let userA: { client: SupabaseClient; userId: string; cleanup: () => void };
  let userB: { client: SupabaseClient; userId: string; cleanup: () => void };
  let adminClient: SupabaseClient;

  let userBAssetId: string;
  let userBPositionId: string;

  beforeAll(async () => {
    userA = await createTestUser();
    userB = await createTestUser();
    adminClient = getAdminClient();

    // userB owns a crypto asset + position + one activity row.
    const { data: asset, error: assetErr } = await userB.client
      .from("crypto_assets")
      .insert({
        user_id: userB.userId,
        name: "AdminTestCoin",
        ticker: "ADM",
        coingecko_id: `admincoin-${randomUUID()}`,
      })
      .select("id")
      .single();
    if (assetErr) throw new Error("asset: " + assetErr.message);
    userBAssetId = asset!.id;

    const { data: wallet, error: walletErr } = await userB.client
      .from("wallets")
      .insert({ user_id: userB.userId, name: "Admin Test Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (walletErr) throw new Error("wallet: " + walletErr.message);

    const { data: pos, error: posErr } = await userB.client
      .from("crypto_positions")
      .insert({ crypto_asset_id: userBAssetId, wallet_id: wallet!.id, quantity: 7 })
      .select("id")
      .single();
    if (posErr) throw new Error("position: " + posErr.message);
    userBPositionId = pos!.id;

    await insertActivity(userB.client, {
      user_id: userB.userId,
      action: "created",
      entity_type: "crypto_position",
      entity_name: "AdminTestCoin",
      description: "userB admin-test buy",
      entity_id: userBPositionId,
      after_snapshot: { quantity: 7 },
      cashflow_amount_usd: 700,
      cashflow_amount_eur: 637,
      effective_date: "2026-01-01",
    });
  });

  afterAll(() => {
    userA.cleanup();
    userB.cleanup();
  });

  it("admin client + userA.userId reading userB's asset returns [] (explicit-userId blocks cross-user leak with RLS OFF)", async () => {
    // RLS is bypassed by the admin client. The [] result comes ONLY from the
    // module's own .eq("crypto_assets.user_id", userId) and .eq("user_id", userId)
    // filters scoping to userA, who owns no part of userBAssetId.
    const rows = await getAssetTransactions(adminClient, userA.userId, {
      class: "crypto",
      assetId: userBAssetId,
    });
    expect(rows).toEqual([]);
  });

  it("admin client + userB.userId reading userB's own asset returns their rows (positive control — admin path works for legitimate owner)", async () => {
    // This is exactly the share-page path: admin client + owner's userId.
    // A fix that "passes" by always returning [] would fail here.
    const rows = await getAssetTransactions(adminClient, userB.userId, {
      class: "crypto",
      assetId: userBAssetId,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.entity_id === userBPositionId)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. getAllAssetTransactions (Task 3.3a — the bulk read)
//
// The bulk read must return, per asset, EXACTLY what getAssetTransactions returns
// for that asset (parity), enforce ownership with the admin client + explicit
// userId scope (#97), and skip activity rows whose position was hard-deleted
// (orphans) without throwing.
// ─────────────────────────────────────────────────────────────────────────────

describe("getAllAssetTransactions — parity with getAssetTransactions (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  let cryptoAssetId: string;
  let positionAId: string;
  let positionBId: string;
  let cashAccountId: string;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;

    // A 2-wallet crypto asset (so the merge path is exercised in the bulk read).
    const { data: asset } = await client
      .from("crypto_assets")
      .insert({
        user_id: userId,
        name: "BulkCoin",
        ticker: "BLK",
        coingecko_id: `bulkcoin-${randomUUID()}`,
      })
      .select("id")
      .single();
    cryptoAssetId = asset!.id;

    const { data: walletA } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Bulk Wallet A", wallet_type: "custodial" })
      .select("id")
      .single();
    const { data: walletB } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Bulk Wallet B", wallet_type: "non_custodial" })
      .select("id")
      .single();
    const { data: posA } = await client
      .from("crypto_positions")
      .insert({ crypto_asset_id: cryptoAssetId, wallet_id: walletA!.id, quantity: 1 })
      .select("id")
      .single();
    const { data: posB } = await client
      .from("crypto_positions")
      .insert({ crypto_asset_id: cryptoAssetId, wallet_id: walletB!.id, quantity: 2 })
      .select("id")
      .single();
    positionAId = posA!.id;
    positionBId = posB!.id;

    await insertActivity(client, {
      user_id: userId,
      action: "created",
      entity_type: "crypto_position",
      entity_name: "BulkCoin (A)",
      description: "Buy A",
      entity_id: positionAId,
      after_snapshot: { quantity: 1 },
      cashflow_amount_usd: 1000,
      cashflow_amount_eur: 910,
      effective_date: "2026-01-01",
    });
    await insertActivity(client, {
      user_id: userId,
      action: "created",
      entity_type: "crypto_position",
      entity_name: "BulkCoin (B)",
      description: "Buy B",
      entity_id: positionBId,
      after_snapshot: { quantity: 2 },
      cashflow_amount_usd: 2000,
      cashflow_amount_eur: 1820,
      effective_date: "2026-01-02",
    });

    // A cash account with one row (so the cash key path is exercised too).
    const { data: inst } = await client
      .from("institutions")
      .insert({ user_id: userId, name: "Bulk Bank" })
      .select("id")
      .single();
    const { data: account } = await client
      .from("cash_accounts")
      .insert({
        user_id: userId,
        institution_id: inst!.id,
        name: "Bulk Savings",
        currency: "EUR",
        balance: 5000,
      })
      .select("id")
      .single();
    cashAccountId = account!.id;
    await insertActivity(client, {
      user_id: userId,
      action: "created",
      entity_type: "cash_account",
      entity_name: "Bulk Savings",
      description: "Open",
      entity_id: cashAccountId,
      after_snapshot: { balance: 5000 },
      cashflow_amount_usd: 5500,
      cashflow_amount_eur: 5000,
      effective_date: "2026-01-03",
    });
  });

  afterAll(() => cleanup());

  it("returns, per asset, the same rows getAssetTransactions returns (crypto + cash)", async () => {
    const all = await getAllAssetTransactions(client, userId);

    const cryptoKey = `crypto:${cryptoAssetId}` as const;
    const cashKey = `cash:${cashAccountId}` as const;

    const single = await getAssetTransactions(client, userId, {
      class: "crypto",
      assetId: cryptoAssetId,
    });
    const singleCash = await getAssetTransactions(client, userId, {
      class: "cash",
      accountId: cashAccountId,
    });

    // Parity: identical id sequence (proves same de-dup + same stable sort).
    expect(all.get(cryptoKey)?.map((r) => r.id)).toEqual(single.map((r) => r.id));
    expect(all.get(cashKey)?.map((r) => r.id)).toEqual(singleCash.map((r) => r.id));

    // The crypto stream merged both wallets.
    const cryptoEntityIds = new Set(all.get(cryptoKey)?.map((r) => r.entity_id));
    expect(cryptoEntityIds.has(positionAId)).toBe(true);
    expect(cryptoEntityIds.has(positionBId)).toBe(true);
  });
});

describe("getAllAssetTransactions — ownership isolation via admin client (integration)", () => {
  let userA: { client: SupabaseClient; userId: string; cleanup: () => void };
  let userB: { client: SupabaseClient; userId: string; cleanup: () => void };
  let adminClient: SupabaseClient;
  let userBAssetId: string;

  beforeAll(async () => {
    userA = await createTestUser();
    userB = await createTestUser();
    adminClient = getAdminClient();

    const { data: asset } = await userB.client
      .from("crypto_assets")
      .insert({
        user_id: userB.userId,
        name: "BulkPrivateCoin",
        ticker: "BPV",
        coingecko_id: `bulkprivate-${randomUUID()}`,
      })
      .select("id")
      .single();
    userBAssetId = asset!.id;

    const { data: wallet } = await userB.client
      .from("wallets")
      .insert({ user_id: userB.userId, name: "BPV Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    const { data: pos } = await userB.client
      .from("crypto_positions")
      .insert({ crypto_asset_id: userBAssetId, wallet_id: wallet!.id, quantity: 5 })
      .select("id")
      .single();

    await insertActivity(userB.client, {
      user_id: userB.userId,
      action: "created",
      entity_type: "crypto_position",
      entity_name: "BulkPrivateCoin",
      description: "userB buy",
      entity_id: pos!.id,
      after_snapshot: { quantity: 5 },
      cashflow_amount_usd: 500,
      cashflow_amount_eur: 455,
      effective_date: "2026-01-01",
    });
  });

  afterAll(() => {
    userA.cleanup();
    userB.cleanup();
  });

  it("admin client + userA scope sees NONE of userB's assets (RLS bypassed; only explicit scope guards)", async () => {
    const all = await getAllAssetTransactions(adminClient, userA.userId);
    // userA owns nothing → userB's asset key must be absent entirely.
    expect(all.has(`crypto:${userBAssetId}` as const)).toBe(false);
    expect(all.size).toBe(0);
  });

  it("admin client + userB scope sees userB's asset (positive control — share-page path)", async () => {
    const all = await getAllAssetTransactions(adminClient, userB.userId);
    expect(all.has(`crypto:${userBAssetId}` as const)).toBe(true);
    expect(all.get(`crypto:${userBAssetId}` as const)!.length).toBeGreaterThan(0);
  });
});

describe("getAllAssetTransactions — orphan rows skipped without throwing (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;
  let adminClient: SupabaseClient;

  let cryptoAssetId: string;
  let livePositionId: string;
  let orphanPositionId: string;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    adminClient = getAdminClient();

    const { data: asset } = await client
      .from("crypto_assets")
      .insert({
        user_id: userId,
        name: "OrphanCoin",
        ticker: "ORP",
        coingecko_id: `orphancoin-${randomUUID()}`,
      })
      .select("id")
      .single();
    cryptoAssetId = asset!.id;

    // Two wallets — the UNIQUE(crypto_asset_id, wallet_id) WHERE deleted_at IS
    // NULL index forbids two live positions of one asset in the same wallet.
    const { data: walletLive } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Orphan Live Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    const { data: walletOrphan } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Orphan Dead Wallet", wallet_type: "non_custodial" })
      .select("id")
      .single();

    // A live position with a normal row.
    const { data: livePos } = await client
      .from("crypto_positions")
      .insert({ crypto_asset_id: cryptoAssetId, wallet_id: walletLive!.id, quantity: 1 })
      .select("id")
      .single();
    livePositionId = livePos!.id;
    await insertActivity(client, {
      user_id: userId,
      action: "created",
      entity_type: "crypto_position",
      entity_name: "OrphanCoin (live)",
      description: "Live buy",
      entity_id: livePositionId,
      after_snapshot: { quantity: 1 },
      cashflow_amount_usd: 1000,
      cashflow_amount_eur: 910,
      effective_date: "2026-01-01",
    });

    // A second position we will HARD-delete after writing its activity row,
    // leaving the activity row pointing at a position absent from the meta map.
    const { data: orphanPos } = await client
      .from("crypto_positions")
      .insert({ crypto_asset_id: cryptoAssetId, wallet_id: walletOrphan!.id, quantity: 9 })
      .select("id")
      .single();
    orphanPositionId = orphanPos!.id;
    await insertActivity(client, {
      user_id: userId,
      action: "created",
      entity_type: "crypto_position",
      entity_name: "OrphanCoin (to-be-orphaned)",
      description: "Orphan buy",
      entity_id: orphanPositionId,
      after_snapshot: { quantity: 9 },
      cashflow_amount_usd: 9000,
      cashflow_amount_eur: 8190,
      effective_date: "2026-01-02",
    });

    // HARD delete (not soft) via admin client — the activity row survives but its
    // position is gone from crypto_positions, so the meta map won't resolve it.
    const { error: delErr } = await adminClient
      .from("crypto_positions")
      .delete()
      .eq("id", orphanPositionId);
    if (delErr) throw new Error("hard delete orphan position: " + delErr.message);
  });

  afterAll(() => cleanup());

  it("skips the orphaned row, keeps the live one, and does not throw", async () => {
    const all = await getAllAssetTransactions(client, userId);
    const rows = all.get(`crypto:${cryptoAssetId}` as const) ?? [];

    const ids = new Set(rows.map((r) => r.entity_id));
    // Live position's row present.
    expect(ids.has(livePositionId)).toBe(true);
    // Orphan position's row dropped (position no longer in the meta map).
    expect(ids.has(orphanPositionId)).toBe(false);
    expect(rows).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Transfer counterpart enrichment (C2b — sell/buy display role)
//
// A sell-type transfer is two legs sharing a transfer_group_id: the crypto
// position leg (qty DOWN, delta < 0) and the cash account leg (balance UP,
// delta > 0), both is_adjustment=true. The drawer pipeline (the exact path
// loadAssetTransactions runs) must label the POSITION leg "Sell (to {cash
// name})" via transferRole/counterpartName, while the CASH leg carries NO
// sell/buy role (the cash side stays a plain transfer by contract).
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchTransferCounterparts + toTransactionDisplayRows — sell-type leg (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  let cryptoAssetId: string;
  let positionId: string;
  let cashAccountId: string;
  const transferGroupId = randomUUID();

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;

    // Crypto asset + one position.
    const { data: asset } = await client
      .from("crypto_assets")
      .insert({
        user_id: userId,
        name: "SellCoin",
        ticker: "SEL",
        coingecko_id: `sellcoin-${randomUUID()}`,
      })
      .select("id")
      .single();
    cryptoAssetId = asset!.id;

    const { data: wallet } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Sell Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    const { data: pos } = await client
      .from("crypto_positions")
      .insert({ crypto_asset_id: cryptoAssetId, wallet_id: wallet!.id, quantity: 1 })
      .select("id")
      .single();
    positionId = pos!.id;

    // Cash account (the proceeds destination).
    const { data: inst } = await client
      .from("institutions")
      .insert({ user_id: userId, name: "Sell Bank" })
      .select("id")
      .single();
    const { data: account } = await client
      .from("cash_accounts")
      .insert({
        user_id: userId,
        institution_id: inst!.id,
        name: "Alpha Bank",
        currency: "EUR",
        balance: 1400,
      })
      .select("id")
      .single();
    cashAccountId = account!.id;

    // ── The sell-type transfer pair (shared transfer_group_id) ──
    // Position leg: qty 2 → 1 (DOWN), delta negative.
    await insertActivity(client, {
      user_id: userId,
      action: "updated",
      entity_type: "crypto_position",
      entity_name: "SellCoin",
      description: "Sell leg (to Alpha Bank)",
      entity_id: positionId,
      is_adjustment: true,
      transfer_group_id: transferGroupId,
      before_snapshot: { quantity: 2 },
      after_snapshot: { quantity: 1 },
      delta_usd: -1540,
      delta_eur: -1400,
      effective_date: "2026-05-15",
    });
    // Cash leg: balance 0 → 1400 (UP), delta positive.
    await insertActivity(client, {
      user_id: userId,
      action: "updated",
      entity_type: "cash_account",
      entity_name: "Alpha Bank",
      description: "Proceeds from SellCoin",
      entity_id: cashAccountId,
      is_adjustment: true,
      transfer_group_id: transferGroupId,
      before_snapshot: { balance: 0 },
      after_snapshot: { balance: 1400 },
      delta_usd: 1540,
      delta_eur: 1400,
      effective_date: "2026-05-15",
    });
  });

  afterAll(() => cleanup());

  it("the POSITION asset's leg is enriched with transferRole 'sell' + the cash account name", async () => {
    const raw = await getAssetTransactions(client, userId, {
      class: "crypto",
      assetId: cryptoAssetId,
    });
    const counterparts = await fetchTransferCounterparts(client, userId, raw);
    const display = toTransactionDisplayRows(raw, "EUR", counterparts);

    expect(display).toHaveLength(1);
    const leg = display[0];
    // kind is unchanged (the engine/eligibility depend on it).
    expect(leg.kind).toBe("transfer");
    // …but the DISPLAY role + counterpart name are set.
    expect(leg.transferRole).toBe("sell");
    expect(leg.counterpartName).toBe("Alpha Bank");
  });

  it("the CASH account's leg carries NO sell/buy role (cash side stays a plain transfer)", async () => {
    const raw = await getAssetTransactions(client, userId, {
      class: "cash",
      accountId: cashAccountId,
    });
    const counterparts = await fetchTransferCounterparts(client, userId, raw);
    const display = toTransactionDisplayRows(raw, "EUR", counterparts);

    expect(display).toHaveLength(1);
    const leg = display[0];
    expect(leg.kind).toBe("transfer");
    expect(leg.transferRole).toBeUndefined();
    expect(leg.counterpartName).toBeUndefined();
  });
});
