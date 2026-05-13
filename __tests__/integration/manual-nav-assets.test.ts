import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration tests for migration 015: manual NAV-priced stock assets.
 *
 * Verifies:
 *   - `stock_assets.kind` accepts 'yahoo' (default) and 'manual'; rejects others
 *   - `asset_category` enum accepts 'private_equity'
 *   - `manual_nav_updates` row insert/select works for the owning user
 *   - RLS isolates `manual_nav_updates` between users (other-user rows invisible)
 *   - UNIQUE (asset_id, effective_date) prevents duplicate NAV per day
 *   - CHECK (nav > 0) rejects non-positive NAVs
 *   - ON DELETE CASCADE on asset deletion removes the NAV history
 */
describe("manual NAV assets — migration 015 (integration)", () => {
  let clientA: SupabaseClient;
  let userIdA: string;
  let cleanupA: () => void;
  let clientB: SupabaseClient;
  let cleanupB: () => void;

  beforeAll(async () => {
    const a = await createTestUser();
    clientA = a.client;
    userIdA = a.userId;
    cleanupA = a.cleanup;
    const b = await createTestUser();
    clientB = b.client;
    cleanupB = b.cleanup;
  });

  afterAll(() => {
    cleanupA();
    cleanupB();
  });

  it("creates a kind='manual' stock_asset with category='private_equity'", async () => {
    const { data, error } = await clientA
      .from("stock_assets")
      .insert({
        user_id: userIdA,
        ticker: "ENXF",
        name: "EQT Nexus ELTIF",
        currency: "EUR",
        kind: "manual",
        category: "private_equity",
      })
      .select("id, kind, category, yahoo_ticker")
      .single();
    expect(error).toBeNull();
    expect(data!.kind).toBe("manual");
    expect(data!.category).toBe("private_equity");
    expect(data!.yahoo_ticker).toBeNull();
  });

  it("rejects invalid kind values (CHECK constraint)", async () => {
    const { error } = await clientA.from("stock_assets").insert({
      user_id: userIdA,
      ticker: "BADKIND",
      name: "Test",
      currency: "USD",
      kind: "frobnicated", // not in ('yahoo', 'manual')
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/check|kind/i);
  });

  it("inserts manual_nav_updates and reads them back", async () => {
    // First create a manual asset for the user
    const { data: asset } = await clientA
      .from("stock_assets")
      .insert({
        user_id: userIdA,
        ticker: "NAV1",
        name: "Test NAV Asset",
        currency: "USD",
        kind: "manual",
      })
      .select("id")
      .single();
    const assetId = asset!.id;

    // Insert two NAV updates
    const { error: e1 } = await clientA.from("manual_nav_updates").insert([
      { user_id: userIdA, asset_id: assetId, effective_date: "2026-01-01", nav: 100.5, note: "Q4 2025 letter" },
      { user_id: userIdA, asset_id: assetId, effective_date: "2026-04-01", nav: 105.25, note: "Q1 2026 letter" },
    ]);
    expect(e1).toBeNull();

    const { data: navs, error: e2 } = await clientA
      .from("manual_nav_updates")
      .select("effective_date, nav, note")
      .eq("asset_id", assetId)
      .order("effective_date", { ascending: true });
    expect(e2).toBeNull();
    expect(navs).toHaveLength(2);
    expect(navs![0]).toMatchObject({ effective_date: "2026-01-01", nav: 100.5, note: "Q4 2025 letter" });
    expect(navs![1]).toMatchObject({ effective_date: "2026-04-01", nav: 105.25, note: "Q1 2026 letter" });
  });

  it("UNIQUE (asset_id, effective_date) rejects duplicate NAVs on same day", async () => {
    const { data: asset } = await clientA
      .from("stock_assets")
      .insert({
        user_id: userIdA,
        ticker: "DUP",
        name: "Dup Test",
        currency: "USD",
        kind: "manual",
      })
      .select("id")
      .single();
    const assetId = asset!.id;

    await clientA.from("manual_nav_updates").insert({
      user_id: userIdA,
      asset_id: assetId,
      effective_date: "2026-03-01",
      nav: 50,
    });
    const { error } = await clientA.from("manual_nav_updates").insert({
      user_id: userIdA,
      asset_id: assetId,
      effective_date: "2026-03-01",
      nav: 51,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23505"); // unique_violation
  });

  it("CHECK (nav > 0) rejects non-positive NAV", async () => {
    const { data: asset } = await clientA
      .from("stock_assets")
      .insert({
        user_id: userIdA,
        ticker: "CHK",
        name: "Check Test",
        currency: "USD",
        kind: "manual",
      })
      .select("id")
      .single();
    const assetId = asset!.id;

    const { error: zero } = await clientA.from("manual_nav_updates").insert({
      user_id: userIdA,
      asset_id: assetId,
      effective_date: "2026-05-01",
      nav: 0,
    });
    expect(zero).not.toBeNull();
    expect(zero!.message).toMatch(/check|nav/i);

    const { error: neg } = await clientA.from("manual_nav_updates").insert({
      user_id: userIdA,
      asset_id: assetId,
      effective_date: "2026-05-02",
      nav: -1,
    });
    expect(neg).not.toBeNull();
  });

  it("RLS isolates manual_nav_updates between users", async () => {
    // User A creates an asset + NAV
    const { data: asset } = await clientA
      .from("stock_assets")
      .insert({
        user_id: userIdA,
        ticker: "RLS",
        name: "RLS Test",
        currency: "USD",
        kind: "manual",
      })
      .select("id")
      .single();
    const assetIdA = asset!.id;
    await clientA.from("manual_nav_updates").insert({
      user_id: userIdA,
      asset_id: assetIdA,
      effective_date: "2026-06-01",
      nav: 200,
    });

    // User B cannot see User A's NAV
    const { data: bSeesA } = await clientB
      .from("manual_nav_updates")
      .select("id")
      .eq("asset_id", assetIdA);
    expect(bSeesA).toEqual([]);

    // User B cannot INSERT a NAV with user_id=A (RLS WITH CHECK blocks it)
    const { error: forge } = await clientB.from("manual_nav_updates").insert({
      user_id: userIdA, // forging user_id
      asset_id: assetIdA,
      effective_date: "2026-06-02",
      nav: 300,
    });
    expect(forge).not.toBeNull();
  });

  it("ON DELETE CASCADE removes NAV history when stock_asset is hard-deleted", async () => {
    const { data: asset } = await clientA
      .from("stock_assets")
      .insert({
        user_id: userIdA,
        ticker: "CAS",
        name: "Cascade Test",
        currency: "USD",
        kind: "manual",
      })
      .select("id")
      .single();
    const assetId = asset!.id;
    await clientA.from("manual_nav_updates").insert([
      { user_id: userIdA, asset_id: assetId, effective_date: "2026-07-01", nav: 10 },
      { user_id: userIdA, asset_id: assetId, effective_date: "2026-07-02", nav: 11 },
    ]);

    // Hard-delete the asset (not soft-delete via deleted_at)
    await clientA.from("stock_assets").delete().eq("id", assetId);

    const { data: orphans } = await clientA
      .from("manual_nav_updates")
      .select("id")
      .eq("asset_id", assetId);
    expect(orphans).toEqual([]);
  });
});
