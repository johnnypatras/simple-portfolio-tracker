import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration tests for migration 016 + manual NAV pricing wire-up.
 *
 * Verifies:
 *   - get_latest_manual_navs_at returns the latest NAV per asset at-or-before
 *     the queried date (step-function forward-fill semantics)
 *   - RLS isolates results between users when called from authenticated context
 *     (no p_user_id) — user A can't see user B's NAVs even via this function
 *   - The function handles assets with no NAV history (empty result, not error)
 *   - Multiple updates for the same asset return only the latest
 *   - Date filter respects the at-or-before semantics (no NAVs from after p_as_of)
 */
describe("manual NAV pricing — migration 016 (integration)", () => {
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

  it("returns latest NAV per asset at-or-before requested date", async () => {
    // Create a manual asset + 3 NAV entries on different dates
    const { data: asset } = await clientA
      .from("stock_assets")
      .insert({
        user_id: userIdA,
        ticker: "ENXF",
        name: "EQT Nexus ELTIF",
        currency: "EUR",
        kind: "manual",
        category: "private_equity",
      })
      .select("id")
      .single();
    const assetId = asset!.id;

    await clientA.from("manual_nav_updates").insert([
      { user_id: userIdA, asset_id: assetId, effective_date: "2026-01-01", nav: 100 },
      { user_id: userIdA, asset_id: assetId, effective_date: "2026-03-01", nav: 105 },
      { user_id: userIdA, asset_id: assetId, effective_date: "2026-06-01", nav: 110 },
    ]);

    // Query as-of mid-April: should get the 2026-03-01 entry (latest <= 2026-04-15)
    const { data: navs, error } = await clientA.rpc("get_latest_manual_navs_at", {
      p_as_of: "2026-04-15",
    });
    expect(error).toBeNull();
    expect(navs).toHaveLength(1);
    expect(navs![0].asset_id).toBe(assetId);
    expect(Number(navs![0].nav)).toBe(105);
    expect(navs![0].effective_date).toBe("2026-03-01");
  });

  it("returns no rows when as_of is before the first NAV", async () => {
    const { data: asset } = await clientA
      .from("stock_assets")
      .insert({
        user_id: userIdA,
        ticker: "EARLY",
        name: "Early ELTIF",
        currency: "USD",
        kind: "manual",
      })
      .select("id")
      .single();
    await clientA.from("manual_nav_updates").insert({
      user_id: userIdA,
      asset_id: asset!.id,
      effective_date: "2026-05-01",
      nav: 50,
    });

    const { data: navs } = await clientA.rpc("get_latest_manual_navs_at", {
      p_as_of: "2026-04-30",  // one day before first NAV
    });
    // The query returns all manual assets the user owns that have a NAV <= as_of.
    // This asset's only NAV is 2026-05-01, so it's excluded from result.
    const thisAsset = navs?.find((n: { asset_id: string }) => n.asset_id === asset!.id);
    expect(thisAsset).toBeUndefined();
  });

  it("RLS isolates the function — user B cannot see user A's NAVs", async () => {
    // User A's asset + NAV from earlier test is still in DB.
    // User B queries get_latest_manual_navs_at with no p_user_id (uses auth.uid()).
    const { data: navs, error } = await clientB.rpc("get_latest_manual_navs_at", {
      p_as_of: "2099-12-31",
    });
    expect(error).toBeNull();
    expect(navs).toEqual([]);  // RLS scopes to user B who has no manual assets
  });

  it("explicit p_user_id from an authenticated client still respects RLS", async () => {
    // User B passes user A's userId. RLS prevents B from seeing A's rows even
    // though the function's WHERE clause matches.
    const { data: navs } = await clientB.rpc("get_latest_manual_navs_at", {
      p_as_of: "2099-12-31",
      p_user_id: userIdA,
    });
    expect(navs).toEqual([]);  // RLS still blocks the underlying SELECT
  });

  it("handles assets with no NAV history (excluded from result)", async () => {
    // Create a manual asset with NO NAV history
    const { data: asset } = await clientA
      .from("stock_assets")
      .insert({
        user_id: userIdA,
        ticker: "PEND",
        name: "Pending NAV",
        currency: "USD",
        kind: "manual",
      })
      .select("id")
      .single();

    const { data: navs } = await clientA.rpc("get_latest_manual_navs_at", {
      p_as_of: "2099-12-31",
    });
    const thisAsset = navs?.find((n: { asset_id: string }) => n.asset_id === asset!.id);
    expect(thisAsset).toBeUndefined();
  });

  it("multiple manual assets — returns one latest NAV per asset", async () => {
    const tickers = ["MA1", "MA2", "MA3"];
    const assetIds: string[] = [];
    for (const t of tickers) {
      const { data: a } = await clientA
        .from("stock_assets")
        .insert({ user_id: userIdA, ticker: t, name: t, currency: "USD", kind: "manual" })
        .select("id")
        .single();
      assetIds.push(a!.id);
      // 2 NAVs per asset on different dates
      await clientA.from("manual_nav_updates").insert([
        { user_id: userIdA, asset_id: a!.id, effective_date: "2026-02-01", nav: 10 },
        { user_id: userIdA, asset_id: a!.id, effective_date: "2026-08-01", nav: 20 },
      ]);
    }

    const { data: navs } = await clientA.rpc("get_latest_manual_navs_at", {
      p_as_of: "2099-12-31",
    });
    // Filter to just our 3 test assets (other tests may have added more)
    const ours = navs!.filter((n: { asset_id: string }) => assetIds.includes(n.asset_id));
    expect(ours).toHaveLength(3);
    // Each should be the 2026-08-01 entry with nav=20
    for (const n of ours as Array<{ nav: number; effective_date: string }>) {
      expect(Number(n.nav)).toBe(20);
      expect(n.effective_date).toBe("2026-08-01");
    }
  });
});
